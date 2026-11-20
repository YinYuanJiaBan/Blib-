#!/usr/bin/env python3
"""
book2epub — собирает книгу с kanunu8.com (努努书坊) в EPUB,
при желании сразу переводя её с китайского на русский.

Используйте для произведений в общественном достоянии (классика:
鲁迅, 曹雪芹, 吴敬梓 и т. п.) или для текстов, на которые у вас есть права.

Примеры:
    python3 book2epub.py https://www.kanunu8.com/files/old/2011/2560.html
    python3 book2epub.py URL --translate            # только русский перевод
    python3 book2epub.py URL --translate --bilingual # китайский + русский
    python3 book2epub.py URL --limit 3 -o test.epub  # первые 3 главы

Зависимостей нет — только стандартная библиотека Python 3.8+.
"""
import argparse
import concurrent.futures as cf
import hashlib
import html
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
import uuid
import zipfile
from datetime import datetime, timezone
from html.parser import HTMLParser

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0 Safari/537.36")
TRANSLATE_URL = "https://translate.googleapis.com/translate_a/t"
HAN = re.compile(r"[㐀-䶿一-鿿豈-﫿]")


# ---------------------------------------------------------------- сеть
def fetch(url, data=None, retries=4, timeout=30):
    """GET/POST с повторами. Возвращает bytes."""
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, data=data, headers={"User-Agent": UA})
            if data is not None:
                req.add_header("Content-Type", "application/x-www-form-urlencoded;charset=UTF-8")
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"Не удалось загрузить {url}: {last}")


def decode(raw):
    m = re.search(rb'charset=["\']?([\w-]+)', raw[:2000], re.I)
    enc = (m.group(1).decode() if m else "gbk").lower()
    if enc in ("gb2312", "gbk", "gb18030"):
        enc = "gb18030"  # надмножество GBK, меньше «битых» иероглифов
    return raw.decode(enc, errors="replace")


class Cache:
    """Дисковый кэш: прерванную загрузку можно продолжить."""

    def __init__(self, root):
        self.root = root
        os.makedirs(root, exist_ok=True)

    def _path(self, key):
        return os.path.join(self.root, hashlib.sha1(key.encode()).hexdigest() + ".json")

    def get(self, key):
        try:
            with open(self._path(key), encoding="utf-8") as f:
                return json.load(f)
        except (OSError, ValueError):
            return None

    def put(self, key, value):
        with open(self._path(key), "w", encoding="utf-8") as f:
            json.dump(value, f, ensure_ascii=False)


# ---------------------------------------------------------------- разбор
class LinkParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.links, self._href, self._text = [], None, []

    def handle_starttag(self, tag, attrs):
        if tag == "a":
            self._href = dict(attrs).get("href")
            self._text = []

    def handle_data(self, d):
        if self._href is not None:
            self._text.append(d)

    def handle_endtag(self, tag):
        if tag == "a" and self._href is not None:
            self.links.append((self._href, "".join(self._text).strip()))
            self._href = None


def strip_tags(s):
    return html.unescape(re.sub(r"<[^>]+>", "", s)).replace("\xa0", " ").strip()


def parse_index(url, page):
    title = None
    for pat in (r"<h1[^>]*>(.*?)</h1>", r"<h2[^>]*>(.*?)</h2>"):
        m = re.search(pat, page, re.S | re.I)
        if m and strip_tags(m.group(1)):
            title = strip_tags(m.group(1))
            break
    page_title = strip_tags(re.search(r"<title>(.*?)</title>", page, re.S | re.I).group(1))
    if not title:
        title = re.split(r"\s*[-_]\s*|\s+by\s+", page_title)[0]

    author = ""
    for pat in (r"作者[：:]\s*([^<\s]+)", r"\bby\s+([^\s-]+)", r"-\s*小说[^-]*-\s*([^-]+?)\s*-"):
        m = re.search(pat, page if "作者" in pat else page_title)
        if m:
            author = strip_tags(m.group(1))
            break

    m = re.search(r'<meta name="description" content="([^"]*)"', page, re.I)
    description = html.unescape(m.group(1)).strip() if m else ""

    # Главы — относительные ссылки вида 12345.html или 2560/12345.html.
    # Ссылки на другие книги на сайте абсолютные (/book2/...), они отсекаются.
    lp = LinkParser()
    lp.feed(page)
    chapters, seen = [], set()
    for href, text in lp.links:
        if not href or href.startswith(("/", "http", "..", "#", "javascript")):
            continue
        if not re.fullmatch(r"(?:[\w-]+/)?\d+\.html", href):
            continue
        full = urllib.parse.urljoin(url, href)
        if full in seen:
            continue
        seen.add(full)
        chapters.append({"url": full, "title": text or f"Глава {len(chapters) + 1}"})
    return {"title": title, "author": author, "description": description, "chapters": chapters}


def parse_chapter(page):
    """Текст главы — первый крупный <p>…</p> на странице."""
    best = ""
    for m in re.finditer(r"<p[^>]*>(.*?)</p>", page, re.S | re.I):
        if len(m.group(1)) > len(best):
            best = m.group(1)
    if not best:
        return []
    text = re.sub(r"<br\s*/?>", "\n", best, flags=re.I)
    text = strip_tags(text)
    paras = [re.sub(r"^[\s　]+|[\s　]+$", "", p) for p in text.split("\n")]
    return [p for p in paras if p]


# ---------------------------------------------------------------- перевод
class Translator:
    def __init__(self, cache, src="zh-CN", dst="ru", workers=3):
        self.cache, self.src, self.dst, self.workers = cache, src, dst, workers

    def _batch(self, texts):
        url = f"{TRANSLATE_URL}?client=gtx&sl={self.src}&tl={self.dst}&format=text"
        body = urllib.parse.urlencode([("q", t) for t in texts]).encode()
        data = json.loads(fetch(url, data=body).decode("utf-8"))
        out = [x[0] if isinstance(x, list) else x for x in data]
        if len(out) != len(texts):
            raise RuntimeError("переводчик вернул неожиданное число строк")
        return out

    def translate(self, paras, max_chars=4500, max_items=80):
        key = "tr:" + self.dst + ":" + hashlib.sha1("\n".join(paras).encode()).hexdigest()
        cached = self.cache.get(key)
        if cached and len(cached) == len(paras):
            return cached

        idx = [i for i, p in enumerate(paras) if HAN.search(p)]
        batches, cur, size = [], [], 0
        for i in idx:
            n = len(paras[i])
            if cur and (size + n > max_chars or len(cur) >= max_items):
                batches.append(cur)
                cur, size = [], 0
            cur.append(i)
            size += n
        if cur:
            batches.append(cur)

        result = list(paras)
        with cf.ThreadPoolExecutor(self.workers) as ex:
            futs = {ex.submit(self._batch, [paras[i] for i in b]): b for b in batches}
            for f in cf.as_completed(futs):
                for i, t in zip(futs[f], f.result()):
                    result[i] = t
        self.cache.put(key, result)
        return result


# ---------------------------------------------------------------- EPUB
def xhtml(title, body, lang):
    return (f'<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>\n'
            f'<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" '
            f'lang="{lang}" xml:lang="{lang}">\n<head><meta charset="utf-8"/><title>{html.escape(title)}</title>'
            f'<link rel="stylesheet" type="text/css" href="style.css"/></head>\n<body>\n{body}\n</body>\n</html>\n')


CSS = """body{font-family:serif;line-height:1.6;margin:0 4%}
h1{font-size:1.5em;text-align:center;margin:1.5em 0 1em}
h2{font-size:1.25em;text-align:center;margin:1em 0}
p{text-indent:2em;margin:0 0 .5em;text-align:justify}
p.orig{color:#555;font-size:.92em;margin-bottom:.15em}
p.meta{text-indent:0;text-align:center;font-style:italic}
"""


def build_epub(path, book, lang):
    book_id = "urn:uuid:" + str(uuid.uuid5(uuid.NAMESPACE_URL, book["source"]))
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    esc = html.escape

    files = []  # (id, href, title)
    title_body = (f'<h1>{esc(book["title"])}</h1>'
                  + (f'<p class="meta">{esc(book["author"])}</p>' if book["author"] else "")
                  + "".join(f"<p>{esc(p)}</p>" for p in book["description"]))
    files.append(("title", "title.xhtml", book["title"], xhtml(book["title"], title_body, lang)))

    for n, ch in enumerate(book["chapters"], 1):
        parts = [f"<h2>{esc(ch['title'])}</h2>"]
        if ch.get("orig_title") and ch["orig_title"] != ch["title"]:
            parts.append(f'<p class="meta">{esc(ch["orig_title"])}</p>')
        for i, p in enumerate(ch["paras"]):
            if ch.get("orig") and ch["orig"][i] != p:
                parts.append(f'<p class="orig">{esc(ch["orig"][i])}</p>')
            parts.append(f"<p>{esc(p)}</p>")
        files.append((f"c{n:04d}", f"c{n:04d}.xhtml", ch["title"], xhtml(ch["title"], "\n".join(parts), lang)))

    manifest = "\n".join(
        f'<item id="{i}" href="{h}" media-type="application/xhtml+xml"/>' for i, h, _, _ in files)
    spine = "\n".join(f'<itemref idref="{i}"/>' for i, _, _, _ in files)
    opf = f"""<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="{lang}">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="bookid">{book_id}</dc:identifier>
<dc:title>{esc(book["title"])}</dc:title>
<dc:creator>{esc(book["author"] or "—")}</dc:creator>
<dc:language>{lang}</dc:language>
<dc:source>{esc(book["source"])}</dc:source>
<meta property="dcterms:modified">{now}</meta>
</metadata>
<manifest>
<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
<item id="css" href="style.css" media-type="text/css"/>
{manifest}
</manifest>
<spine toc="ncx">
{spine}
</spine>
</package>
"""
    nav_items = "\n".join(f'<li><a href="{h}">{esc(t)}</a></li>' for _, h, t, _ in files)
    nav = xhtml("Содержание", f'<nav epub:type="toc" id="toc"><h1>Содержание</h1><ol>\n{nav_items}\n</ol></nav>', lang)
    ncx_points = "\n".join(
        f'<navPoint id="n{k}" playOrder="{k}"><navLabel><text>{esc(t)}</text></navLabel>'
        f'<content src="{h}"/></navPoint>' for k, (_, h, t, _) in enumerate(files, 1))
    ncx = f"""<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
<head><meta name="dtb:uid" content="{book_id}"/></head>
<docTitle><text>{esc(book["title"])}</text></docTitle>
<navMap>
{ncx_points}
</navMap>
</ncx>
"""
    container = """<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>
"""
    with zipfile.ZipFile(path, "w") as z:
        z.writestr(zipfile.ZipInfo("mimetype"), "application/epub+zip", compress_type=zipfile.ZIP_STORED)
        z.writestr("META-INF/container.xml", container, compress_type=zipfile.ZIP_DEFLATED)
        z.writestr("OEBPS/content.opf", opf, compress_type=zipfile.ZIP_DEFLATED)
        z.writestr("OEBPS/nav.xhtml", nav, compress_type=zipfile.ZIP_DEFLATED)
        z.writestr("OEBPS/toc.ncx", ncx, compress_type=zipfile.ZIP_DEFLATED)
        z.writestr("OEBPS/style.css", CSS, compress_type=zipfile.ZIP_DEFLATED)
        for _, h, _, content in files:
            z.writestr(f"OEBPS/{h}", content, compress_type=zipfile.ZIP_DEFLATED)


# ---------------------------------------------------------------- main
def safe_filename(s):
    return re.sub(r'[\\/:*?"<>|\s]+', "_", s).strip("_") or "book"


def main():
    ap = argparse.ArgumentParser(description="Собрать книгу с kanunu8.com в EPUB (с переводом на русский).")
    ap.add_argument("url", help="ссылка на оглавление книги")
    ap.add_argument("-o", "--output", help="имя EPUB-файла")
    ap.add_argument("--translate", action="store_true", help="перевести на русский")
    ap.add_argument("--bilingual", action="store_true", help="с --translate: оригинал над каждым абзацем перевода")
    ap.add_argument("--lang", default="ru", help="язык перевода (по умолчанию ru)")
    ap.add_argument("--limit", type=int, help="взять только первые N глав")
    ap.add_argument("--workers", type=int, default=4, help="параллельных загрузок (по умолчанию 4)")
    ap.add_argument("--delay", type=float, default=0.3, help="пауза между запросами к сайту, сек")
    ap.add_argument("--cache", default=".book2epub_cache", help="папка кэша")
    args = ap.parse_args()

    cache = Cache(args.cache)
    print(f"Оглавление: {args.url}")
    info = parse_index(args.url, decode(fetch(args.url)))
    chapters = info["chapters"][: args.limit] if args.limit else info["chapters"]
    if not chapters:
        sys.exit("Не нашёл ни одной главы — проверьте ссылку на оглавление.")
    print(f"«{info['title']}» {info['author']} — глав: {len(chapters)}")

    def load(ch):
        cached = cache.get("ch:" + ch["url"])
        if cached is not None:
            return cached
        time.sleep(args.delay)
        paras = parse_chapter(decode(fetch(ch["url"])))
        cache.put("ch:" + ch["url"], paras)
        return paras

    with cf.ThreadPoolExecutor(args.workers) as ex:
        for k, (ch, paras) in enumerate(zip(chapters, ex.map(load, chapters)), 1):
            ch["paras"] = paras
            print(f"\r  загружено {k}/{len(chapters)}", end="", flush=True)
    print()
    empty = [c["title"] for c in chapters if not c["paras"]]
    if empty:
        print(f"  внимание: пустые главы ({len(empty)}): {', '.join(empty[:5])}…")

    title, author, desc = info["title"], info["author"], [info["description"]] if info["description"] else []
    lang = "zh"
    if args.translate:
        tr = Translator(cache, dst=args.lang)
        title_tr, author_tr, *desc_tr = tr.translate([title, author or "-", *desc])
        for k, ch in enumerate(chapters, 1):
            ch["orig_title"] = ch["title"]
            ch["title"] = tr.translate([ch["title"]])[0]
            translated = tr.translate(ch["paras"]) if ch["paras"] else []
            if args.bilingual:
                ch["orig"] = ch["paras"]
            ch["paras"] = translated
            print(f"\r  переведено {k}/{len(chapters)}", end="", flush=True)
        print()
        if args.bilingual:
            title = f"{title_tr} ({title})"
            desc = desc_tr + desc
        else:
            title, desc = title_tr, desc_tr
        author = f"{author_tr} ({author})" if author else ""
        lang = args.lang

    book = {"title": title, "author": author, "description": desc,
            "chapters": chapters, "source": args.url}
    out = args.output or safe_filename(info["title"] + ("_" + args.lang if args.translate else "")) + ".epub"
    build_epub(out, book, lang)
    print(f"Готово: {out}")


if __name__ == "__main__":
    main()

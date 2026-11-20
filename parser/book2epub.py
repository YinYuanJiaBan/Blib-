#!/usr/bin/env python3
"""
book2epub — собирает книгу с kanunu8.com (努努书坊) в EPUB и при желании
переводит её с китайского на русский (Google Translate или OpenRouter / DeepSeek).
Умеет также переводить уже готовый EPUB.

Используйте для произведений в общественном достоянии (классика) или для
текстов, на которые у вас есть права.

Примеры:
    python3 book2epub.py https://www.kanunu8.com/files/old/2011/2560.html
    python3 book2epub.py URL --translate                       # Google Translate
    OPENROUTER_API_KEY=sk-or-... python3 book2epub.py URL --translate --engine openrouter
    python3 book2epub.py book.epub --translate --engine openrouter --bilingual
    python3 book2epub.py URL --limit 3 -o test.epub

Зависимостей нет — только стандартная библиотека Python 3.8+.
"""
import argparse
import concurrent.futures as cf
import hashlib
import html
import json
import os
import posixpath
import re
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zipfile
from datetime import datetime, timezone
from html.parser import HTMLParser

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0 Safari/537.36")
GOOGLE_URL = "https://translate.googleapis.com/translate_a/t"
OPENROUTER_URL = os.environ.get("OPENROUTER_URL", "https://openrouter.ai/api/v1/chat/completions")
DEFAULT_MODEL = "deepseek/deepseek-chat"
HAN = re.compile(r"[㐀-䶿一-鿿豈-﫿]")


class FatalError(Exception):
    """Ошибка, после которой нет смысла повторять (неверный ключ, нет денег)."""


# ---------------------------------------------------------------- сеть
def fetch(url, data=None, headers=None, retries=4, timeout=60):
    """GET/POST с повторами. Возвращает bytes."""
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, data=data, headers={"User-Agent": UA, **(headers or {})})
            if data is not None and "Content-Type" not in (headers or {}):
                req.add_header("Content-Type", "application/x-www-form-urlencoded;charset=UTF-8")
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code in (400, 401, 402, 403, 404):
                raise
            last = e
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
    """Дисковый кэш: прерванную работу можно продолжить."""

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


# ---------------------------------------------------------------- разбор сайта
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


def split_paras(text):
    paras = [re.sub(r"^[\s　]+|[\s　]+$", "", p) for p in text.split("\n")]
    return [p for p in paras if p]


def parse_index(url, page):
    title = None
    for pat in (r"<h1[^>]*>(.*?)</h1>", r"<h2[^>]*>(.*?)</h2>"):
        m = re.search(pat, page, re.S | re.I)
        if m and strip_tags(m.group(1)):
            title = strip_tags(m.group(1))
            break
    tm = re.search(r"<title>(.*?)</title>", page, re.S | re.I)
    page_title = strip_tags(tm.group(1)) if tm else ""
    if not title:
        title = re.split(r"\s*[-_]\s*|\s+by\s+", page_title)[0] or "Книга"

    author = ""
    m = re.search(r"作者[：:]\s*([^<\s]+)", page)
    m = m or re.search(r"\bby\s+([^\s-]+)", page_title) or re.search(r"-\s*小说[^-]*-\s*([^-]+?)\s*-", page_title)
    if m:
        author = strip_tags(m.group(1))

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
        chapters.append({"url": full, "title": text or f"第{len(chapters) + 1}章"})
    return {"title": title, "author": author, "description": description, "chapters": chapters}


def parse_chapter(page):
    """Текст главы — самый крупный <p>…</p> на странице."""
    best = ""
    for m in re.finditer(r"<p[^>]*>(.*?)</p>", page, re.S | re.I):
        if len(m.group(1)) > len(best):
            best = m.group(1)
    if not best:
        return []
    text = re.sub(r"<br\s*/?>", "\n", best, flags=re.I)
    return split_paras(strip_tags(text))


def load_from_site(url, cache, limit=None, workers=4, delay=0.3, progress=None):
    info = parse_index(url, decode(fetch(url)))
    chapters = info["chapters"][:limit] if limit else info["chapters"]
    if not chapters:
        raise ValueError("Не нашёл ни одной главы — проверьте ссылку на оглавление.")

    def load(ch):
        cached = cache.get("ch:" + ch["url"])
        if cached is not None:
            return cached
        time.sleep(delay)
        paras = parse_chapter(decode(fetch(ch["url"])))
        cache.put("ch:" + ch["url"], paras)
        return paras

    failed = []
    with cf.ThreadPoolExecutor(workers) as ex:
        futs = [ex.submit(load, ch) for ch in chapters]
        for k, (ch, f) in enumerate(zip(chapters, futs), 1):
            try:
                ch["paras"] = f.result()
            except Exception:  # noqa: BLE001
                ch["paras"] = []
                failed.append(ch["title"])
            if progress:
                progress("download", k, len(chapters))
    return {"title": info["title"], "author": info["author"],
            "description": [info["description"]] if info["description"] else [],
            "chapters": chapters, "source": url, "failed": failed}


# ---------------------------------------------------------------- чтение EPUB
def _xml_text(s):
    return html.unescape(re.sub(r"<[^>]+>", "", s)).replace("\xa0", " ").strip()


def load_from_epub(path, limit=None):
    """Достаёт из EPUB заголовок, автора и главы (заголовок + абзацы)."""
    with zipfile.ZipFile(path) as z:
        container = z.read("META-INF/container.xml").decode("utf-8", "replace")
        opf_path = re.search(r'full-path="([^"]+)"', container).group(1)
        opf = z.read(opf_path).decode("utf-8", "replace")
        base = posixpath.dirname(opf_path)

        def meta(tag):
            m = re.search(rf"<dc:{tag}[^>]*>(.*?)</dc:{tag}>", opf, re.S)
            return _xml_text(m.group(1)) if m else ""

        manifest = {}
        for m in re.finditer(r"<item\b([^>]*)/?>", opf):
            attrs = dict(re.findall(r'([\w:-]+)="([^"]*)"', m.group(1)))
            manifest[attrs.get("id")] = attrs
        description, chapters = [], []
        for idref in re.findall(r'<itemref\b[^>]*idref="([^"]+)"', opf):
            item = manifest.get(idref)
            if not item or "nav" in item.get("properties", "") or "html" not in item.get("media-type", ""):
                continue
            name = posixpath.normpath(posixpath.join(base, urllib.parse.unquote(item["href"])))
            try:
                doc = z.read(name).decode("utf-8", "replace")
            except KeyError:
                continue
            body = re.sub(r"<(script|style)\b.*?</\1>", "", doc, flags=re.S | re.I)
            body = re.sub(r'<p\b[^>]*class="(?:orig|meta)"[^>]*>.*?</p>', "", body, flags=re.S | re.I)
            head = re.search(r"<h[1-3]\b[^>]*>(.*?)</h[1-3]>", body, re.S | re.I)
            paras = [_xml_text(p) for p in re.findall(r"<p\b[^>]*>(.*?)</p>", body, re.S | re.I)]
            paras = [p for p in paras if p]
            if re.search(r"(^|/)title\.xhtml$", item["href"]):  # титульная страница наших EPUB
                description = paras
                continue
            if not paras:
                inner = re.search(r"<body\b[^>]*>(.*)</body>", body, re.S | re.I)
                text = re.sub(r"<br\s*/?>|</(div|p|h\d)>", "\n", inner.group(1) if inner else "", flags=re.I)
                if head:
                    text = text.replace(head.group(0), "")
                paras = split_paras(_xml_text(text))
            if not paras and not head:
                continue
            title = _xml_text(head.group(1)) if head else f"Глава {len(chapters) + 1}"
            chapters.append({"title": title, "paras": paras})
    if limit:
        chapters = chapters[:limit]
    if not chapters:
        raise ValueError("В EPUB не нашлось текста.")
    author = meta("creator")
    return {"title": meta("title") or os.path.splitext(os.path.basename(path))[0],
            "author": "" if author == "—" else author, "description": description,
            "chapters": chapters, "source": os.path.basename(path), "failed": []}


# ---------------------------------------------------------------- перевод
def make_batches(texts, max_chars, max_items):
    batches, cur, size = [], [], 0
    for i, t in enumerate(texts):
        if cur and (size + len(t) > max_chars or len(cur) >= max_items):
            batches.append(cur)
            cur, size = [], 0
        cur.append(i)
        size += len(t)
    if cur:
        batches.append(cur)
    return batches


class BaseTranslator:
    max_chars, max_items, workers = 4000, 80, 3
    name = "base"

    def __init__(self, cache):
        self.cache = cache
        self.missed = 0

    def _batch(self, texts):
        raise NotImplementedError

    def cache_prefix(self):
        return self.name

    def translate(self, texts, progress=None):
        """Переводит список строк. Строки без иероглифов возвращает как есть."""
        result = list(texts)
        idx = [i for i, t in enumerate(texts) if HAN.search(t)]
        todo = [texts[i] for i in idx]
        batches = make_batches(todo, self.max_chars, self.max_items)
        prefix = hashlib.sha1(self.cache_prefix().encode()).hexdigest()[:12]
        done = [0]
        lock = threading.Lock()

        def run(batch):
            part = [todo[i] for i in batch]
            key = "tr:" + prefix + ":" + hashlib.sha1("\u0001".join(part).encode()).hexdigest()
            out = self.cache.get(key)
            if not (isinstance(out, list) and len(out) == len(part)):
                out = self._batch(part)
                if all(out):
                    self.cache.put(key, out)
            with lock:
                for i, v in zip(batch, out):
                    if v:
                        result[idx[i]] = v
                    else:
                        self.missed += 1
                done[0] += 1
                if progress:
                    progress("translate", done[0], len(batches))

        with cf.ThreadPoolExecutor(self.workers) as ex:
            for f in [ex.submit(run, b) for b in batches]:
                f.result()
        return result


class GoogleTranslator(BaseTranslator):
    name = "google"
    max_chars, max_items = 4500, 80

    def __init__(self, cache, dst="ru"):
        super().__init__(cache)
        self.dst = dst

    def cache_prefix(self):
        return f"google:{self.dst}"

    def _batch(self, texts):
        url = f"{GOOGLE_URL}?client=gtx&sl=zh-CN&tl={self.dst}&format=text"
        body = urllib.parse.urlencode([("q", t) for t in texts]).encode()
        data = json.loads(fetch(url, data=body).decode("utf-8"))
        out = [x[0] if isinstance(x, list) else x for x in data]
        if len(out) != len(texts):
            raise RuntimeError("переводчик вернул неожиданное число строк")
        return out


class OpenRouterTranslator(BaseTranslator):
    """Перевод через OpenRouter (по умолчанию DeepSeek) с метками ⟦N⟧ у фрагментов."""
    name = "openrouter"
    max_chars, max_items, workers = 1800, 40, 3

    def __init__(self, cache, api_key, model=DEFAULT_MODEL, book_title="", glossary=""):
        super().__init__(cache)
        if not api_key:
            raise FatalError("Не задан ключ OpenRouter (переменная OPENROUTER_API_KEY).")
        self.api_key, self.model = api_key, model or DEFAULT_MODEL
        self.system = (
            "Ты профессиональный литературный переводчик с китайского языка на русский. "
            "Переводи художественно, точно и естественно для русского читателя, сохраняя стиль, тон, "
            "диалоги и смысл оригинала. Китайские имена, фамилии и топонимы передавай по системе Палладия, "
            "кириллицей, единообразно во всём тексте. Не добавляй комментариев, примечаний, пояснений "
            "и транслитерации в скобках.\n"
            "Формат: каждый фрагмент начинается с метки вида ⟦N⟧. Верни перевод каждого фрагмента, "
            "начиная его с той же метки, в том же порядке. Не пропускай, не объединяй и не разбивай "
            "фрагменты. Не выводи ничего, кроме фрагментов с метками.")
        if book_title:
            self.system += f"\nКнига: «{book_title}»."
        if glossary.strip():
            self.system += "\nОбязательный глоссарий (оригинал = перевод):\n" + glossary.strip()

    def cache_prefix(self):
        return f"openrouter:{self.model}:{self.system}"

    def _call(self, texts):
        body = "\n\n".join(f"⟦{i + 1}⟧ {t}" for i, t in enumerate(texts))
        payload = json.dumps({
            "model": self.model, "temperature": 0.3,
            "messages": [{"role": "system", "content": self.system}, {"role": "user", "content": body}],
        }).encode()
        headers = {"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json",
                   "HTTP-Referer": "https://github.com/", "X-Title": "book2epub"}
        try:
            data = json.loads(fetch(OPENROUTER_URL, data=payload, headers=headers, retries=1, timeout=300))
        except urllib.error.HTTPError as e:
            msg = e.read().decode("utf-8", "replace")[:300]
            if e.code == 401:
                raise FatalError("OpenRouter не принял ключ. Проверьте OPENROUTER_API_KEY.") from None
            if e.code == 402:
                raise FatalError("На счёте OpenRouter закончились средства.") from None
            if e.code in (400, 404):
                raise FatalError(f"OpenRouter отклонил запрос (проверьте модель «{self.model}»): {msg}") from None
            raise RuntimeError(f"HTTP {e.code}: {msg}") from None
        if data.get("error"):
            raise RuntimeError(data["error"].get("message", "ошибка модели"))
        out = (data.get("choices") or [{}])[0].get("message", {}).get("content") or ""
        parts = {int(n): t.strip() for n, t in re.findall(r"⟦(\d+)⟧\s*(.*?)(?=⟦\d+⟧|\Z)", out, re.S)}
        return [parts.get(i + 1) for i in range(len(texts))]

    def _batch(self, texts):
        last, incomplete = None, False
        for attempt in range(5):
            try:
                res = self._call(texts)
                if all(res):
                    return res
                last, incomplete = "модель вернула не все фрагменты", True
                if len(texts) > 1:
                    break  # делим пакет пополам — так модель реже сбивается
            except FatalError:
                raise
            except Exception as e:  # noqa: BLE001 — сеть/перегрузка: ждём и повторяем
                last, incomplete = e, False
            time.sleep(min(30, 2 * 2 ** attempt))
        if incomplete and len(texts) > 1:
            mid = (len(texts) + 1) // 2
            return self._batch(texts[:mid]) + self._batch(texts[mid:])
        print(f"  не переведено фрагментов: {len(texts)} ({last})", file=sys.stderr)
        return [None] * len(texts)


def translate_book(book, translator, bilingual=False, progress=None):
    """Переводит название, автора, описание, заголовки глав и абзацы на месте."""
    texts = [book["title"], book["author"], *book["description"]]
    for ch in book["chapters"]:
        texts.append(ch["title"])
        texts.extend(ch["paras"])
    out = translator.translate(texts, progress)

    it = iter(out)
    book["orig_title"], book["title"] = book["title"], next(it)
    book["orig_author"], book["author"] = book["author"], next(it)
    book["description"] = [next(it) for _ in book["description"]]
    for ch in book["chapters"]:
        ch["orig_title"], ch["title"] = ch["title"], next(it)
        orig = ch["paras"]
        ch["paras"] = [next(it) for _ in orig]
        if bilingual:
            ch["orig"] = orig
    return translator.missed


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
    book_id = "urn:uuid:" + str(uuid.uuid5(uuid.NAMESPACE_URL, book["source"] + lang))
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    esc = html.escape
    bilingual = any(ch.get("orig") for ch in book["chapters"])

    author_line = book["author"]
    if book.get("orig_author") and book["orig_author"] != book["author"]:
        author_line = f'{book["author"]} ({book["orig_author"]})'
    files = []
    title_body = (f'<h1>{esc(book["title"])}</h1>'
                  + (f'<p class="meta">{esc(book["orig_title"])}</p>'
                     if book.get("orig_title") and book["orig_title"] != book["title"] else "")
                  + (f'<p class="meta">{esc(author_line)}</p>' if author_line else "")
                  + "".join(f"<p>{esc(p)}</p>" for p in book["description"]))
    files.append(("title", "title.xhtml", book["title"], xhtml(book["title"], title_body, lang)))

    for n, ch in enumerate(book["chapters"], 1):
        parts = [f"<h2>{esc(ch['title'])}</h2>"]
        if bilingual and ch.get("orig_title") and ch["orig_title"] != ch["title"]:
            parts.append(f'<p class="meta">{esc(ch["orig_title"])}</p>')
        orig = ch.get("orig")
        for i, p in enumerate(ch["paras"]):
            if orig and orig[i] != p:
                parts.append(f'<p class="orig">{esc(orig[i])}</p>')
            parts.append(f"<p>{esc(p)}</p>")
        files.append((f"c{n:04d}", f"c{n:04d}.xhtml", ch["title"], xhtml(ch["title"], "\n".join(parts), lang)))

    toc_title = "Содержание" if lang == "ru" else "目录"
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
    nav = xhtml(toc_title, f'<nav epub:type="toc" id="toc"><h1>{toc_title}</h1><ol>\n{nav_items}\n</ol></nav>', lang)
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
        for name, content in (("META-INF/container.xml", container), ("OEBPS/content.opf", opf),
                              ("OEBPS/nav.xhtml", nav), ("OEBPS/toc.ncx", ncx), ("OEBPS/style.css", CSS)):
            z.writestr(name, content, compress_type=zipfile.ZIP_DEFLATED)
        for _, h, _, content in files:
            z.writestr(f"OEBPS/{h}", content, compress_type=zipfile.ZIP_DEFLATED)


def safe_filename(s):
    return (re.sub(r'[\\/:*?"<>|\s]+', "_", s).strip("_") or "book")[:80]


# ---------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser(description="Собрать книгу с kanunu8.com в EPUB (с переводом на русский).")
    ap.add_argument("source", help="ссылка на оглавление книги или путь к .epub")
    ap.add_argument("-o", "--output", help="имя EPUB-файла")
    ap.add_argument("--translate", action="store_true", help="перевести на русский")
    ap.add_argument("--engine", choices=["google", "openrouter"], default="google",
                    help="чем переводить (openrouter берёт ключ из OPENROUTER_API_KEY)")
    ap.add_argument("--model", default=os.environ.get("OPENROUTER_MODEL", DEFAULT_MODEL), help="модель OpenRouter")
    ap.add_argument("--glossary", default="", help="файл глоссария: строки «顾茫 = Гу Ман»")
    ap.add_argument("--bilingual", action="store_true", help="с --translate: оригинал над каждым абзацем перевода")
    ap.add_argument("--lang", default="ru", help="язык перевода для Google (по умолчанию ru)")
    ap.add_argument("--limit", type=int, help="взять только первые N глав")
    ap.add_argument("--workers", type=int, default=4, help="параллельных загрузок (по умолчанию 4)")
    ap.add_argument("--delay", type=float, default=0.3, help="пауза между запросами к сайту, сек")
    ap.add_argument("--cache", default=".book2epub_cache", help="папка кэша")
    args = ap.parse_args()

    cache = Cache(args.cache)

    def progress(stage, done, total):
        label = {"download": "загружено глав", "translate": "переведено частей"}[stage]
        print(f"\r  {label}: {done}/{total}", end="" if done < total else "\n", flush=True)

    if args.source.lower().endswith(".epub") and os.path.exists(args.source):
        book = load_from_epub(args.source, args.limit)
    else:
        print(f"Оглавление: {args.source}")
        book = load_from_site(args.source, cache, args.limit, args.workers, args.delay, progress)
    print(f"«{book['title']}» {book['author']} — глав: {len(book['chapters'])}")
    if book["failed"]:
        print(f"  внимание: не загрузились главы ({len(book['failed'])}): {', '.join(book['failed'][:5])}…")

    orig_title = book["title"]
    lang = "zh"
    if args.translate:
        if args.engine == "openrouter":
            glossary = open(args.glossary, encoding="utf-8").read() if args.glossary else ""
            tr = OpenRouterTranslator(cache, os.environ.get("OPENROUTER_API_KEY", ""), args.model, orig_title, glossary)
            lang = "ru"
        else:
            tr = GoogleTranslator(cache, args.lang)
            lang = args.lang
        missed = translate_book(book, tr, args.bilingual, progress)
        if missed:
            print(f"  не переведено фрагментов: {missed} — запустите ещё раз, чтобы допереводить")

    out = args.output or safe_filename(orig_title + ("_" + lang if args.translate else "")) + ".epub"
    build_epub(out, book, lang)
    print(f"Готово: {out}")


if __name__ == "__main__":
    try:
        main()
    except FatalError as e:
        sys.exit(f"Ошибка: {e}")

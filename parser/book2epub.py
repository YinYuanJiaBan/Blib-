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
            body = re.sub(r"<aside\b[^>]*footnote[^>]*>.*?</aside>", "", body, flags=re.S | re.I)
            body = re.sub(r"<sup\b[^>]*>\s*<a\b[^>]*noteref[^>]*>.*?</a>\s*</sup>", "", body, flags=re.S | re.I)
            head = re.search(r"<h[1-3]\b[^>]*>(.*?)</h[1-3]>", body, re.S | re.I)
            paras = [_xml_text(p) for p in re.findall(r"<p\b[^>]*>(.*?)</p>", body, re.S | re.I)]
            paras = [p for p in paras if p]
            if re.search(r"(^|/)about\.xhtml$", item["href"]):  # справка о книге в наших EPUB
                continue
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
        cover = _epub_cover(z, opf, base, manifest)
    if limit:
        chapters = chapters[:limit]
    if not chapters:
        raise ValueError("В EPUB не нашлось текста.")
    author = meta("creator")
    return {"title": meta("title") or os.path.splitext(os.path.basename(path))[0],
            "author": "" if author == "—" else author, "description": description,
            "chapters": chapters, "source": os.path.basename(path), "failed": [], "cover": cover}


IMAGE_TYPES = {"jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png", "gif": "image/gif", "webp": "image/webp"}


def _epub_cover(z, opf, base, manifest):
    """Обложка из EPUB: (байты, media-type) или None. EPUB 3 cover-image, EPUB 2 <meta name="cover">."""
    items = [i for i in manifest.values() if i]
    item = next((i for i in items if "cover-image" in i.get("properties", "").split()), None)
    if not item:
        m = re.search(r'<meta\b(?=[^>]*\bname="cover")[^>]*\bcontent="([^"]+)"', opf)
        item = manifest.get(m.group(1)) if m else None
    if not item:
        item = next((i for i in items if i.get("media-type", "").startswith("image/")
                     and "cover" in (i.get("id", "") + i.get("href", "")).lower()), None)
    if not item or not item.get("href"):
        return None
    name = posixpath.normpath(posixpath.join(base, urllib.parse.unquote(item["href"])))
    ext = name.rsplit(".", 1)[-1].lower()
    mtype = item.get("media-type") or IMAGE_TYPES.get(ext, "")
    if mtype not in IMAGE_TYPES.values():
        return None
    try:
        data = z.read(name)
    except KeyError:
        return None
    return (data, mtype) if 100 < len(data) <= 5 * 1024 * 1024 else None


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


class Usage:
    """Счётчик токенов и денег по ответам OpenRouter (потокобезопасный)."""

    def __init__(self):
        self.lock = threading.Lock()
        self.calls = self.prompt = self.cached = self.completion = self.reasoning = 0
        self.cost = 0.0

    def add(self, u):
        with self.lock:
            self.calls += 1
            self.prompt += int(u.get("prompt_tokens") or 0)
            self.cached += int((u.get("prompt_tokens_details") or {}).get("cached_tokens") or 0)
            self.completion += int(u.get("completion_tokens") or 0)
            self.reasoning += int((u.get("completion_tokens_details") or {}).get("reasoning_tokens") or 0)
            self.cost += float(u.get("cost") or 0)

    def summary(self):
        def num(x):
            return f"{x:,}".replace(",", " ")
        cached = f" (из кэша {100 * self.cached // self.prompt}%)" if self.prompt else ""
        return (f"запросов {self.calls}, токенов: вход {num(self.prompt)}{cached}, выход {num(self.completion)}"
                + (f" (размышления {num(self.reasoning)})" if self.reasoning else "") + ", "
                f"≈${self.cost:.2f}")


class BaseTranslator:
    max_chars, max_items, workers = 4000, 80, 3
    name = "base"
    context_items = 0  # сколько предыдущих абзацев показывать модели как контекст

    def __init__(self, cache):
        self.cache = cache
        self.missed = 0
        self.from_cache = 0
        self.stop_reason = ""  # не пусто — новые запросы больше не отправляются (например, исчерпан бюджет)
        self.on_plan = None    # on_plan(всего абзацев, уже в кэше, иероглифов осталось) — перед началом перевода

    def _batch(self, texts, context=()):
        raise NotImplementedError

    def cache_prefix(self):
        return self.name

    def passthrough(self, text):
        """Строка без иероглифов (знаки препинания, цифры) — в перевод не отправляется."""
        return text

    def legacy_lookup(self, todo, out):
        """Подставляет в out переводы, сохранённые прежними версиями программы под другими ключами."""

    def translate(self, texts, progress=None):
        """Переводит список строк. Строки без иероглифов возвращает как есть.
        Кэш — по абзацам, поэтому размер пакетов можно менять, не теряя готового."""
        result = [t if HAN.search(t) else self.passthrough(t) for t in texts]
        idx = [i for i, t in enumerate(texts) if HAN.search(t)]
        todo = [texts[i] for i in idx]
        prefix = hashlib.sha1(self.cache_prefix().encode()).hexdigest()[:12]

        def pkey(t):
            return "p:" + prefix + ":" + hashlib.sha1(t.encode()).hexdigest()

        out = [None] * len(todo)
        for j, t in enumerate(todo):
            v = self.cache.get(pkey(t))
            if isinstance(v, str) and v:
                out[j] = v
        found = [bool(v) for v in out]
        self.legacy_lookup(todo, out)
        for j, v in enumerate(out):
            if v and not found[j]:
                self.cache.put(pkey(todo[j]), v)

        pending = [j for j, v in enumerate(out) if not v]
        self.from_cache = len(todo) - len(pending)
        if self.on_plan:
            self.on_plan(len(todo), self.from_cache, sum(len(todo[j]) for j in pending))
        groups = make_batches([todo[j] for j in pending], self.max_chars, self.max_items)
        batches = [[pending[k] for k in g] for g in groups]
        done = [0]
        lock = threading.Lock()

        def run(batch):
            if not self.stop_reason:
                start = batch[0]
                context = todo[max(0, start - self.context_items):start] if self.context_items else []
                res = self._batch([todo[j] for j in batch], context)
                for j, v in zip(batch, res):
                    if v:
                        out[j] = v
                        self.cache.put(pkey(todo[j]), v)
            with lock:
                done[0] += 1
                if progress:
                    progress("translate", done[0], len(batches))

        with cf.ThreadPoolExecutor(self.workers) as ex:
            for f in [ex.submit(run, b) for b in batches]:
                f.result()
        for j, v in enumerate(out):
            if v:
                result[idx[j]] = v
            else:
                self.missed += 1
        return result


class GoogleTranslator(BaseTranslator):
    name = "google"
    max_chars, max_items = 4500, 80

    def __init__(self, cache, dst="ru"):
        super().__init__(cache)
        self.dst = dst

    def cache_prefix(self):
        return f"google:{self.dst}"

    def _batch(self, texts, context=()):
        url = f"{GOOGLE_URL}?client=gtx&sl=zh-CN&tl={self.dst}&format=text"
        body = urllib.parse.urlencode([("q", t) for t in texts]).encode()
        data = json.loads(fetch(url, data=body).decode("utf-8"))
        out = [x[0] if isinstance(x, list) else x for x in data]
        if len(out) != len(texts):
            raise RuntimeError("переводчик вернул неожиданное число строк")
        return out


def openrouter_chat(api_key, model, messages, temperature=0.3, timeout=300, usage=None):
    """Один запрос к OpenRouter. Возвращает текст ответа модели; расход пишет в usage (Usage)."""
    if not api_key:
        raise FatalError("Не задан ключ OpenRouter (переменная OPENROUTER_API_KEY).")
    body = {"model": model, "temperature": temperature, "messages": messages, "usage": {"include": True}}
    # Перевод не требует «размышлений»: у моделей с рассуждениями они съедают большую часть токенов и времени.
    if os.environ.get("OPENROUTER_REASONING", "off").lower() in ("off", "0", "no", "false", ""):
        body["reasoning"] = {"enabled": False, "exclude": True}
    provider = os.environ.get("OPENROUTER_PROVIDER", "").strip()
    if provider:  # закрепить провайдера, у которого работает кэширование промпта
        body["provider"] = {"order": [p.strip() for p in provider.split(",") if p.strip()], "allow_fallbacks": True}
    payload = json.dumps(body).encode()
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json",
               "HTTP-Referer": "https://github.com/", "X-Title": "book2epub"}
    t0 = time.time()
    try:
        data = json.loads(fetch(OPENROUTER_URL, data=payload, headers=headers, retries=1, timeout=timeout))
    except urllib.error.HTTPError as e:
        msg = e.read().decode("utf-8", "replace")[:300]
        if e.code == 400 and "reasoning" in body and "reason" in msg.lower():
            # модель не умеет отключать рассуждения — повторяем без этого параметра
            os.environ["OPENROUTER_REASONING"] = "on"
            return openrouter_chat(api_key, model, messages, temperature, timeout, usage)
        if e.code == 401:
            raise FatalError("OpenRouter не принял ключ. Проверьте OPENROUTER_API_KEY.") from None
        if e.code == 402:
            raise FatalError("На счёте OpenRouter закончились средства.") from None
        if e.code in (400, 404):
            raise FatalError(f"OpenRouter отклонил запрос (проверьте модель «{model}»): {msg}") from None
        raise RuntimeError(f"HTTP {e.code}: {msg}") from None
    u = data.get("usage") or {}
    if usage is not None and u:
        usage.add(u)
    if u:
        rt = (u.get("completion_tokens_details") or {}).get("reasoning_tokens") or 0
        print(f"  запрос: {time.time() - t0:.0f} с, вход {u.get('prompt_tokens')}, выход {u.get('completion_tokens')}"
              + (f" (из них размышления {rt})" if rt else ""), file=sys.stderr, flush=True)
    if data.get("error"):
        raise RuntimeError(data["error"].get("message", "ошибка модели"))
    return (data.get("choices") or [{}])[0].get("message", {}).get("content") or ""


TRANSLATOR_PROMPT = """Ты литературный переводчик с китайского на русский. Переводи художественно, точно и \
естественно, сохраняя стиль, тон, диалоги и смысл.

Точность:
- Ничего не добавляй и не пропускай: жесты, взгляды, паузы, оттенки чувств, детали обстановки.
- Сохраняй образы, сравнения и их порядок (水火 — «вода и огонь»), не подменяй образ другим.
- Многозначные слова — по контексту, устойчивые слова не разбирай на части (浮生 — «бренная жизнь»).
- Реалии эпохи (кисть и тушь, свиток), без современных и европейских реалий.
- Кто действует и к кому обращено действие — строго как в оригинале; род и число — по справке о персонажах.
- Надписи, указы, письма, стихи — с каждым значимым словом. Тон (ирония, просторечие, архаика) передавай словами.

Оформление:
- Прямая речь через тире: «— Реплика, — сказал он. — Продолжение». После двоеточия: «Он сказал: — Реплика».
- “” 「」 в речи → тире; в цитатах и названиях → «ёлочки». «……» → «…»; реплика из многоточия → «— …».
- Имена и топонимы — по Палладию, единообразно; имена из глоссария — строго как в глоссарии.
- Никаких комментариев и транслитерации в тексте: названия вещей и титулов переводи по смыслу.

Формат: каждый фрагмент начинается с метки ⟦N⟧. Верни перевод каждого фрагмента с той же меткой, в том же порядке, \
не объединяя и не разбивая. Больше ничего не выводи. Абзацы под заголовком «Контекст» и строки «Глоссарий» \
не переводи и не выводи."""

NOTES_PROMPT = """Сноски: распознавай чэнъюи (成语) и другие устойчивые выражения, метафоры, аллюзии на историю, \
литературу, философию и мифологию, игру слов и культурные реалии, которые русский читатель без пояснения не поймёт \
или поймёт неверно. В тексте переводи такое выражение художественно, а сразу после него ставь метку [^1] \
(нумерация внутри фрагмента). После текста фрагмента, каждую с новой строки, пиши сноску:
[^1]: 金枝玉叶 (jīn zhī yù yè). Дословно: «золотая ветвь, нефритовые листья». О человеке знатного происхождения, \
которого нельзя равнять с простыми людьми.
Иероглифы ровно как в оригинале, пиньинь с тонами, дословный перевод, 1–2 предложения о смысле и оттенке. \
Не поясняй обычные слова, имена и очевидные сравнения. Обычно в абзаце сносок нет, больше двух — никогда."""

NOTE_REF = re.compile(r"\[\^(\d+)\]")
NOTE_DEF = re.compile(r"^[ \t]*\[\^(\d+)\]:[ \t]*(.+?)[ \t]*$", re.M)


def split_notes(text):
    """Отделяет сноски «[^1]: …» от текста. Возвращает (текст с метками [^1], {номер: сноска})."""
    notes = {n: t for n, t in NOTE_DEF.findall(text or "")}
    body = NOTE_DEF.sub("", text or "").strip()
    return body, notes


def strip_notes(text):
    return NOTE_REF.sub("", split_notes(text)[0]).strip()


class OpenRouterTranslator(BaseTranslator):
    """Перевод через OpenRouter (по умолчанию DeepSeek) с метками ⟦N⟧ у фрагментов.

    Системный промпт одинаков для всех запросов книги (провайдер кэширует его и берёт дешевле),
    а глоссарий идёт в запрос только теми строками, что встречаются в этом пакете."""
    name = "openrouter"
    max_chars, max_items, workers = 5000, 120, 8
    context_items = 2

    def __init__(self, cache, api_key, model=DEFAULT_MODEL, book_title="", glossary="", card=None, notes=True,
                 budget=None):
        super().__init__(cache)
        if not api_key:
            raise FatalError("Не задан ключ OpenRouter (переменная OPENROUTER_API_KEY).")
        self.api_key, self.model = api_key, model or DEFAULT_MODEL
        self.usage, self.budget = Usage(), budget
        self.system = TRANSLATOR_PROMPT + "\n\n" + (NOTES_PROMPT if notes else "Сносок не делай.")
        if book_title:
            self.system += f"\n\nКнига: «{book_title}»" + (f" (по-русски: «{card['title_ru']}»)"
                                                          if card and card.get("title_ru") else "") + "."
        if card:
            self.system += "\n\n" + card_brief(card)
        full = merge_glossary(card_glossary(card) if card else "", glossary)
        self.glossary = parse_glossary(full)
        self.glossary_text = full
        try:
            import legacy_prompts as old
            self.legacy = ("tr:" + hashlib.sha1(f"openrouter:{self.model}:{old.system(book_title, card, full, notes)}"
                                                .encode()).hexdigest()[:12], old.MAX_CHARS, old.MAX_ITEMS)
        except ImportError:
            self.legacy = None

    def cache_prefix(self):
        return f"openrouter:v2:{self.model}:{self.system}\n{self.glossary_text}"

    def legacy_lookup(self, todo, out):
        if not self.legacy:
            return
        prefix, max_chars, max_items = self.legacy
        for g in make_batches(todo, max_chars, max_items):
            part = [todo[i] for i in g]
            v = self.cache.get(prefix + ":" + hashlib.sha1("\u0001".join(part).encode()).hexdigest())
            if isinstance(v, list) and len(v) == len(part):
                for i, t in zip(g, v):
                    if t and not out[i]:
                        out[i] = t

    def passthrough(self, text):
        # Реплика-молчание “……” → «— …», китайское многоточие → русское.
        t = text.replace("……", "…").replace("。", ".")
        m = re.fullmatch(r"\s*[“「『\"]\s*([…\.!?！？—\s]+?)\s*[”」』\"]\s*", t)
        return "— " + m.group(1).replace("！", "!").replace("？", "?") if m else t

    def _call(self, texts, context=()):
        joined = "".join(texts) + "".join(context)
        gl = [f"{k} = {v}" for k, v in self.glossary.items() if k in joined]
        body = ""
        if gl:
            body += "Глоссарий для этого отрывка (оригинал = перевод):\n" + "\n".join(gl) + "\n\n"
        if context:
            body += "Контекст (предыдущие абзацы, не переводить):\n" + "\n".join(context) + "\n\n"
        if body:
            body += "Переведи:\n"
        body += "\n\n".join(f"⟦{i + 1}⟧ {t}" for i, t in enumerate(texts))
        out = openrouter_chat(self.api_key, self.model,
                              [{"role": "system", "content": self.system}, {"role": "user", "content": body}],
                              usage=self.usage)
        if self.budget and self.usage.cost >= self.budget and not self.stop_reason:
            self.stop_reason = f"достигнут лимит расходов ${self.budget:g}"
        parts = {int(n): t.strip() for n, t in re.findall(r"⟦(\d+)⟧\s*(.*?)(?=⟦\d+⟧|\Z)", out, re.S)}
        return [parts.get(i + 1) for i in range(len(texts))]

    def _batch(self, texts, context=()):
        last, incomplete = None, False
        for attempt in range(5):
            if self.stop_reason:
                return [None] * len(texts)
            try:
                res = self._call(texts, context)
                if all(res):
                    return res
                last, incomplete = "модель вернула не все фрагменты", True
                if len(texts) > 1:
                    # делим пакет пополам — так модель реже сбивается; готовые фрагменты не теряем
                    mid = (len(texts) + 1) // 2
                    a = res[:mid] if all(res[:mid]) else self._batch(texts[:mid], context)
                    b = res[mid:] if all(res[mid:]) else self._batch(texts[mid:], texts[:mid][-self.context_items:])
                    return a + b
            except FatalError:
                raise
            except Exception as e:  # noqa: BLE001 — сеть/перегрузка: ждём и повторяем
                last, incomplete = e, False
            time.sleep(min(30, 2 * 2 ** attempt))
        print(f"  не переведено фрагментов: {len(texts)} ({last})", file=sys.stderr)
        return [None] * len(texts)


# ---------------------------------------------------------------- справка о книге
CARD_PROMPT = """Ты редактор-синолог. Готовишь справку о китайской книге для переводчиков на русский язык.
Если ты узнаёшь книгу (классика, известный роман, веб-новелла), используй свои знания о ней: устоявшиеся \
русское и английское названия, сюжет, главных героев всей книги. Если не узнаёшь или не уверен, опирайся только \
на присланный отрывок и ничего не выдумывай.
Китайские имена и названия передавай по системе Палладия (墨熄 — Мо Си, 顾茫 — Гу Ман, 重华 — Чунхуа).
Ответь ТОЛЬКО объектом JSON без пояснений и без ```:
{
  "known": true или false — узнал ли ты книгу,
  "title_ru": "русское название: устоявшееся, если есть, иначе твой литературный перевод",
  "title_literal": "буквальный перевод названия",
  "title_en": "английское название, если есть, иначе пустая строка",
  "title_pinyin": "название пиньинем с тонами",
  "author_ru": "автор по-русски (псевдоним можно перевести по смыслу)",
  "genre": "жанр по-русски, коротко",
  "synopsis": "о чём книга, 3–6 предложений по-русски, без спойлеров финала",
  "characters": [{"zh": "иероглифы имени", "pinyin": "пиньинь", "ru": "имя по Палладию", \
"gender": "м" или "ж", "role": "кто это, одно короткое предложение"}],
  "terms": [{"zh": "иероглифы", "ru": "как переводить", "note": "что это, коротко"}]
}
В characters — до 15 главных персонажей (сначала главные герои). В terms — до 15 важных мест, \
государств, титулов, сект и терминов. Иероглифы в zh — ровно как в тексте книги."""

CYR = re.compile(r"[А-Яа-яЁё]")


def book_sample(book, max_chars=12000):
    """Начало книги для справки: название, автор, описание и первые главы."""
    lines = [f"Название: {book['title']}", f"Автор: {book.get('author') or 'неизвестен'}"]
    if book.get("description"):
        lines.append("Описание: " + " ".join(book["description"]))
    lines.append("")
    size = sum(len(x) for x in lines)
    for ch in book["chapters"]:
        for line in [f"## {ch['title']}", *ch["paras"]]:
            if size + len(line) > max_chars:
                return "\n".join(lines)
            lines.append(line)
            size += len(line)
    return "\n".join(lines)


def _clean(v, limit=600):
    return re.sub(r"\s+", " ", str(v or "")).strip()[:limit]


def parse_card(text):
    m = re.search(r"\{.*\}", text or "", re.S)
    if not m:
        return None
    try:
        raw = json.loads(m.group(0))
    except ValueError:
        return None
    if not isinstance(raw, dict):
        return None
    card = {k: _clean(raw.get(k), 1500 if k == "synopsis" else 200)
            for k in ("title_ru", "title_literal", "title_en", "title_pinyin", "author_ru", "genre", "synopsis")}
    card["known"] = raw.get("known") is True
    card["characters"], card["terms"] = [], []
    for key, fields in (("characters", ("zh", "pinyin", "ru", "gender", "role")), ("terms", ("zh", "ru", "note"))):
        seen = set()
        for item in raw.get(key) or []:
            if not isinstance(item, dict):
                continue
            row = {f: _clean(item.get(f), 300) for f in fields}
            if not (HAN.search(row["zh"]) and CYR.search(row["ru"])) or row["zh"] in seen:
                continue
            seen.add(row["zh"])
            card[key].append(row)
        card[key] = card[key][:20]
    if not (card["title_ru"] or card["synopsis"] or card["characters"]):
        return None
    return card


def make_card(book, cache, api_key, model=DEFAULT_MODEL):
    """Справка о книге: русское название, о чём она, персонажи и термины. Кэшируется."""
    model = model or DEFAULT_MODEL
    sample = book_sample(book)
    key = "card:v1:" + model + ":" + hashlib.sha1(sample.encode()).hexdigest()
    cached = cache.get(key)
    if isinstance(cached, dict):
        return cached
    last = None
    for attempt in range(3):
        try:
            card = parse_card(openrouter_chat(api_key, model, [
                {"role": "system", "content": CARD_PROMPT},
                {"role": "user", "content": "Начало книги:\n\n" + sample}], temperature=0.2))
            if card:
                cache.put(key, card)
                return card
            last = "модель вернула справку в неверном формате"
        except FatalError:
            raise
        except Exception as e:  # noqa: BLE001
            last = e
        time.sleep(3 * (attempt + 1))
    raise RuntimeError(f"не удалось составить справку о книге: {last}")


def parse_glossary(text):
    pairs = {}
    for line in (text or "").splitlines():
        m = re.match(r"\s*(.+?)\s*[=＝]\s*(.+?)\s*$", line)
        if m:
            pairs[m.group(1)] = m.group(2)
    return pairs


def card_glossary(card):
    return "\n".join(f"{x['zh']} = {x['ru']}" for x in card.get("characters", []) + card.get("terms", []))


def merge_glossary(auto, user):
    """Глоссарий из справки + глоссарий пользователя (у пользователя приоритет)."""
    pairs = parse_glossary(auto)
    pairs.update(parse_glossary(user))
    return "\n".join(f"{k} = {v}" for k, v in pairs.items())


def apply_user_glossary(card, user):
    """Подставляет в справку имена из глоссария пользователя, чтобы справка и перевод совпадали."""
    pairs = parse_glossary(user)
    for row in card.get("characters", []) + card.get("terms", []):
        if row["zh"] in pairs:
            row["ru"] = pairs[row["zh"]]
    return card


def card_brief(card):
    """Справка в коротком виде для системного промпта переводчика."""
    lines = ["Справка о книге (для понимания контекста, не переводи её):"]
    if card.get("genre"):
        lines.append(f"Жанр: {card['genre']}.")
    if card.get("synopsis"):
        syn = card["synopsis"]
        lines.append("Сюжет: " + (syn if len(syn) <= 500 else syn[:500].rsplit(" ", 1)[0] + "…"))
    if card.get("characters"):
        lines.append("Персонажи:")
        for c in card["characters"]:
            g = {"м": "муж.", "ж": "жен."}.get(c.get("gender", "")[:1].lower(), "")
            lines.append(f"- {c['ru']} ({c['zh']})" + (f", {g}" if g else "") + (f": {c['role']}" if c.get("role") else ""))
    return "\n".join(lines)


def format_card(card, orig_title="", orig_author=""):
    """Справка о книге для сообщения в Telegram или консоли."""
    out = ["📚 Справка о книге", ""]
    title = card.get("title_ru") or orig_title
    out.append(f"Название: {title}")
    if orig_title:
        out.append(f"Оригинал: {orig_title}" + (f" ({card['title_pinyin']})" if card.get("title_pinyin") else ""))
    if card.get("title_literal") and card["title_literal"] != title:
        out.append(f"Дословно: {card['title_literal']}")
    if card.get("title_en"):
        out.append(f"По-английски: {card['title_en']}")
    if orig_author or card.get("author_ru"):
        a = card.get("author_ru") or ""
        out.append("Автор: " + (f"{a} ({orig_author})" if a and orig_author and a != orig_author else a or orig_author))
    if card.get("genre"):
        out.append(f"Жанр: {card['genre']}")
    if card.get("synopsis"):
        out += ["", "О чём: " + card["synopsis"]]
    if card.get("characters"):
        out += ["", "👥 Персонажи"]
        for c in card["characters"]:
            g = c.get("gender", "")[:1].lower()
            extra = ", ".join(x for x in (c.get("pinyin"), g + "." if g in ("м", "ж") else "") if x)
            out.append(f"• {c['ru']} — {c['zh']}" + (f" ({extra})" if extra else "")
                       + (f": {c['role']}" if c.get("role") else ""))
    if card.get("terms"):
        out += ["", "📍 Места и термины"]
        for t in card["terms"]:
            out.append(f"• {t['ru']} — {t['zh']}" + (f": {t['note']}" if t.get("note") else ""))
    out += ["", "ℹ️ Справку составила нейросеть " +
            ("по своим знаниям о книге и её первым главам." if card.get("known")
             else "только по первым главам: книгу она не узнала, сюжет описан по началу.") +
            " Эти имена будут использованы в переводе. Поправить имя: добавьте к ссылке строку «顾茫 = Гу Ман»."]
    return "\n".join(out)


def translate_book(book, translator, bilingual=False, progress=None):
    """Переводит название, автора, описание, заголовки глав и абзацы на месте."""
    texts = [book["title"], book["author"], *book["description"]]
    for ch in book["chapters"]:
        texts.append(ch["title"])
        texts.extend(ch["paras"])
    out = translator.translate(texts, progress)

    it = iter(out)
    book["orig_title"], book["title"] = book["title"], strip_notes(next(it))
    book["orig_author"], book["author"] = book["author"], strip_notes(next(it))
    card = book.get("card") or {}
    if card.get("title_ru"):
        book["title"] = card["title_ru"]
    if card.get("author_ru") and book["orig_author"]:
        book["author"] = card["author_ru"]
    book["description"] = [strip_notes(next(it)) for _ in book["description"]]
    for ch in book["chapters"]:
        ch["orig_title"], ch["title"] = ch["title"], strip_notes(next(it))
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
p.item{text-indent:0;margin-bottom:.4em}
sup{font-size:.7em;line-height:0}
sup a{text-decoration:none}
hr.notes{margin:2em 30% 1em 0;border:0;border-top:1px solid #999}
p.note{text-indent:0;font-size:.88em;margin-bottom:.6em}
"""


def about_body(card):
    esc = html.escape
    parts = ["<h1>О книге</h1>"]
    for label, key in (("Дословно", "title_literal"), ("По-английски", "title_en"), ("Жанр", "genre")):
        if card.get(key):
            parts.append(f'<p class="meta">{label}: {esc(card[key])}</p>')
    if card.get("synopsis"):
        parts.append(f"<p>{esc(card['synopsis'])}</p>")
    for head, key, note in (("Персонажи", "characters", "role"), ("Места и термины", "terms", "note")):
        if card.get(key):
            parts.append(f"<h2>{head}</h2>")
            for x in card[key]:
                zh = x["zh"] + (f", {x['pinyin']}" if x.get("pinyin") else "")
                parts.append(f'<p class="item"><b>{esc(x["ru"])}</b> ({esc(zh)})'
                             + (f" — {esc(x[note])}" if x.get(note) else "") + "</p>")
    return "\n".join(parts)


def render_para(text, state, asides):
    """Абзац в XHTML: метки [^k] становятся всплывающими сносками EPUB 3.
    Одно и то же выражение поясняется только при первом появлении в книге."""
    body, notes = split_notes(text)
    for k in notes:  # сноска есть, а метку модель забыла — ставим в конец абзаца
        if f"[^{k}]" not in body:
            body += f"[^{k}]"
    out, pos = [], 0
    for m in NOTE_REF.finditer(body):
        out.append(html.escape(body[pos:m.start()]))
        pos = m.end()
        note = notes.get(m.group(1))
        if not note:
            continue
        key = "".join(HAN.findall(note.split("(")[0])) or note[:40]
        if key in state["seen"]:
            continue
        state["seen"].add(key)
        state["n"] += 1
        n = state["n"]
        out.append(f'<sup><a epub:type="noteref" href="#fn{n}" id="fr{n}">{n}</a></sup>')
        head, sep, rest = note.partition(")")
        shown = (f"<b>{html.escape(head + sep)}</b>{html.escape(rest)}" if sep and HAN.search(head)
                 else html.escape(note))
        asides.append(f'<aside epub:type="footnote" id="fn{n}"><p class="note">'
                      f'<a href="#fr{n}">{n}</a>. {shown}</p></aside>')
    out.append(html.escape(body[pos:]))
    return "".join(out).replace("\n", "<br/>")


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
    if book.get("card"):
        files.append(("about", "about.xhtml", "О книге", xhtml("О книге", about_body(book["card"]), "ru")))

    note_state = {"n": 0, "seen": set()}
    for n, ch in enumerate(book["chapters"], 1):
        parts = [f"<h2>{esc(ch['title'])}</h2>"]
        if bilingual and ch.get("orig_title") and ch["orig_title"] != ch["title"]:
            parts.append(f'<p class="meta">{esc(ch["orig_title"])}</p>')
        orig = ch.get("orig")
        asides = []
        for i, p in enumerate(ch["paras"]):
            if orig and orig[i] != p:
                parts.append(f'<p class="orig">{esc(orig[i])}</p>')
            parts.append(f"<p>{render_para(p, note_state, asides)}</p>")
        if asides:
            parts.append('<hr class="notes"/>')
            parts.extend(asides)
        files.append((f"c{n:04d}", f"c{n:04d}.xhtml", ch["title"], xhtml(ch["title"], "\n".join(parts), lang)))

    cover = book.get("cover")
    cover_ext = {v: k for k, v in IMAGE_TYPES.items()}.get(cover[1], "jpg") if cover else ""
    cover_item = (f'<item id="cover-img" href="cover.{cover_ext}" media-type="{cover[1]}" properties="cover-image"/>'
                  if cover else "")
    card = book.get("card") or {}
    extra_meta = "".join(
        f"<dc:{tag}>{esc(value)}</dc:{tag}>\n" for tag, value in
        (("description", card.get("synopsis")), ("subject", card.get("genre"))) if value)
    if cover:
        extra_meta += '<meta name="cover" content="cover-img"/>\n'

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
{extra_meta}<meta property="dcterms:modified">{now}</meta>
</metadata>
<manifest>
<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
<item id="css" href="style.css" media-type="text/css"/>
{cover_item}
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
        if cover:
            z.writestr(f"OEBPS/cover.{cover_ext}", cover[0], compress_type=zipfile.ZIP_STORED)


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
    ap.add_argument("--no-notes", action="store_true", help="без сносок к идиомам и метафорам (OpenRouter)")
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
            key = os.environ.get("OPENROUTER_API_KEY", "")
            try:
                book["card"] = apply_user_glossary(make_card(book, cache, key, args.model), glossary)
                print(format_card(book["card"], orig_title, book["author"]))
            except FatalError:
                raise
            except Exception as e:  # noqa: BLE001 — без справки перевод всё равно возможен
                print(f"  справка не составлена: {e}")
            tr = OpenRouterTranslator(cache, key, args.model, orig_title, glossary, book.get("card"),
                                      notes=not args.no_notes)
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

#!/usr/bin/env python3
"""
Задача для GitHub Actions: собирает книгу (по ссылке или из присланного EPUB / FB2),
при необходимости переводит через OpenRouter и отправляет EPUB или FB2 в Telegram.

Параметры берутся из client_payload события repository_dispatch (для локальной проверки — из PAYLOAD):
  chat_id, status_id, mode ("orig" | "ru" | "bi"), url | file_id, file_name, limit, glossary,
  edit — {title, cover, thumb}: своё название книги и обложка (file_id картинки и её уменьшенной копии в Telegram),
  format ("epub" | "fb2"; у файлов — edit.format): в каком формате прислать книгу; по умолчанию — как у
  присланного файла, иначе epub. Передаётся, только если отличается: в client_payload не больше 10 полей,
  save — {url, key, sig}: куда сообщить о готовой книге, чтобы она попала в библиотеку бота
Режим "describe": ничего не собирает, а составляет описание загруженного EPUB / FB2 (название, автор, жанр,
о чём книга) и отправляет его в библиотеку по адресу из describe — {url, key, sig}.
"""
import json
import os
import sys
import tempfile
import time
import traceback
import urllib.request
import uuid
import zipfile

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "parser"))
import book2epub as b2e  # noqa: E402

TG_API = os.environ.get("TELEGRAM_API", "https://api.telegram.org")
TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")


def _payload():
    # В Actions параметры читаются из файла события: так они не попадают в публичный журнал запуска.
    if os.environ.get("PAYLOAD"):
        return json.loads(os.environ["PAYLOAD"])
    if os.environ.get("PAYLOAD_FILE"):
        with open(os.environ["PAYLOAD_FILE"], encoding="utf-8") as f:
            return json.load(f)
    with open(os.environ["GITHUB_EVENT_PATH"], encoding="utf-8") as f:
        return json.load(f).get("client_payload") or {}


P = _payload()
CHAT, STATUS = P.get("chat_id"), P.get("status_id")


def tg(method, **params):
    if not CHAT:  # сборка без Telegram (OUT_DIR): сообщения только в журнал
        print(method, params.get("text", ""), file=sys.stderr)
        return None
    req = urllib.request.Request(f"{TG_API}/bot{TOKEN}/{method}", data=json.dumps(params).encode(),
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read()).get("result")
    except Exception as e:  # noqa: BLE001 — статус в чате не должен ронять сборку
        print(f"Telegram {method}: {getattr(e, 'code', '')} {type(e).__name__}", file=sys.stderr)
        return None


MIME = {"epub": "application/epub+zip", "fb2": "application/x-fictionbook+xml"}


def send_document(path, filename, caption, thumb=None):
    boundary = uuid.uuid4().hex
    parts = []
    fields = [("chat_id", str(CHAT)), ("caption", caption)]
    if thumb:  # значок файла: Telegram принимает только новый JPEG до 320×320 и 200 КБ
        fields.append(("thumbnail", "attach://thumb"))
    for k, v in fields:
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode())
    with open(path, "rb") as f:
        data = f.read()
    fn = filename.replace('"', "")
    parts.append((f'--{boundary}\r\nContent-Disposition: form-data; name="document"; filename="{fn}"\r\n'
                  f"Content-Type: {MIME['fb2' if filename.lower().endswith('.fb2') else 'epub']}\r\n\r\n").encode() + data + b"\r\n")
    if thumb:
        parts.append((f'--{boundary}\r\nContent-Disposition: form-data; name="thumb"; filename="thumb.jpg"\r\n'
                      f"Content-Type: image/jpeg\r\n\r\n").encode() + thumb + b"\r\n")
    parts.append(f"--{boundary}--\r\n".encode())
    req = urllib.request.Request(f"{TG_API}/bot{TOKEN}/sendDocument", data=b"".join(parts),
                                 headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    with urllib.request.urlopen(req, timeout=300) as r:
        return json.loads(r.read())


def save_to_library(file_id, **info):
    """Сообщает воркеру о готовом файле: при повторном запросе бот отдаст его сразу."""
    save = P.get("save") or {}
    if not (save.get("url") and save.get("key") and file_id):
        return False
    body = json.dumps({"key": save["key"], "sig": save.get("sig", ""), "file_id": file_id, **info}).encode()
    req = urllib.request.Request(save["url"], data=body, headers={"Content-Type": "application/json",
                                                                 "User-Agent": "book-epub-bot"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status == 200
    except Exception as e:  # noqa: BLE001 — книга уже отправлена, библиотека не обязательна
        print(f"Библиотека: {getattr(e, 'code', '')} {type(e).__name__}", file=sys.stderr)
        return False


def send_text(text):
    """Отправляет длинный текст несколькими сообщениями (лимит Telegram — 4096 символов)."""
    chunk = ""
    for line in text.split("\n"):
        if len(chunk) + len(line) + 1 > 3900:
            tg("sendMessage", chat_id=CHAT, text=chunk)
            chunk = ""
        chunk += line[:3900] + "\n"
    if chunk.strip():
        tg("sendMessage", chat_id=CHAT, text=chunk)


_last = {"t": 0.0, "text": ""}


def status(text, force=False):
    """Редактирует сообщение-статус не чаще раза в 10 секунд."""
    now = time.time()
    if text == _last["text"] or (not force and now - _last["t"] < 10):
        return
    _last.update(t=now, text=text)
    if STATUS:
        tg("editMessageText", chat_id=CHAT, message_id=STATUS, text=text)
    else:
        tg("sendMessage", chat_id=CHAT, text=text)


def bar(done, total, width=12):
    filled = round(width * done / max(total, 1))
    return "▓" * filled + "░" * (width - filled) + f" {done}/{total}"


def trim_to_translated(book, orig, reason):
    """Оставляет главы с начала, переведённые целиком; на первой непереведённой книга обрывается."""
    keep = []
    for ch, src in zip(book["chapters"], orig):
        if any(b2e.HAN.search(o) and t == o for o, t in zip(src, ch["paras"])):
            break
        keep.append(ch)
    total = len(book["chapters"])
    book["chapters"] = keep
    book["partial_note"] = f"{reason}: глав {len(keep)} из {total}"
    if not keep:
        raise b2e.FatalError(f"{reason}: нет ни одной полностью переведённой главы.")


def money(x):
    return f"${x:.2f}" if x >= 0.01 else f"${x:.4f}"


def download(file_id, max_bytes=20 * 1024 * 1024):
    """Скачивает файл, присланный боту, по его file_id."""
    info = tg("getFile", file_id=file_id)
    if not info or not info.get("file_path"):
        raise b2e.FatalError("Telegram не отдал файл (бот может скачивать файлы до 20 МБ).")
    with urllib.request.urlopen(f"{TG_API}/file/bot{TOKEN}/{info['file_path']}", timeout=120) as r:
        return r.read(max_bytes + 1)


def load_upload(tmp, limit=None):
    """Скачивает присланный EPUB или FB2 (.fb2.zip) и читает его."""
    src = os.path.join(tmp, "in" + (".fb2" if b2e.is_fb2(P.get("file_name")) else ".epub"))
    with open(src, "wb") as f:
        f.write(download(P["file_id"]))
    try:
        return b2e.load_from_file(src, limit)
    except (ValueError, KeyError, zipfile.BadZipFile) as e:
        raise b2e.FatalError(f"Не удалось прочитать файл: {e}") from None


def user_cover(edit):
    """Своя обложка из меню «✏️ Изменить»: ((байты, тип), значок JPEG или None) или (None, None)."""
    if not edit.get("cover"):
        return None, None
    try:
        data = download(edit["cover"])
        mtype = b2e.image_type(data)
        if not mtype:
            send_text("⚠️ Обложка не похожа на картинку JPG/PNG — собираю без неё.")
            return None, None
        thumb = download(edit["thumb"], 200 * 1024) if edit.get("thumb") else None
        return (data, mtype), thumb
    except Exception as e:  # noqa: BLE001 — без своей обложки книга всё равно соберётся
        print(f"Обложка: {type(e).__name__}: {e}", file=sys.stderr)
        send_text("⚠️ Не удалось скачать обложку — собираю без неё.")
        return None, None


def post_json(url, body):
    req = urllib.request.Request(url, data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json", "User-Agent": "book-epub-bot"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status == 200
    except Exception as e:  # noqa: BLE001
        print(f"Библиотека: {getattr(e, 'code', '')} {type(e).__name__}", file=sys.stderr)
        return False


def describe():
    """Описание загруженного EPUB для библиотеки: настоящее название, автор, жанр, о чём книга."""
    note = P.get("status_text") or ""

    def done(line):  # дописываем итог к сообщению «Сохранено в библиотеку»
        if STATUS:
            tg("editMessageText", chat_id=CHAT, message_id=STATUS, text=(note + "\n" + line).strip()[:4000])

    dest = P.get("describe") or {}
    api_key = os.environ.get("OPENROUTER_API_KEY", "")
    if not api_key or not dest.get("url"):
        return done("📝 Описание не составлено: не задан ключ OpenRouter.")
    tmp = tempfile.mkdtemp()
    try:
        book = load_upload(tmp, limit=8)
    except Exception as e:  # noqa: BLE001 — нет текста, битый файл и т. п.
        print(f"EPUB: {type(e).__name__}: {e}", file=sys.stderr)
        return done("📝 Описание не составлено: не получилось прочитать текст книги.")
    book["source"] = P.get("file_name") or "book.epub"
    usage = b2e.Usage()
    try:
        card = b2e.describe_book(book, api_key, os.environ.get("OPENROUTER_MODEL") or b2e.DEFAULT_MODEL, usage)
    except b2e.FatalError as e:  # неверный ключ, нет денег и т. п.
        return done(f"📝 Описание не составлено: {e}"[:300])
    print("OpenRouter:", usage.summary(), file=sys.stderr)
    if not card:
        return done("📝 Описание не составлено: модель не ответила, попробуйте позже из библиотеки.")
    ok = post_json(dest["url"], {"key": dest.get("key"), "sig": dest.get("sig"), "card": card})
    if not ok:
        return done("📝 Описание составлено, но бот не смог его сохранить.")
    who = card.get("author") or card.get("author_orig")
    done(f"📝 «{card.get('title') or book['title']}»" + (f", {who}" if who else "") +
         (f" · {card['genre']}" if card.get("genre") else "") + " — описание добавлено в библиотеку.")


def main():
    if P.get("mode") == "describe":
        return describe()
    if not os.environ.get("OUT_DIR") and (not TOKEN or not CHAT):
        sys.exit("Нет TELEGRAM_BOT_TOKEN или chat_id")
    mode = P.get("mode", "orig")
    limit = int(P["limit"]) if str(P.get("limit") or "").isdigit() else None
    cache = b2e.Cache(os.environ.get("BOOK_CACHE", ".book2epub_cache"))
    tmp = tempfile.mkdtemp()

    def progress(stage, done, total):
        label = "📥 Загружаю главы" if stage == "download" else "🈯 Перевожу"
        status(f"{label}\n{bar(done, total)}", force=done == total)

    status("⚙️ Начинаю…", force=True)
    api_key = os.environ.get("OPENROUTER_API_KEY", "")
    model = os.environ.get("OPENROUTER_MODEL") or b2e.DEFAULT_MODEL
    glossary = P.get("glossary") or ""
    edit = P.get("edit") if isinstance(P.get("edit"), dict) else {}
    cover, thumb = user_cover(edit)

    if P.get("file_id"):
        book = load_upload(tmp, limit)
        book["source"] = P.get("file_name") or "book.epub"
        head = book
    else:
        status("📖 Читаю начало книги…", force=True)
        # Сначала только первые главы — для справки; потом они возьмутся из кэша.
        head = b2e.load_from_site(P["url"], cache, min(limit or 3, 3))

    # Своё название: из меню «✏️ Изменить» или строкой глоссария «原题 = Русское название».
    title = str(edit.get("title") or "").strip()[:200] or b2e.parse_glossary(glossary).get(head["title"], "")

    # Справка о книге: русское название, о чём она, персонажи. Приходит сразу, до перевода.
    card = tr_card = None
    if api_key:
        status("🔎 Составляю справку о книге…", force=True)
        try:
            tr_card = b2e.apply_user_glossary(b2e.make_card(head, cache, api_key, model), glossary)
            # Переводчику — справка как есть (её текст входит в ключ кэша переводов), а своё название он
            # получит отдельно; в справку для читателя и в её глоссарий — своё название.
            card = b2e.apply_title(tr_card, head["title"], title) if title else tr_card
            if not P.get("cached_only"):
                send_text(b2e.format_card(card, head["title"], head.get("author", "")))
        except b2e.FatalError:
            if mode != "orig":
                raise
        except Exception as e:  # noqa: BLE001 — без справки книга всё равно соберётся
            print(f"Справка: {type(e).__name__}: {e}", file=sys.stderr)
            send_text("⚠️ Справку о книге составить не удалось, перевожу без неё.")

    if not P.get("file_id"):
        book = b2e.load_from_site(P["url"], cache, limit, progress=progress)
    book["card"] = card
    if cover:
        book["cover"] = cover
    if str(P.get("from") or "").isdigit():  # для проверки: начать с главы N (вместе с limit — отрезок книги)
        book["chapters"] = book["chapters"][int(P["from"]) - 1:]

    orig_title, n = book["title"], len(book["chapters"])
    status(f"📚 «{orig_title}» — глав: {n}", force=True)

    missed, lang, usage_note = 0, "zh", ""
    if mode in ("ru", "bi"):
        budget = str(P.get("budget") or os.environ.get("TRANSLATE_BUDGET_USD") or "").strip().lstrip("$")
        tr = b2e.OpenRouterTranslator(cache, api_key, model, orig_title, glossary, tr_card,
                                      notes=P.get("notes") is not False,
                                      budget=float(budget) if budget.replace(".", "", 1).isdigit() else None,
                                      title=title or None)
        orig = [list(ch["paras"]) for ch in book["chapters"]]
        if P.get("cached_only"):  # только то, что уже есть в кэше: к модели не обращаемся
            tr._batch = lambda texts, context=(): [None] * len(texts)
        t0 = [0.0]

        def plan(total, cached, chars):
            t0[0] = time.time()
            if P.get("cached_only"):
                return
            left = total - cached
            msg = f"📊 Абзацев: {total}, уже переведено раньше: {cached}, осталось: {left} (~{chars // 1000} тыс. иероглифов)."
            if left:
                msg += f"\nЗапросов к модели: ~{max(1, chars // tr.max_chars + 1)}. Стоимость покажу после первых ответов."
            if tr.budget:
                msg += f"\nЛимит расходов: ${tr.budget:g} — дойдя до него, пришлю готовую часть."
            send_text(msg)

        def tprogress(stage, done, total):
            if stage != "translate":
                return progress(stage, done, total)
            u, lines = tr.usage, [f"🈯 Перевожу\n{bar(done, total)}"]
            if u.calls and done:
                share = done / total
                mins = (time.time() - t0[0]) / share * (1 - share) / 60
                lines.append(f"💰 {money(u.cost)} · на всё ≈{money(u.cost / share)} · осталось ≈{mins:.0f} мин")
            status("\n".join(lines), force=done == total)

        tr.on_plan = plan
        missed = b2e.translate_book(book, tr, bilingual=(mode == "bi"), progress=tprogress)
        print("OpenRouter:", tr.usage.summary(), file=sys.stderr)
        if P.get("cached_only"):
            trim_to_translated(book, orig, "Готовая часть перевода")
            missed = 0
        elif tr.stop_reason:
            trim_to_translated(book, orig, f"Остановлено ({tr.stop_reason}), пришлите ещё раз — продолжу")
            missed = 0
        usage_note = tr.usage.summary() if tr.usage.calls else ""
        lang = "ru"

    if title:
        book["orig_title"], book["title"] = orig_title, title
    fmt = P.get("format") or edit.get("format") or ("fb2" if b2e.is_fb2(P.get("file_name")) else "epub")
    fmt = fmt if fmt in ("epub", "fb2") else "epub"
    status(f"📦 Собираю {fmt.upper()}…", force=True)
    suffix = {"orig": "", "ru": "_ru", "bi": "_zh-ru"}[mode]
    name = b2e.safe_filename(book["title"]) + suffix + "." + fmt
    # Длинная книга (больше 140 тыс. знаков китайского текста) делится на несколько томов.
    parts = b2e.split_book(book, int(os.environ.get("MAX_PART_CHARS") or b2e.MAX_PART_CHARS), lang)
    outs = []
    for k, part in enumerate(parts, 1):
        out = os.path.join(tmp, f"book_{k}.{fmt}")
        b2e.build_book(out, part, lang, fmt)
        outs.append((out, b2e.part_filename(name, part) if len(parts) > 1 else name, part))

    notes = []
    if book["failed"]:
        notes.append(f"⚠️ не загрузились главы: {len(book['failed'])}")
    if missed:
        notes.append(f"⚠️ не переведено фрагментов: {missed} (пришлите задачу ещё раз — допереведу)")
    if book.get("partial_note"):
        notes.append("✂️ " + book["partial_note"])
    if usage_note:
        notes.append("💰 " + usage_note)
    n = len(book["chapters"])
    caption = f"📖 {book['title']}" + (f" ({orig_title})" if book["title"] != orig_title else "") + f"\nГлав: {n}"
    if len(parts) > 1:
        n_parts = len(parts)
        word = "книги" if n_parts % 10 in (2, 3, 4) and n_parts % 100 not in (12, 13, 14) else "книг"
        caption += f"\n📚 Разбита на {n_parts} {word} — длиннее {b2e.MAX_PART_CHARS // 1000} тыс. знаков"
    if notes:
        caption += "\n" + "\n".join(notes)

    def part_caption(k, part):
        if len(parts) == 1:
            return caption
        head = f"📕 Книга {k} из {len(parts)}: главы {part['chapters'][0]['title']} — {part['chapters'][-1]['title']}"
        return (caption + "\n" + head) if k == len(parts) else head

    if os.environ.get("OUT_DIR"):
        import shutil
        os.makedirs(os.environ["OUT_DIR"], exist_ok=True)
        for out, fname, _ in outs:
            shutil.copy(out, os.path.join(os.environ["OUT_DIR"], fname))
        with open(os.path.join(os.environ["OUT_DIR"], "caption.txt"), "w", encoding="utf-8") as f:
            f.write(caption)
        return
    if book.get("cover") and not thumb:
        thumb = b2e.make_thumbnail(book["cover"][0])
    file_ids = []
    for k, (out, fname, part) in enumerate(outs, 1):
        sent = send_document(out, fname, part_caption(k, part)[:1000], thumb)
        file_ids.append((((sent or {}).get("result") or {}).get("document") or {}).get("file_id"))
    saved = False
    # Неполную книгу не сохраняем: повторный запрос её допереведёт.
    complete = not book["failed"] and not missed and not book.get("partial_note") and not P.get("cached_only")
    if complete and all(file_ids):
        c = card or {}
        # Без строки о расходах: при повторной выдаче из библиотеки за перевод уже не платят.
        lib_caption = "\n".join(x for x in caption.split("\n") if not x.startswith("💰"))
        names = [c.get(k) for k in ("title_ru", "title_ai", "title_literal", "title_en", "title_pinyin", "author_ru")]
        names.append(book.get("author") or head.get("author"))
        if P.get("file_name"):
            names.append(os.path.splitext(P["file_name"])[0])
        request = {k: P[k] for k in ("mode", "url", "file_id", "file_name", "limit", "glossary", "notes", "edit",
                                       "format")
                   if k in P}
        # Справка для карточки книги в мини-приложении.
        info = {"author": c.get("author_ru") or book.get("author") or head.get("author"),
                "orig_author": book.get("orig_author") or head.get("author"), "genre": c.get("genre"),
                "synopsis": c.get("synopsis"), "title_en": c.get("title_en"),
                "title_literal": c.get("title_literal"), "title_pinyin": c.get("title_pinyin")}
        saved = save_to_library(file_ids[0], file_ids=file_ids, title=book["title"], orig_title=orig_title,
                                mode=mode, chapters=n, caption=lib_caption[:1000], names=[x for x in names if x],
                                request=request, info={k: v for k, v in info.items() if v})
    status("✅ Готово" + (" — с замечаниями, см. подпись к файлу" if not complete else "")
           + (" · 📚 сохранено в библиотеке" if saved else ""), force=True)


if __name__ == "__main__":
    try:
        main()
    except b2e.FatalError as e:
        status(f"❌ {e}", force=True)
        sys.exit(1)
    except Exception as e:  # noqa: BLE001
        traceback.print_exc()
        status(f"❌ Ошибка: {e}"[:500], force=True)
        sys.exit(1)

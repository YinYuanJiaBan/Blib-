#!/usr/bin/env python3
"""
Задача для GitHub Actions: собирает книгу (по ссылке или из присланного EPUB),
при необходимости переводит через OpenRouter и отправляет EPUB в Telegram.

Параметры берутся из client_payload события repository_dispatch (для локальной проверки — из PAYLOAD):
  chat_id, status_id, mode ("orig" | "ru" | "bi"), url | file_id, file_name, limit, glossary
"""
import json
import os
import sys
import tempfile
import time
import traceback
import urllib.request
import uuid

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "parser"))
import book2epub as b2e  # noqa: E402

TG_API = os.environ.get("TELEGRAM_API", "https://api.telegram.org")
TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")


def _payload():
    # В Actions параметры читаются из файла события: так они не попадают в публичный журнал запуска.
    if os.environ.get("PAYLOAD"):
        return json.loads(os.environ["PAYLOAD"])
    with open(os.environ["GITHUB_EVENT_PATH"], encoding="utf-8") as f:
        return json.load(f).get("client_payload") or {}


P = _payload()
CHAT, STATUS = P.get("chat_id"), P.get("status_id")


def tg(method, **params):
    req = urllib.request.Request(f"{TG_API}/bot{TOKEN}/{method}", data=json.dumps(params).encode(),
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read()).get("result")
    except Exception as e:  # noqa: BLE001 — статус в чате не должен ронять сборку
        print(f"Telegram {method}: {getattr(e, 'code', '')} {type(e).__name__}", file=sys.stderr)
        return None


def send_document(path, filename, caption):
    boundary = uuid.uuid4().hex
    parts = []
    for k, v in (("chat_id", str(CHAT)), ("caption", caption)):
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode())
    with open(path, "rb") as f:
        data = f.read()
    fn = filename.replace('"', "")
    parts.append((f'--{boundary}\r\nContent-Disposition: form-data; name="document"; filename="{fn}"\r\n'
                  f"Content-Type: application/epub+zip\r\n\r\n").encode() + data + b"\r\n")
    parts.append(f"--{boundary}--\r\n".encode())
    req = urllib.request.Request(f"{TG_API}/bot{TOKEN}/sendDocument", data=b"".join(parts),
                                 headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    with urllib.request.urlopen(req, timeout=300) as r:
        return json.loads(r.read())


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


def main():
    if not TOKEN or not CHAT:
        sys.exit("Нет TELEGRAM_BOT_TOKEN или chat_id")
    mode = P.get("mode", "orig")
    limit = int(P["limit"]) if str(P.get("limit") or "").isdigit() else None
    cache = b2e.Cache(os.environ.get("BOOK_CACHE", ".book2epub_cache"))
    tmp = tempfile.mkdtemp()

    def progress(stage, done, total):
        label = "📥 Загружаю главы" if stage == "download" else "🈯 Перевожу"
        status(f"{label}\n{bar(done, total)}", force=done == total)

    status("⚙️ Начинаю…", force=True)
    if P.get("file_id"):
        info = tg("getFile", file_id=P["file_id"])
        if not info or not info.get("file_path"):
            raise b2e.FatalError("Telegram не отдал файл (бот может скачивать файлы до 20 МБ).")
        src = os.path.join(tmp, "in.epub")
        with urllib.request.urlopen(f"{TG_API}/file/bot{TOKEN}/{info['file_path']}", timeout=120) as r, \
                open(src, "wb") as f:
            f.write(r.read())
        book = b2e.load_from_epub(src, limit)
        book["source"] = P.get("file_name") or "book.epub"
    else:
        status("📖 Читаю оглавление…", force=True)
        book = b2e.load_from_site(P["url"], cache, limit, progress=progress)

    orig_title, n = book["title"], len(book["chapters"])
    status(f"📚 «{orig_title}» — глав: {n}", force=True)

    missed, lang = 0, "zh"
    if mode in ("ru", "bi"):
        tr = b2e.OpenRouterTranslator(cache, os.environ.get("OPENROUTER_API_KEY", ""),
                                      os.environ.get("OPENROUTER_MODEL") or b2e.DEFAULT_MODEL,
                                      orig_title, P.get("glossary") or "")
        missed = b2e.translate_book(book, tr, bilingual=(mode == "bi"), progress=progress)
        lang = "ru"

    status("📦 Собираю EPUB…", force=True)
    suffix = {"orig": "", "ru": "_ru", "bi": "_zh-ru"}[mode]
    name = b2e.safe_filename((book["title"] if mode != "orig" else orig_title)) + suffix + ".epub"
    out = os.path.join(tmp, "book.epub")
    b2e.build_epub(out, book, lang)

    notes = []
    if book["failed"]:
        notes.append(f"⚠️ не загрузились главы: {len(book['failed'])}")
    if missed:
        notes.append(f"⚠️ не переведено фрагментов: {missed} (пришлите задачу ещё раз — допереведу)")
    caption = f"📖 {book['title']}" + (f" ({orig_title})" if book["title"] != orig_title else "") + f"\nГлав: {n}"
    if notes:
        caption += "\n" + "\n".join(notes)
    send_document(out, name, caption[:1000])
    status("✅ Готово" + (" — с замечаниями, см. подпись к файлу" if notes else ""), force=True)


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

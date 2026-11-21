// Telegram-бот «Книга в EPUB / FB2» — Cloudflare Worker.
// Принимает сообщения от Telegram и ставит задачу в GitHub Actions,
// а там книга собирается, переводится и присылается в чат.
//
// Переменные воркера (Settings → Variables and Secrets):
//   BOT_TOKEN      — токен бота от @BotFather                    (Secret)
//   WEBHOOK_SECRET — любая длинная случайная строка               (Secret)
//   GH_TOKEN       — GitHub-токен с доступом Contents: write      (Secret)
//   GH_REPO        — репозиторий, например YinYuanJiaBan/Blib-    (Text)
//   ALLOWED_USERS  — ваш Telegram ID (через запятую, если несколько) (Text)
//   BOOKS          — KV-хранилище библиотеки готовых книг (KV binding, необязательно;
//                    при автодеплое создаётся само)

const HELP =
  "📚 Я собираю книги с kanunu8.com в EPUB или FB2 и перевожу их на русский.\n\n" +
  "• Пришлите ссылку на оглавление книги.\n" +
  "• Или пришлите файл .epub или .fb2 (.fb2.zip), и я его переведу. Книга вернётся в том же формате.\n\n" +
  "Дополнительно в том же сообщении (необязательно):\n" +
  "• «fb2» или «epub» — в каком формате прислать книгу (по ссылке по умолчанию EPUB)\n" +
  "• число — сколько первых глав взять, например: 3\n" +
  "• глоссарий имён, по строке на имя: 顾茫 = Гу Ман\n" +
  "• «без сносок» — не пояснять идиомы и метафоры\n\n" +
  "Перед сборкой я спрошу, хотите ли вы внести изменения: можно задать своё название книги " +
  "(например, «Остатки грязи» вместо дословного «Остатки скверны») и свою обложку. " +
  "Своё название попадёт в справку о книге и в глоссарий перевода, обложка — в саму книгу и в библиотеку. " +
  "Ещё можно прислать картинку с подписью-ссылкой: картинка станет обложкой.\n\n" +
  "В переводе идиомы (成语), метафоры и аллюзии получают сноски: иероглифы, пиньинь, " +
  "дословный перевод и настоящий смысл. В книге сноска открывается нажатием на номер.\n\n" +
  "Сначала придёт справка о книге: русское название, о чём она, персонажи и термины. " +
  "Эти имена бот сам использует в переводе. Если имя не нравится, добавьте свою строку в глоссарий.\n\n" +
  "Перевод делает DeepSeek через OpenRouter. Готовый файл придёт сюда же.\n\n" +
  "📚 Готовые книги сохраняются: если попросить ту же книгу ещё раз, файл придёт сразу, " +
  "без нового перевода. Можно просто написать название (русское, китайское или английское) " +
  "или автора, и я найду книгу в библиотеке. /library — все сохранённые книги.\n\n" +
  "📥 Готовый EPUB или FB2 можно просто положить в библиотеку, без перевода: пришлите файл и нажмите " +
  "«Сохранить в библиотеку». Чтобы загрузить сразу много книг, включите /upload — " +
  "тогда каждый присланный EPUB или FB2 сохраняется сам.";

const BUTTONS = {
  orig: "📖 Оригинал",
  ru: "🇷🇺 Перевод",
  bi: "🔀 Китайский + русский",
  lib: "📥 Сохранить в библиотеку"
};
const ICONS = { orig: "📖", ru: "🇷🇺", bi: "🔀", lib: "📗" };
let ORIGIN = "";  // адрес воркера; задача из Actions сообщает по нему о готовой книге

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    ORIGIN = url.origin;

    // Однократная настройка: откройте /setup?key=<WEBHOOK_SECRET> в браузере.
    if (url.pathname === "/setup") {
      if (!env.WEBHOOK_SECRET || url.searchParams.get("key") !== env.WEBHOOK_SECRET)
        return new Response("Нужен параметр ?key= со значением WEBHOOK_SECRET", { status: 403 });
      const hook = await tg(env, "setWebhook", {
        url: `${url.origin}/webhook`,
        secret_token: env.WEBHOOK_SECRET,
        allowed_updates: ["message", "callback_query"],
        drop_pending_updates: true
      });
      await tg(env, "setChatMenuButton", { menu_button: appButton() });
      await tg(env, "setMyCommands", { commands: [
        { command: "help", description: "Как пользоваться" },
        { command: "library", description: "Сохранённые книги" },
        { command: "upload", description: "Режим загрузки готовых EPUB и FB2 в библиотеку" },
        { command: "id", description: "Мой Telegram ID" }
      ] });
      const check = [
        ["BOT_TOKEN", !!env.BOT_TOKEN], ["WEBHOOK_SECRET", !!env.WEBHOOK_SECRET],
        ["GH_TOKEN", !!env.GH_TOKEN], ["GH_REPO", !!env.GH_REPO], ["ALLOWED_USERS", !!env.ALLOWED_USERS],
        ["BOOKS (библиотека, необязательно)", !!env.BOOKS]
      ].map(([k, ok]) => `${ok ? "✅" : "❌"} ${k}`).join("\n");
      return new Response(`Webhook: ${hook?.ok ? "✅ установлен" : "❌ " + (hook?.description || "ошибка")}\n\n${check}`,
        { headers: { "content-type": "text/plain; charset=utf-8" } });
    }

    // Мини-приложение «Библиотека» (Telegram Web App) и его API.
    if (url.pathname === "/app")
      return new Response(APP_HTML, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } });
    if (url.pathname.startsWith("/api/")) {
      try { return await onApi(env, request, url); }
      catch (e) { console.log("api", e && e.stack || e); return json({ error: "Ошибка сервера" }, 500); }
    }
    if (url.pathname.startsWith("/cover/")) return onCover(env, url);

    // Сюда задача из GitHub Actions сообщает о готовой книге, чтобы сохранить её в библиотеке.
    if (url.pathname === "/saved" && request.method === "POST") return onSaved(env, request);
    if (url.pathname === "/info" && request.method === "POST") return onInfo(env, request);

    if (url.pathname === "/webhook" && request.method === "POST") {
      if (request.headers.get("x-telegram-bot-api-secret-token") !== env.WEBHOOK_SECRET)
        return new Response("forbidden", { status: 403 });
      const update = await request.json();
      try {
        if (update.message) await onMessage(env, update.message);
        else if (update.callback_query) await onCallback(env, update.callback_query);
      } catch (e) {
        console.log("error", e && e.stack || e);
      }
      return new Response("ok");
    }

    return new Response("Book EPUB bot is running", { headers: { "content-type": "text/plain; charset=utf-8" } });
  }
};

// ---------------------------------------------------------------- Telegram
async function tg(env, method, body) {
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
  });
  return r.json().catch(() => null);
}

const say = (env, chat_id, text, extra = {}) => tg(env, "sendMessage", { chat_id, text, ...extra });

function allowed(env, userId) {
  const list = String(env.ALLOWED_USERS || "").split(/[\s,]+/).filter(Boolean);
  return list.includes(String(userId));
}

// ---------------------------------------------------------------- разбор запроса
const LINK = /https?:\/\/(?:www\.)?kanunu8\.com\/[^\s]+/i;

function parseRequest(text) {
  const link = (text.match(LINK) || [])[0];
  const rest = text.replace(LINK, " ");
  const glossary = rest.split("\n").map((l) => l.trim()).filter((l) => /\S\s*[=＝]\s*\S/.test(l)).join("\n");
  const noGloss = rest.split("\n").filter((l) => !/[=＝]/.test(l)).join(" ");
  const limit = (noGloss.match(/(?:^|\s)(\d{1,4})(?:\s|$)/) || [])[1] || "";
  const notes = !/без\s+сносок/i.test(noGloss);
  const format = (noGloss.match(/(?:^|[^\wа-яё.])(fb2|epub)(?![\wа-яё])/i) || [])[1] || "";
  return { link, glossary: glossary.slice(0, 3000), limit, notes, format: format.toLowerCase() };
}

// ---------------------------------------------------------------- обработчики
async function onMessage(env, msg) {
  const chat = msg.chat.id;
  const user = msg.from && msg.from.id;
  const text = (msg.text || msg.caption || "").trim();

  if (text.startsWith("/id")) return say(env, chat, `Ваш Telegram ID: ${user}`);
  if (!allowed(env, user)) {
    return say(env, chat, `🔒 Это личный бот.\nВаш Telegram ID: ${user}\n` +
      `Если это ваш бот, впишите этот номер в переменную ALLOWED_USERS воркера.`);
  }
  if (text.startsWith("/start") || text.startsWith("/help")) {
    await tg(env, "setChatMenuButton", { chat_id: chat, menu_button: appButton() });
    return say(env, chat, HELP);
  }
  if (text.startsWith("/library") || text.startsWith("/books")) {
    const q = text.replace(/^\/\S+\s*/, "");
    return q ? findBooks(env, chat, q) : showLibrary(env, chat);
  }
  if (text.startsWith("/upload")) return toggleUpload(env, chat);

  // Ответ на вопрос бота «напишите название» / «пришлите обложку».
  const r = msg.reply_to_message;
  if (env.BOOKS && r && r.from && r.from.is_bot && PROMPT.test(r.text || "")) return onEditReply(env, msg, r);

  const req = parseRequest(text);
  const image = pickImage(msg);
  if (image && !req.link) {
    return say(env, chat, "🖼 Чтобы сделать картинку обложкой, нажмите «🖼 Обложка» в меню изменений книги " +
      "и пришлите её ответом на моё сообщение. Или пришлите картинку с подписью — ссылкой на книгу.");
  }

  const doc = image ? null : msg.document;
  if (doc) {
    const kind = fileKind(doc.file_name);
    if (!kind) return say(env, chat, "Я понимаю только файлы .epub, .fb2 и .fb2.zip.");
    const label = kind.toUpperCase() + (req.format && req.format !== kind ? ` → пришлю в ${req.format.toUpperCase()}` : "");
    // Режим загрузки (/upload) или подпись «в библиотеку» — сразу сохраняем, ничего не спрашивая.
    if (env.BOOKS && (/в\s+библиотеку/i.test(text) || await env.BOOKS.get("upload:" + chat)))
      return saveUpload(env, chat, doc, msg.message_id);
    const big = doc.file_size > 20 * 1024 * 1024;
    if (big && !env.BOOKS) return say(env, chat, "Файл больше 20 МБ, Telegram не даст боту его скачать.");
    const modes = big ? ["lib"] : env.BOOKS ? ["ru", "bi", "lib"] : ["ru", "bi"];
    if (env.BOOKS && !big) {
      const src = { file_id: doc.file_id, file_name: doc.file_name || "book.epub",
        uid: doc.file_unique_id || doc.file_id, size: doc.file_size || 0 };
      return offerEdits(env, msg, { src, req, modes }, "📘 " + (doc.file_name || kind.toUpperCase()) +
        (label !== kind.toUpperCase() ? "\n" + label : ""));
    }
    return ask(env, msg, modes, `Что сделать с этим ${label}?` +
      (big ? "\nФайл больше 20 МБ: перевести его не получится, но в библиотеку сохранить можно." : ""));
  }

  if (req.link) {
    const info = (req.format === "fb2" ? "\nФормат: FB2" : "") + (req.limit ? `\nГлав: первые ${req.limit}` : "") + (req.notes ? "" : "\nБез сносок") +
      (req.glossary ? `\nСтрок в глоссарии: ${req.glossary.split("\n").length}` : "");
    if (env.BOOKS) {
      const draft = { src: { url: req.link }, req, modes: ["orig", "ru", "bi"] };
      if (image) Object.assign(draft, image);
      return offerEdits(env, msg, draft, "🔗 Книга по ссылке" + info);
    }
    return ask(env, msg, ["orig", "ru", "bi"], "Как собрать книгу?" + info);
  }

  // Без ссылки — ищем книгу в библиотеке по названию или автору.
  if (text && !text.startsWith("/")) return findBooks(env, chat, text);

  return say(env, chat, "Пришлите ссылку на оглавление книги с kanunu8.com, файл .epub / .fb2 или название книги.\n/help — подробнее");
}

// Формат ответа: указанный в сообщении, иначе как у присланного файла, иначе EPUB.
// В client_payload GitHub — не больше 10 полей, поэтому формат передаётся, только когда он
// отличается от того, что задача поймёт сама (по имени файла), а у файлов — внутри edit.
function setFormat(payload, wanted) {
  const own = fileKind(payload.file_name) || "epub";
  const format = wanted || own;
  if (format !== own) {
    if (payload.file_id) payload.edit = { ...(payload.edit || {}), format };
    else payload.format = format;
  }
  return format;
}

// "epub" | "fb2" по имени файла, иначе "".
function fileKind(name) {
  if (/\.epub$/i.test(name || "")) return "epub";
  if (/\.fb2(\.zip)?$/i.test(name || "")) return "fb2";
  return "";
}

function ask(env, msg, modes, text) {
  return say(env, msg.chat.id, text, {
    reply_to_message_id: msg.message_id,
    reply_markup: { inline_keyboard: modes.map((m) => [{ text: BUTTONS[m], callback_data: "go:" + m }]) }
  });
}

async function onCallback(env, cq) {
  const done = (text) => tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text });
  if (!allowed(env, cq.from.id)) return done("🔒 Это личный бот");
  const [action, arg, extra] = (cq.data || "").split(":");
  const msg = cq.message;

  // Меню изменений перед сборкой (черновик задачи лежит в KV).
  if (["ed", "nx", "et", "ec", "ex"].includes(action) || (action === "go" && extra)) {
    const id = action === "go" ? extra : arg;
    const draft = env.BOOKS && await env.BOOKS.get("draft:" + id, "json");
    if (!draft) return done("Меню устарело — пришлите книгу ещё раз");
    const edit = (text, buttons) => tg(env, "editMessageText", { chat_id: msg.chat.id, message_id: msg.message_id,
      text, reply_markup: { inline_keyboard: buttons } });
    if (action === "ed") {
      await edit(editText(draft), editButtons(id, draft));
      return done();
    }
    if (action === "ex") {
      const next = { ...draft, cover: null, thumb: null };
      await edit(editText(next), editButtons(await saveDraft(env, next), next));
      return done("Обложка убрана");
    }
    if (action === "et" || action === "ec") {
      const title = action === "et";
      const p = await say(env, msg.chat.id, title
        ? "📝 Напишите новое название книги ответом на это сообщение.\nНапример: Остатки грязи\n" +
          "Оно будет в справке о книге и в глоссарии перевода, на титульной странице, в названии файла и в библиотеке. " +
          "Чтобы вернуть название от нейросети, ответьте «-»."
        : "🖼 Пришлите картинку для обложки ответом на это сообщение: фото или файл JPG/PNG.",
        { reply_markup: { force_reply: true, input_field_placeholder: title ? "Новое название" : "Картинка" } });
      const pid = p && p.result && p.result.message_id;
      if (!pid) return done("Не получилось");
      await env.BOOKS.put(`wait:${msg.chat.id}:${pid}`, JSON.stringify({ draft: id, field: title ? "title" : "cover",
        menu: msg.message_id }), { expirationTtl: 86400 });
      return done();
    }
    if (action === "nx" && !draft.mode) {
      // С изменениями «просто сохранить в библиотеку» не подходит: книгу надо собрать заново.
      const modes = draft.title || draft.cover ? draft.modes.filter((m) => m !== "lib") : draft.modes;
      await edit(modesText(draft), modes.map((m) => [{ text: BUTTONS[m], callback_data: `go:${m}:${id}` }]));
      return done();
    }
    const mode = action === "go" ? arg : draft.mode;
    if (!BUTTONS[mode]) return done("Неизвестная команда");
    if (mode === "lib") {
      const s = draft.src;
      await tg(env, "editMessageReplyMarkup", { chat_id: msg.chat.id, message_id: msg.message_id,
        reply_markup: { inline_keyboard: [] } });
      await saveUpload(env, msg.chat.id, { file_id: s.file_id, file_unique_id: s.uid, file_name: s.file_name,
        file_size: s.size || 0 }, null, msg.message_id);
      return done("Готово");
    }
    return done(await startDraft(env, msg, draft, mode) ? "Запущено!" : "Ошибка запуска");
  }
  // «✏️ Изменить» под книгой из библиотеки.
  if (action === "chg") {
    const r = await editSaved(env, msg.chat.id, arg);
    return done(r === true ? undefined : r);
  }

  // «📥 FB2» / «📥 EPUB» под файлом: прислать книгу во втором формате (собрать, если его ещё нет).
  if (action === "cv") {
    const r = await sendOtherFormat(env, msg.chat.id, arg, extra);
    return done(r === true ? "Отправляю" : r === "started" ? "Собираю — около минуты" : r);
  }

  // Книга из списка /library.
  if (action === "get") {
    const saved = env.BOOKS && await env.BOOKS.get("book:" + arg, "json");
    if (!saved) return done("Этой книги больше нет в библиотеке");
    await sendSaved(env, msg.chat.id, saved, arg);
    return done("Отправляю");
  }
  // «Собрать заново» под файлом из библиотеки: те же ссылка и настройки, что в прошлый раз.
  if (action === "rb") {
    const r = await rebuild(env, msg.chat.id, arg);
    return done(r === true ? "Запущено!" : r);
  }
  if (action === "del") {
    await deleteBook(env, arg);
    await tg(env, "editMessageReplyMarkup", { chat_id: msg.chat.id, message_id: msg.message_id,
      reply_markup: { inline_keyboard: [] } });
    return done("Удалено из библиотеки");
  }

  const mode = arg;
  if (!["go", "re"].includes(action) || !BUTTONS[mode]) return done("Неизвестная команда");
  const src = msg && msg.reply_to_message;
  if (!src) return done("Не нашла исходное сообщение — пришлите ссылку ещё раз");

  // Готовый EPUB или FB2 — просто кладём в библиотеку, без перевода.
  if (mode === "lib") {
    if (!src.document) return done("Не нашла файл — пришлите его ещё раз");
    await tg(env, "editMessageReplyMarkup", { chat_id: msg.chat.id, message_id: msg.message_id,
      reply_markup: { inline_keyboard: [] } });
    await saveUpload(env, msg.chat.id, src.document, src.message_id, msg.message_id);
    return done("Готово");
  }

  const payload = { chat_id: msg.chat.id, status_id: msg.message_id, mode };
  const req = parseRequest((src.text || src.caption || "").trim());
  let source;
  if (src.document) {
    payload.file_id = src.document.file_id;
    payload.file_name = src.document.file_name || "book.epub";
    source = "tg:" + (src.document.file_unique_id || src.document.file_id);
  } else if (req.link) {
    payload.url = req.link;
    source = normLink(req.link);
  } else {
    return done("В исходном сообщении нет ссылки");
  }
  if (req.limit) payload.limit = req.limit;
  if (req.glossary) payload.glossary = req.glossary;
  if (!req.notes) payload.notes = false;
  const format = setFormat(payload, req.format);

  // Та же книга с теми же настройками уже готова — отдаём сохранённый файл.
  const key = await bookKey(mode, source, req, format);
  if (env.BOOKS) {
    const saved = action === "go" && await env.BOOKS.get("book:" + key, "json");
    if (saved) {
      await tg(env, "editMessageText", { chat_id: msg.chat.id, message_id: msg.message_id,
        text: `📚 ${BUTTONS[mode]}: эта книга уже есть в библиотеке, отправляю готовый файл.` });
      await sendSaved(env, msg.chat.id, saved, key);
      return done("Из библиотеки");
    }
    payload.save = { url: ORIGIN + "/saved", key, sig: await sign(env, key) };
  }

  if (action === "re" && msg.document) {
    // Кнопка «Перевести заново» стоит под файлом; статус пишем отдельным сообщением.
    const st = await say(env, msg.chat.id, `⏳ ${BUTTONS[mode]}: задача отправлена…`, { reply_to_message_id: src.message_id });
    payload.status_id = st && st.result && st.result.message_id;
  } else {
    await tg(env, "editMessageText", {
      chat_id: msg.chat.id, message_id: msg.message_id,
      text: `⏳ ${BUTTONS[mode]}: задача отправлена, запуск займёт до минуты…`
    });
  }

  return done(await dispatch(env, msg.chat.id, payload) ? "Запущено!" : "Ошибка запуска");
}

// Собрать книгу из библиотеки заново с теми же ссылкой и настройками. true или текст ошибки.
// Книга во втором формате: из библиотеки, если уже собрана, иначе — задача в Actions.
// true — файл отправлен, "started" — сборка запущена, иначе текст ошибки.
async function sendOtherFormat(env, chat_id, key, format) {
  const rec = env.BOOKS && await env.BOOKS.get("book:" + key, "json");
  if (!rec) return "Этой книги больше нет в библиотеке";
  const own = recFormat(rec);
  const fmt = ["epub", "fb2"].includes(format) ? format : otherFormat(own);
  if (fmt === own || (rec.alt && rec.alt[fmt])) {
    await sendSaved(env, chat_id, rec, key, fmt);
    return true;
  }
  if (!canConvert(rec)) return "Эту книгу не собрать в другом формате — пришлите её ещё раз со словом «" + fmt + "»";
  const title = rec.title || rec.orig_title || "книга";
  const st = await say(env, chat_id, `⏳ 📥 «${title}» в ${fmt.toUpperCase()} — собираю, около минуты…`);
  const status_id = st && st.result && st.result.message_id;
  const save = { url: ORIGIN + "/saved", key, sig: await sign(env, key), alt: fmt };
  let payload;
  if (rec.mode === "lib") {
    payload = { mode: "convert", chat_id, status_id, file_id: rec.file_id, file_name: rec.file_name || "book.epub", save };
  } else {
    // Те же настройки, что у основного файла; перевод берётся только из кэша (save.alt), за него не платят.
    const q = { ...rec.req };
    delete q.format;
    if (q.edit) {
      q.edit = { ...q.edit };
      delete q.edit.format;
      if (!Object.values(q.edit).some(Boolean)) delete q.edit;
    }
    payload = { ...q, chat_id, status_id, save };
    setFormat(payload, fmt);
  }
  return await dispatch(env, chat_id, payload) ? "started" : "Ошибка запуска";
}

async function rebuild(env, chat_id, key) {
  const saved = env.BOOKS && await env.BOOKS.get("book:" + key, "json");
  const q = saved && saved.req;
  if (!q || !(q.url || q.file_id) || !BUTTONS[q.mode] || q.mode === "lib")
    return "Не знаю, откуда собирать — пришлите ссылку ещё раз";
  const st = await say(env, chat_id, `⏳ ${BUTTONS[q.mode]}: «${saved.title || saved.orig_title}» — собираю заново…`);
  const payload = { ...q, chat_id, status_id: st && st.result && st.result.message_id,
    save: { url: ORIGIN + "/saved", key, sig: await sign(env, key) } };
  return await dispatch(env, chat_id, payload) ? true : "Ошибка запуска";
}

// Меню изменений для готовой книги: новое название или обложка, перевод берётся из кэша. true или текст ошибки.
async function editSaved(env, chat_id, key) {
  const saved = env.BOOKS && await env.BOOKS.get("book:" + key, "json");
  const q = saved && saved.req;
  if (!q || !(q.url || q.file_id) || !BUTTONS[q.mode] || q.mode === "lib")
    return "Эту книгу не собрать заново — пришлите ссылку или файл ещё раз";
  const src = q.url ? { url: q.url } : { file_id: q.file_id, file_name: q.file_name, uid: q.file_id };
  const e = q.edit || {};
  const draft = { src, req: { limit: q.limit || "", glossary: q.glossary || "", notes: q.notes !== false },
    mode: q.mode, key, label: `${ICONS[q.mode] || "📘"} ${saved.title || saved.orig_title}`,
    title: e.title || null, cover: e.cover || null, thumb: e.thumb || null };
  const id = await saveDraft(env, draft);
  await say(env, chat_id, editText(draft), { reply_markup: { inline_keyboard: editButtons(id, draft) } });
  return true;
}

// ---------------------------------------------------------------- изменения перед сборкой
// Черновик задачи: откуда собирать (src), настройки (req), своё название и обложка.
// Каждое изменение сохраняется под новым ключом: KV не всегда сразу видит перезапись старого.
const PROMPT = /^(📝 Напишите новое название|🖼 Пришлите картинку для обложки)/;

async function saveDraft(env, draft) {
  const id = hex(crypto.getRandomValues(new Uint8Array(8)));
  await env.BOOKS.put("draft:" + id, JSON.stringify(draft), { expirationTtl: 7 * 86400 });
  return id;
}

async function offerEdits(env, msg, draft, label) {
  const id = await saveDraft(env, { ...draft, label });
  return say(env, msg.chat.id, `${label}\n\n✏️ Хотите внести изменения — поменять название или обложку?` +
    (draft.cover ? "\n🖼 Обложка: картинка из вашего сообщения" : ""), {
    reply_to_message_id: msg.message_id,
    reply_markup: { inline_keyboard: [[{ text: "✏️ Да, изменить", callback_data: "ed:" + id },
      { text: "Нет, дальше ➡️", callback_data: "nx:" + id }]] }
  });
}

function editText(d) {
  return `${d.label || "📘 Книга"}\n\n✏️ Изменения\n` +
    `Название: ${d.title ? `«${d.title}»` : "как предложит нейросеть (или из файла)"}\n` +
    `Обложка: ${d.cover ? "🖼 своя" : d.src && d.src.file_id ? "из файла, если есть" : "нет"}\n\n` +
    "Нажмите, что поменять, затем «Готово».";
}

function editButtons(id, d) {
  const rows = [[{ text: "📝 Название", callback_data: "et:" + id }, { text: "🖼 Обложка", callback_data: "ec:" + id }]];
  if (d.cover) rows.push([{ text: "❌ Убрать свою обложку", callback_data: "ex:" + id }]);
  rows.push([{ text: d.mode ? "✅ Готово — собрать" : "✅ Готово", callback_data: "nx:" + id }]);
  return rows;
}

function modesText(d) {
  const kind = (fileKind(d.src.file_name) || "epub").toUpperCase();
  const lines = [d.label || "📘 Книга", "", d.src.file_id ? `Что сделать с этим ${kind}?` : "Как собрать книгу?"];
  if (d.title) lines.push(`📝 Название: «${d.title}»`);
  if (d.cover) lines.push("🖼 Своя обложка");
  return lines.join("\n");
}

// Картинка из сообщения (фото или файл-картинка) и её маленькая копия для значка файла.
function pickImage(msg) {
  if (Array.isArray(msg.photo) && msg.photo.length) {
    const small = msg.photo.filter((p) => Math.max(p.width, p.height) <= 320).pop();
    return { cover: msg.photo[msg.photo.length - 1].file_id, thumb: small ? small.file_id : null };
  }
  const d = msg.document;
  if (d && (/^image\/(jpeg|png|gif|webp)$/i.test(d.mime_type || "") || /\.(jpe?g|png|gif|webp)$/i.test(d.file_name || ""))) {
    if (d.file_size > 10 * 1024 * 1024) return null;
    return { cover: d.file_id, thumb: d.thumbnail ? d.thumbnail.file_id : null };
  }
  return null;
}

async function onEditReply(env, msg, prompt) {
  const chat = msg.chat.id;
  const wait = await env.BOOKS.get(`wait:${chat}:${prompt.message_id}`, "json");
  const draft = wait && await env.BOOKS.get("draft:" + wait.draft, "json");
  if (!draft) return say(env, chat, "Меню устарело — пришлите книгу ещё раз.");
  const next = { ...draft };
  if (wait.field === "title") {
    const t = (msg.text || "").replace(/\s+/g, " ").trim().replace(/^[«"“]+|[»"”]+$/g, "");
    if (!t) return say(env, chat, "Пришлите название текстом ответом на моё сообщение.");
    next.title = /^[-—–]$/.test(t) ? null : t.slice(0, 200);
  } else {
    const img = pickImage(msg);
    if (!img) return say(env, chat, "Нужна картинка: фото или файл JPG/PNG до 10 МБ. Пришлите её ответом на моё сообщение.");
    Object.assign(next, img);
  }
  const id = await saveDraft(env, next);
  // Старое меню гасим, новое присылаем внизу, чтобы не листать чат.
  await tg(env, "editMessageText", { chat_id: chat, message_id: wait.menu, text: "✏️ Изменения — ниже ⬇️",
    reply_markup: { inline_keyboard: [] } });
  const head = wait.field === "title" ? (next.title ? `✅ Название: «${next.title}»` : "✅ Название — от нейросети")
    : "✅ Обложка сохранена";
  return say(env, chat, head + "\n\n" + editText(next), {
    reply_to_message_id: msg.message_id, reply_markup: { inline_keyboard: editButtons(id, next) }
  });
}

async function startDraft(env, msg, draft, mode) {
  const chat = msg.chat.id;
  const req = { limit: draft.req.limit || "", glossary: draft.req.glossary || "", notes: draft.req.notes !== false,
    format: draft.req.format || "" };
  const payload = { chat_id: chat, status_id: msg.message_id, mode };
  let source;
  if (draft.src.file_id) {
    payload.file_id = draft.src.file_id;
    payload.file_name = draft.src.file_name || "book.epub";
    source = "tg:" + (draft.src.uid || draft.src.file_id);
  } else {
    payload.url = draft.src.url;
    source = normLink(draft.src.url);
  }
  if (req.limit) payload.limit = req.limit;
  if (req.glossary) payload.glossary = req.glossary;
  if (!req.notes) payload.notes = false;
  const edited = !!(draft.title || draft.cover);
  // В client_payload GitHub — не больше 10 полей, поэтому изменения вложены в одно.
  if (edited) payload.edit = { title: draft.title || null, cover: draft.cover || null, thumb: draft.thumb || null };
  const format = setFormat(payload, req.format);

  const key = draft.key || await bookKey(mode, source, req, format);
  // Без изменений — отдаём готовую книгу из библиотеки; с изменениями — собираем и заменяем запись.
  const saved = !edited && !draft.key && await env.BOOKS.get("book:" + key, "json");
  if (saved) {
    await tg(env, "editMessageText", { chat_id: chat, message_id: msg.message_id,
      text: `📚 ${BUTTONS[mode]}: эта книга уже есть в библиотеке, отправляю готовый файл.` });
    await sendSaved(env, chat, saved, key);
    return true;
  }
  payload.save = { url: ORIGIN + "/saved", key, sig: await sign(env, key) };
  await tg(env, "editMessageText", { chat_id: chat, message_id: msg.message_id,
    text: `⏳ ${BUTTONS[mode]}: задача отправлена, запуск займёт до минуты…` +
      (draft.title ? `\n📝 Название: «${draft.title}»` : "") + (draft.cover ? "\n🖼 Своя обложка" : "") });
  return dispatch(env, chat, payload);
}

async function deleteBook(env, key) {
  if (!env.BOOKS) return;
  await Promise.all([env.BOOKS.delete("book:" + key), env.BOOKS.delete("cover:" + key)]);
}

async function dispatch(env, chat_id, payload, quiet = false) {
  if (!env.GH_TOKEN || !env.GH_REPO) return false;
  const r = await fetch(`https://api.github.com/repos/${env.GH_REPO}/dispatches`, {
    method: "POST",
    headers: {
      "authorization": `Bearer ${env.GH_TOKEN}`,
      "accept": "application/vnd.github+json",
      "user-agent": "book-epub-bot",
      "content-type": "application/json"
    },
    body: JSON.stringify({ event_type: "build-book", client_payload: payload })
  });
  if (r.status === 204) return true;
  const t = (await r.text()).slice(0, 200);
  if (quiet) { console.log("dispatch", r.status, t); return false; }
  await say(env, chat_id, `❌ GitHub не принял задачу (${r.status}). Проверьте GH_TOKEN и GH_REPO.\n${t}`);
  return false;
}

// ---------------------------------------------------------------- библиотека
// Сами файлы хранит Telegram (по file_id), в KV лежит только запись о книге.

function normLink(link) {
  return link.trim().replace(/^https?:\/\/(?:www\.)?/i, "").replace(/[#?].*$/, "").replace(/\/+$/, "").toLowerCase();
}

async function bookKey(mode, source, req, format) {
  const parts = [mode, source, req.limit || "", req.glossary || "", req.notes];
  if (format === "fb2") parts.push("fb2");  // у EPUB ключ прежний — старые записи библиотеки находятся
  const raw = JSON.stringify(parts);
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw)));
  return [...h.slice(0, 12)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmac(key, msg) {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey("raw", typeof key === "string" ? enc.encode(key) : key,
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(msg)));
}
const hex = (a) => [...a].map((b) => b.toString(16).padStart(2, "0")).join("");

async function sign(env, key) {
  return hex(await hmac(env.WEBHOOK_SECRET, "book:" + key));
}

// Формат основного файла книги в библиотеке.
function recFormat(rec) {
  const q = rec.req || {};
  return rec.format || q.format || (q.edit || {}).format || fileKind(rec.file_name || q.file_name) || "epub";
}
const otherFormat = (f) => f === "fb2" ? "epub" : "fb2";

// Можно ли получить книгу во втором формате: она уже есть, её можно собрать заново из кэша
// или перевести в другой формат готовый файл (до 20 МБ — больше Telegram боту не отдаст).
function canConvert(rec) {
  const other = otherFormat(recFormat(rec));
  if (rec.alt && rec.alt[other]) return true;
  if (rec.mode === "lib") return !!rec.file_id && !(rec.size > 20 * 1024 * 1024);
  return !!(rec.req && (rec.req.url || rec.req.file_id) && BUTTONS[rec.req.mode]);
}

async function sendSaved(env, chat_id, saved, key, format) {
  const own = recFormat(saved);
  const fmt = format && format !== own && saved.alt && saved.alt[format] ? format : own;
  const other = otherFormat(fmt);
  const rows = [[{ text: "🗑 Убрать из библиотеки", callback_data: "del:" + key }]];
  if (saved.req && saved.mode !== "lib") rows.unshift([{ text: "🔄 Собрать заново", callback_data: "rb:" + key },
    { text: "✏️ Изменить", callback_data: "chg:" + key }]);
  if (fmt !== own || canConvert(saved)) rows.unshift([{ text: "📥 " + other.toUpperCase(), callback_data: `cv:${key}:${other}` }]);
  const date = saved.date ? `\nСохранено: ${saved.date.slice(0, 10)}` : "";
  // Длинная книга хранится несколькими томами: шлём их по порядку, подпись и кнопки — у последнего.
  const files = fmt === own ? saved : saved.alt[fmt];
  const ids = Array.isArray(files.file_ids) && files.file_ids.length ? files.file_ids : [files.file_id];
  for (let i = 0; i < ids.length - 1; i++) {
    await tg(env, "sendDocument", { chat_id, document: ids[i], caption: `📕 Книга ${i + 1} из ${ids.length}` });
  }
  const last = ids.length > 1 ? `\n📕 Книга ${ids.length} из ${ids.length}` : "";
  return tg(env, "sendDocument", { chat_id, document: ids[ids.length - 1],
    caption: (saved.caption || "").slice(0, 940) + last + date, reply_markup: { inline_keyboard: rows } });
}

// Обрезает строку так, чтобы она заняла не больше n байт UTF-8 (метаданные KV — до 1024 байт).
function cutBytes(str, n) {
  const enc = new TextEncoder();
  let out = "";
  for (const ch of String(str || "")) {
    if (enc.encode(out + ch).length > n) break;
    out += ch;
  }
  return out;
}

// Для поиска: без регистра, ё = е, без пробелов, кавычек и знаков препинания.
// Тоны пиньиня тоже убираем: «rulin waishi» найдёт «Rúlín wàishǐ».
const norm = (x) => String(x || "").toLowerCase().replace(/ё/g, "е").replace(/й/g, "\u0000")
  .normalize("NFD").replace(/\p{M}/gu, "").replace(/\u0000/g, "й").replace(/[\s\p{P}\p{S}]+/gu, "");

async function onSaved(env, request) {
  if (!env.BOOKS) return new Response("no storage", { status: 501 });
  const b = await request.json().catch(() => null);
  if (!b || !/^[0-9a-f]{24}$/.test(b.key || "") || !b.file_id) return new Response("bad request", { status: 400 });
  if ((await sign(env, b.key)) !== b.sig) return new Response("forbidden", { status: 403 });
  const file_ids = (Array.isArray(b.file_ids) ? b.file_ids : []).map(String).filter(Boolean).slice(0, 50);
  if (b.alt) {  // второй формат книги — кладём рядом с основным файлом
    if (!["epub", "fb2"].includes(b.alt)) return new Response("bad request", { status: 400 });
    const old = await env.BOOKS.get("book:" + b.key, "json");
    if (!old) return new Response("gone", { status: 404 });
    old.alt = { ...(old.alt || {}), [b.alt]: { file_id: String(b.file_id), file_ids } };
    await putBook(env, b.key, old);
    return new Response("ok");
  }
  const rec = {
    file_id: String(b.file_id),
    file_ids, format: ["epub", "fb2"].includes(b.format) ? b.format : undefined,
    title: String(b.title || "").slice(0, 200),
    orig_title: String(b.orig_title || "").slice(0, 200), mode: String(b.mode || ""),
    chapters: b.chapters || 0, caption: String(b.caption || "").slice(0, 1000), date: new Date().toISOString(),
    names: (Array.isArray(b.names) ? b.names : []).map((x) => String(x).slice(0, 200)).filter(Boolean).slice(0, 12),
    req: b.request && typeof b.request === "object" ? b.request : null,
    info: cleanInfo(b.info)
  };
  // Книгу могли собрать заново — старую обложку забываем, новая достанется из нового файла.
  await env.BOOKS.delete("cover:" + b.key);
  await putBook(env, b.key, rec);
  return new Response("ok");
}

// Справка о книге для карточки в мини-приложении.
function cleanInfo(x) {
  if (!x || typeof x !== "object") return {};
  const out = {};
  for (const [k, n] of [["author", 200], ["orig_author", 200], ["genre", 200], ["synopsis", 1500],
    ["title_en", 200], ["title_literal", 200], ["title_pinyin", 200], ["title_ru", 200], ["series", 200]]) {
    const v = String(x[k] || "").trim();
    if (v && v !== "—") out[k] = v.slice(0, n);
  }
  return out;
}

function putBook(env, key, rec) {
  // Все варианты названия и автор — в метаданных, чтобы искать без чтения каждой записи (лимит 1024 байта).
  const names = [...new Set([rec.title, rec.orig_title, ...rec.names].map(norm).filter(Boolean))].join("|");
  const meta = { t: cutBytes(rec.title, 150), o: cutBytes(rec.orig_title, 80), m: rec.mode, n: rec.chapters,
    d: rec.date, a: cutBytes((rec.info || {}).author, 70), s: "" };
  if (rec.cover !== undefined) meta.c = rec.cover;
  meta.s = cutBytes(names, 1000 - new TextEncoder().encode(JSON.stringify(meta)).length);
  return env.BOOKS.put("book:" + key, JSON.stringify(rec), { metadata: meta });
}

async function listBooks(env) {
  const items = [];
  let cursor;
  do {
    const page = await env.BOOKS.list({ prefix: "book:", cursor });
    items.push(...page.keys);
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor && items.length < 1000);
  return items.sort((a, b) => String(b.metadata?.d || "").localeCompare(String(a.metadata?.d || "")));
}

function bookButtons(items) {
  return items.map((k) => {
    const m = k.metadata || {};
    const title = m.t && m.o && m.t !== m.o ? `${m.t} (${m.o})` : (m.t || m.o || "без названия");
    return [{ text: `${ICONS[m.m] || "📘"} ${title}${m.n ? ` · ${m.n} гл.` : ""}`.slice(0, 60),
      callback_data: "get:" + k.name.slice(5) }];
  });
}

async function showLibrary(env, chat) {
  if (!env.BOOKS) return say(env, chat, "Библиотека не подключена: у воркера нет KV-хранилища BOOKS. См. bot/README.md.");
  const items = await listBooks(env);
  if (!items.length) return say(env, chat, "📚 Библиотека пока пуста. Готовые книги появятся здесь сами.");
  const shown = items.slice(0, 50);
  await tg(env, "setChatMenuButton", { chat_id: chat, menu_button: appButton() });
  return say(env, chat, `📚 Сохранённые книги: ${items.length}` +
    (items.length > shown.length ? ` (показаны последние ${shown.length})` : "") +
    "\nНажмите, чтобы получить файл. Или напишите название, чтобы найти книгу.",
    { reply_markup: { inline_keyboard: [[{ text: "📚 Открыть библиотеку с обложками", web_app: { url: ORIGIN + "/app" } }],
      ...bookButtons(shown)] } });
}

async function findBooks(env, chat, query) {
  if (!env.BOOKS) return say(env, chat, "Пришлите ссылку на оглавление книги с kanunu8.com или файл .epub / .fb2.\n/help — подробнее");
  const words = query.split(/\s+/).map(norm).filter(Boolean);
  if (!words.length) return say(env, chat, "Напишите название книги или пришлите ссылку.");
  const found = (await listBooks(env)).filter((k) => {
    const m = k.metadata || {};
    const hay = [m.s, norm(m.t), norm(m.o)].join("|");
    return words.every((w) => hay.includes(w));
  });
  if (!found.length) {
    return say(env, chat, `🔍 «${query.slice(0, 100)}» в библиотеке нет.\n` +
      "Пришлите ссылку на оглавление книги с kanunu8.com или файл .epub / .fb2, и я её соберу. /library — все книги.");
  }
  if (found.length === 1) {
    const key = found[0].name.slice(5);
    const saved = await env.BOOKS.get(found[0].name, "json");
    if (saved) return sendSaved(env, chat, saved, key);
  }
  return say(env, chat, `🔍 Нашлось книг: ${found.length}` + (found.length > 30 ? " (показаны 30)" : "") +
    ". Какую прислать?", { reply_markup: { inline_keyboard: bookButtons(found.slice(0, 30)) } });
}

// ---------------------------------------------------------------- загрузка готовых EPUB

async function toggleUpload(env, chat) {
  if (!env.BOOKS) return say(env, chat, "Библиотека не подключена: у воркера нет KV-хранилища BOOKS. См. bot/README.md.");
  const key = "upload:" + chat;
  if (await env.BOOKS.get(key)) {
    await env.BOOKS.delete(key);
    return say(env, chat, "📥 Режим загрузки выключен. Присланные книги снова можно переводить.");
  }
  await env.BOOKS.put(key, "1", { expirationTtl: 3 * 3600 });
  return say(env, chat, "📥 Режим загрузки включён на 3 часа.\n" +
    "Присылайте готовые EPUB или FB2 (можно много сразу) — каждый сохранится в библиотеку без перевода. " +
    "Название и автор берутся из самого файла.\n/upload ещё раз — выключить.");
}

// Сохраняет присланный EPUB в библиотеку. Сам файл остаётся у Telegram, в KV — только запись.
async function saveUpload(env, chat, doc, replyTo, editId) {
  const reply = (text) => editId
    ? tg(env, "editMessageText", { chat_id: chat, message_id: editId, text })
    : say(env, chat, text, { reply_to_message_id: replyTo });
  if (!env.BOOKS) return reply("Библиотека не подключена: у воркера нет KV-хранилища BOOKS.");

  const key = await bookKey("lib", "tg:" + (doc.file_unique_id || doc.file_id), {});
  const old = await env.BOOKS.get("book:" + key, "json");
  if (old) return reply(`📚 «${old.title}» уже есть в библиотеке.`);

  const fileTitle = String(doc.file_name || "book.epub").replace(/\.(epub|fb2|fb2\.zip)$/i, "").replace(/[_]+/g, " ").trim();
  let meta = {};
  if (doc.file_size <= 20 * 1024 * 1024) {
    try { meta = await inspectEpub(env, doc.file_id); } catch (e) { console.log("epub meta", e && e.stack || e); }
  }
  // Пока модель не составила описание, хотя бы убираем подчёркивания из «Dolgaya_igra».
  for (const k of ["title", "author"]) if (meta[k]) meta[k] = meta[k].replace(/_+/g, " ").trim();
  const title = meta.title || fileTitle || "Без названия";
  const sizeMb = doc.file_size ? ` · ${(doc.file_size / 1048576).toFixed(1)} МБ` : "";
  const caption = `📗 ${title}` + (meta.author ? `\n${meta.author}` : "");
  const rec = {
    file_id: doc.file_id, file_name: String(doc.file_name || "book.epub").slice(0, 200), size: doc.file_size || 0,
    title: title.slice(0, 200), orig_title: "", mode: "lib", chapters: 0,
    caption: caption.slice(0, 1000), date: new Date().toISOString(), req: null,
    names: [meta.author, fileTitle, ...(meta.alt || [])].filter(Boolean).map((x) => String(x).slice(0, 200)).slice(0, 12),
    info: cleanInfo({ author: meta.author, genre: meta.subject, synopsis: meta.description })
  };
  if (meta.ok) {
    rec.cover = meta.cover ? 1 : 0;
    await putCover(env, key, meta.cover);
  }
  await putBook(env, key, rec);
  const text = `📥 Сохранено в библиотеку: «${title}»` + (meta.author ? `, ${meta.author}` : "") + sizeMb +
    (meta.cover ? " · 🖼 с обложкой" : "") +
    "\nНайти потом: напишите название или автора, или /library.";
  const canDescribe = doc.file_size <= 20 * 1024 * 1024 && env.GH_TOKEN && env.GH_REPO;
  const sent = await reply(text + (canDescribe ? "\n📝 Составляю описание…" : ""));
  const statusId = sent && sent.result && sent.result.message_id;
  if (canDescribe && !await describeBook(env, chat, key, rec, statusId, text) && statusId)
    await tg(env, "editMessageText", { chat_id: chat, message_id: statusId, text: text + "\n📝 Описание не запустилось." });
  return sent;
}

// Описание загруженной книги составляет модель в GitHub Actions (bot/job.py, mode=describe):
// настоящее название (метаданные EPUB часто испорчены), автор, жанр и о чём книга. Результат приходит в /info.
async function describeBook(env, chat_id, key, rec, statusId, statusText) {
  return dispatch(env, chat_id, { mode: "describe", chat_id, status_id: statusId || undefined,
    status_text: statusText ? statusText.slice(0, 3000) : undefined, file_id: rec.file_id,
    file_name: rec.file_name || "book.epub",
    describe: { url: ORIGIN + "/info", key, sig: await sign(env, key) } }, true);
}

async function onInfo(env, request) {
  if (!env.BOOKS) return new Response("no storage", { status: 501 });
  const b = await request.json().catch(() => null);
  if (!b || !/^[0-9a-f]{24}$/.test(b.key || "") || !b.card || typeof b.card !== "object")
    return new Response("bad request", { status: 400 });
  if ((await sign(env, b.key)) !== b.sig) return new Response("forbidden", { status: 403 });
  const rec = await env.BOOKS.get("book:" + b.key, "json");
  if (!rec) return new Response("gone", { status: 404 });
  const c = b.card;
  const str = (k) => String(c[k] || "").replace(/\s+/g, " ").trim().slice(0, 200);
  const oldTitle = rec.title, oldAuthor = (rec.info || {}).author;
  if (str("title")) rec.title = str("title");
  if (str("title_orig") && str("title_orig") !== rec.title) rec.orig_title = str("title_orig");
  const fresh = cleanInfo({ author: c.author, orig_author: c.author_orig, genre: c.genre, synopsis: c.synopsis,
    series: c.series, title_ru: c.title_ru !== rec.title ? c.title_ru : "" });
  rec.info = { ...(rec.info || {}), ...fresh };
  // Прежние (испорченные) варианты оставляем для поиска.
  rec.names = [...new Set([oldTitle, oldAuthor, str("title_ru"), str("title_orig"), str("author"), str("author_orig"),
    ...(rec.names || [])].filter(Boolean))].slice(0, 12);
  rec.caption = (`📗 ${rec.title}` + (rec.info.author ? `\n${rec.info.author}` : "")).slice(0, 1000);
  rec.described = new Date().toISOString();
  await putBook(env, b.key, rec);
  return new Response("ok");
}

// Читает из EPUB (это ZIP-архив) или FB2 (.fb2.zip) название, автора, описание и обложку. Работает с файлами до 20 МБ.
// Бросает исключение только при сбое сети; если файл недоступен или битый — возвращает { ok: true }.
async function inspectEpub(env, file_id) {
  const f = await tg(env, "getFile", { file_id });
  if (!f) throw new Error("Telegram не ответил");
  if (!f.ok) return { ok: true };  // например, файл больше 20 МБ
  const r = await fetch(`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${f.result.file_path}`);
  if (!r.ok) throw new Error("скачивание: " + r.status);
  const buf = new Uint8Array(await r.arrayBuffer());
  let zip;
  try { zip = readZip(buf); } catch { return inspectFb2(buf); }  // не ZIP — может быть обычный FB2
  const fb2 = zip.names.find((n) => /\.fb2$/i.test(n));
  if (fb2 && !zip.names.includes("META-INF/container.xml")) return inspectFb2(await zip.bytes(fb2));
  const container = await zip.text("META-INF/container.xml");
  const opfPath = (container && (container.match(/full-path\s*=\s*["']([^"']+)["']/i) || [])[1]) ||
    zip.names.find((n) => /\.opf$/i.test(n));
  const opf = opfPath && await zip.text(opfPath);
  if (!opf) return { ok: true };
  const all = (tag) => [...opf.matchAll(new RegExp(`<dc:${tag}\\b[^>]*>([\\s\\S]*?)</dc:${tag}>`, "gi"))]
    .map((m) => xmlText(m[1])).filter((x) => x && x !== "—");
  const titles = all("title");
  let cover = null;
  try { cover = await findCover(zip, opf, opfPath); } catch (e) { console.log("cover", e && e.stack || e); }
  return { ok: true, title: titles[0], alt: titles.slice(1), author: all("creator").slice(0, 3).join(", "),
    description: all("description")[0], subject: all("subject").slice(0, 3).join(", "), cover };
}

// FB2 — это XML: метаданные в <title-info>, обложка — картинка base64 в <binary>.
function inspectFb2(bytes) {
  if (!bytes) return { ok: true };
  const xml = decodeXml(bytes);
  if (!/<FictionBook\b/i.test(xml)) return { ok: true };
  const info = (xml.match(/<title-info\b[^>]*>([\s\S]*?)<\/title-info>/i) || [])[1] || "";
  const one = (tag, src = info) => xmlText((src.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "i")) || [])[1] || "");
  const authors = [...info.matchAll(/<author\b[^>]*>([\s\S]*?)<\/author>/gi)].map((m) =>
    ["first-name", "middle-name", "last-name"].map((t) => one(t, m[1])).filter(Boolean).join(" ") || one("nickname", m[1]))
    .filter(Boolean);
  const genres = [...info.matchAll(/<genre\b[^>]*>([\s\S]*?)<\/genre>/gi)].map((m) => xmlText(m[1])).filter(Boolean);
  let cover = null;
  const img = (info.match(/<coverpage\b[^>]*>[\s\S]*?<image\b([^>]*)>/i) || [])[1];
  const ref = img && (img.match(/href\s*=\s*["']#?([^"']+)["']/i) || [])[1];
  if (ref) {
    const esc = ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const bin = xml.match(new RegExp(`<binary\\b([^>]*\\bid\\s*=\\s*["']${esc}["'][^>]*)>([\\s\\S]*?)</binary>`, "i"));
    if (bin) {
      try {
        const raw = atob(bin[2].replace(/\s+/g, ""));
        const data = Uint8Array.from(raw, (c) => c.charCodeAt(0));
        const type = (bin[1].match(/content-type\s*=\s*["']([^"']+)["']/i) || [])[1] ||
          IMG_TYPES[(ref.match(/\.(\w+)$/) || [])[1]?.toLowerCase()];
        if (type && /^image\//.test(type) && data.length >= 100 && data.length <= 5 * 1024 * 1024) cover = { data, type };
      } catch (e) { console.log("fb2 cover", e && e.stack || e); }
    }
  }
  return { ok: true, title: one("book-title") || undefined, alt: [], author: authors.slice(0, 3).join(", "),
    description: one("annotation") || undefined, subject: genres.slice(0, 3).join(", "), cover };
}

// Текст XML в кодировке из заголовка (у русских FB2 часто windows-1251).
const CP1251 = "ЂЃ‚ѓ„…†‡€‰Љ‹ЊЌЋЏђ‘’“”•–—\uFFFD™љ›њќћџ\u00A0ЎўЈ¤Ґ¦§Ё©Є«¬\u00AD®Ї°±Ііґµ¶·ё№є»јЅѕї" +
  "АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдежзийклмнопрстуфхцчшщъыьэюя";
function decodeXml(bytes) {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 200));
  const enc = ((head.match(/encoding\s*=\s*["']([\w.-]+)["']/i) || [])[1] || "utf-8").toLowerCase();
  if (/^(windows-1251|cp1251|cp-1251)$/.test(enc)) {
    let out = "";
    for (const b of bytes) out += b < 0x80 ? String.fromCharCode(b) : CP1251[b - 0x80];
    return out;
  }
  try { return new TextDecoder(enc).decode(bytes); } catch { return new TextDecoder().decode(bytes); }
}

const attrsOf = (tag) => Object.fromEntries([...tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)]
  .map((m) => [m[1].toLowerCase(), m[2] ?? m[3]]));

function joinPath(base, href) {
  const parts = (base + decodeURIComponent(href.split("#")[0])).split("/");
  const out = [];
  for (const p of parts) p === ".." ? out.pop() : p && p !== "." && out.push(p);
  return out.join("/");
}

const IMG_TYPES = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml" };

// Обложка по правилам EPUB 3 (properties="cover-image") и EPUB 2 (<meta name="cover">),
// иначе — картинка со словом cover в имени или первая картинка со страницы обложки.
async function findCover(zip, opf, opfPath) {
  const base = opfPath.includes("/") ? opfPath.replace(/[^/]+$/, "") : "";
  const items = [...opf.matchAll(/<item\b[^>]*>/gi)].map((m) => attrsOf(m[0]));
  const isImg = (i) => /^image\//.test(i["media-type"] || "");
  let item = items.find((i) => /(^|\s)cover-image(\s|$)/.test(i.properties || ""));
  if (!item) {
    const meta = [...opf.matchAll(/<meta\b[^>]*>/gi)].map((m) => attrsOf(m[0])).find((m) => m.name === "cover");
    if (meta) item = items.find((i) => i.id === meta.content);
  }
  if (!item) item = items.find((i) => isImg(i) && /cover/i.test((i.id || "") + " " + (i.href || "")));
  if (!item) {  // страница обложки из <guide> или с cover в имени
    const ref = (opf.match(/<reference\b[^>]*type\s*=\s*["']cover["'][^>]*>/i) || [])[0];
    const page = ref ? { href: attrsOf(ref).href } : items.find((i) => /html/.test(i["media-type"] || "") && /cover/i.test((i.id || "") + (i.href || "")));
    if (page && page.href) {
      const path = joinPath(base, page.href);
      const html = await zip.text(path);
      const src = html && (html.match(/<(?:img|image)\b[^>]*?(?:src|xlink:href|href)\s*=\s*["']([^"']+)["']/i) || [])[1];
      if (src) item = { href: joinPath(path.replace(/[^/]+$/, ""), src), abs: true };
    }
  }
  if (!item || !item.href) return null;
  const path = item.abs ? item.href : joinPath(base, item.href);
  const data = await zip.bytes(path);
  if (!data || data.length < 100 || data.length > 5 * 1024 * 1024) return null;
  const type = isImg(item) ? item["media-type"] : IMG_TYPES[(path.match(/\.(\w+)$/) || [])[1]?.toLowerCase()];
  return type ? { data, type } : null;
}

function xmlText(s) {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]+>/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&")
    .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

// Минимальный разбор ZIP: центральный каталог + распаковка deflate.
function readZip(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--)
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("не ZIP");
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const entries = {};
  const dec = new TextDecoder();
  for (let i = 0; i < count && dv.getUint32(p, true) === 0x02014b50; i++) {
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    entries[dec.decode(buf.subarray(p + 46, p + 46 + nlen))] = { method, csize, local };
    p += 46 + nlen + xlen + clen;
  }
  const zip = {
    names: Object.keys(entries),
    async bytes(name) {
      const e = entries[name] || entries[Object.keys(entries).find((n) => n.toLowerCase() === name.toLowerCase())];
      if (!e) return null;
      const start = e.local + 30 + dv.getUint16(e.local + 26, true) + dv.getUint16(e.local + 28, true);
      const data = buf.subarray(start, start + e.csize);
      if (e.method === 0) return data;
      if (e.method !== 8) return null;
      const out = new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw")));
      return new Uint8Array(await out.arrayBuffer());
    },
    async text(name) {
      const b = await zip.bytes(name);
      return b && dec.decode(b);
    }
  };
  return zip;
}

// ---------------------------------------------------------------- мини-приложение: API

const json = (data, status = 200) => new Response(JSON.stringify(data),
  { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

const appButton = () => ({ type: "web_app", text: "Библиотека", web_app: { url: ORIGIN + "/app" } });

// Проверка подписи Telegram (initData): приложение открыто из этого бота и разрешённым пользователем.
async function webAppUser(env, initData) {
  if (!initData || !env.BOT_TOKEN) return null;
  const p = new URLSearchParams(initData);
  const hash = p.get("hash");
  if (!hash) return null;
  p.delete("hash");
  const check = [...p.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = await hmac("WebAppData", env.BOT_TOKEN);
  if (hex(await hmac(secret, check)) !== hash) return null;
  if (Date.now() / 1000 - Number(p.get("auth_date") || 0) > 7 * 86400) return null;
  let user = null;
  try { user = JSON.parse(p.get("user") || "null"); } catch { return null; }
  return user && allowed(env, user.id) ? user : null;
}

// Ссылки на обложки подписаны: картинку грузит <img>, а он не умеет слать заголовки.
const coverToken = async (env) => hex(await hmac(env.WEBHOOK_SECRET || "", "covers")).slice(0, 32);

async function onApi(env, request, url) {
  const user = await webAppUser(env, request.headers.get("x-init-data"));
  if (!user) return json({ error: "Откройте библиотеку из бота. Если вы владелец, проверьте ALLOWED_USERS." }, 403);
  if (!env.BOOKS) return json({ error: "Библиотека не подключена: у воркера нет KV-хранилища BOOKS." }, 501);
  const route = url.pathname.slice(5);

  if (route === "books" && request.method === "GET") {
    const items = await listBooks(env);
    return json({ token: await coverToken(env), books: items.map((k) => ({ k: k.name.slice(5), ...(k.metadata || {}) })) });
  }

  const body = request.method === "POST" ? await request.json().catch(() => ({})) : {};
  const key = String(url.searchParams.get("k") || body.k || "");
  if (!/^[0-9a-f]{24}$/.test(key)) return json({ error: "Нет такой книги" }, 400);
  const rec = await env.BOOKS.get("book:" + key, "json");
  if (!rec) return json({ error: "Этой книги больше нет в библиотеке" }, 404);

  if (route === "book") {
    return json({ title: rec.title, orig_title: rec.orig_title, mode: rec.mode, chapters: rec.chapters, date: rec.date,
      names: rec.names || [], info: rec.info || {}, cover: rec.cover,
      rebuild: !!(rec.req && (rec.req.url || rec.req.file_id) && rec.mode !== "lib"),
      describe: rec.mode === "lib" && !!(env.GH_TOKEN && env.GH_REPO), described: !!rec.described,
      format: recFormat(rec), other: canConvert(rec) ? otherFormat(recFormat(rec)) : null,
      other_ready: !!(rec.alt && rec.alt[otherFormat(recFormat(rec))]) });
  }
  if (request.method !== "POST") return json({ error: "Не тот метод" }, 405);
  if (route === "send") {
    const r = await sendSaved(env, user.id, rec, key);
    return r && r.ok ? json({ ok: true }) : json({ error: "Telegram не отправил файл: " + (r && r.description || "ошибка") }, 502);
  }
  if (route === "other") {
    const r = await sendOtherFormat(env, user.id, key, body.f);
    return r === true || r === "started" ? json({ ok: true, started: r === "started" }) : json({ error: r }, 400);
  }
  if (route === "rebuild") {
    const r = await rebuild(env, user.id, key);
    return r === true ? json({ ok: true }) : json({ error: r }, 400);
  }
  if (route === "edit") {
    const r = await editSaved(env, user.id, key);
    return r === true ? json({ ok: true }) : json({ error: r }, 400);
  }
  if (route === "describe") {
    return await describeBook(env, user.id, key, rec) ? json({ ok: true })
      : json({ error: "Не удалось запустить: проверьте GH_TOKEN и GH_REPO" }, 502);
  }
  if (route === "delete") {
    await deleteBook(env, key);
    return json({ ok: true });
  }
  return json({ error: "Неизвестный запрос" }, 404);
}

async function putCover(env, key, cover) {
  // Пустое значение — «обложки нет», чтобы не искать её каждый раз заново.
  await env.BOOKS.put("cover:" + key, cover ? cover.data : new Uint8Array(0), { metadata: { type: cover ? cover.type : "" } });
}

// Обложка книги. Для книг, сохранённых раньше, достаётся из EPUB при первом показе и запоминается.
async function onCover(env, url) {
  const key = url.pathname.slice(7);
  if (!env.BOOKS || !/^[0-9a-f]{24}$/.test(key) || url.searchParams.get("t") !== await coverToken(env))
    return new Response("forbidden", { status: 403 });
  const none = () => new Response("no cover", { status: 404, headers: { "cache-control": "no-store" } });
  let { value, metadata } = await env.BOOKS.getWithMetadata("cover:" + key, "arrayBuffer");
  if (value === null) {
    const rec = await env.BOOKS.get("book:" + key, "json");
    if (!rec) return none();
    let ep;
    try { ep = await inspectEpub(env, rec.file_id); } catch (e) { console.log("cover", e && e.stack || e); return none(); }
    await putCover(env, key, ep.cover);
    // Заодно дополняем запись тем, что нашлось в файле: автор, описание, жанр.
    const info = cleanInfo({ author: ep.author, synopsis: ep.description, genre: ep.subject });
    rec.info = { ...info, ...(rec.info || {}) };
    rec.cover = ep.cover ? 1 : 0;
    await putBook(env, key, rec);
    if (!ep.cover) return none();
    value = ep.cover.data;
    metadata = { type: ep.cover.type };
  }
  if (!value || !value.byteLength) return none();
  return new Response(value, { headers: { "content-type": metadata && metadata.type || "image/jpeg",
    "cache-control": "private, max-age=31536000, immutable" } });
}

// ---------------------------------------------------------------- мини-приложение: страница
// Встроено прямо в воркер, чтобы его можно было обновлять вставкой одного файла.
const APP_HTML = String.raw`<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Библиотека</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>
:root {
  --bg: var(--tg-theme-bg-color, #ffffff);
  --bg2: var(--tg-theme-secondary-bg-color, #f1f1f4);
  --text: var(--tg-theme-text-color, #16161a);
  --hint: var(--tg-theme-hint-color, #8a8a92);
  --link: var(--tg-theme-link-color, #2481cc);
  --accent: var(--tg-theme-button-color, #2481cc);
  --accent-text: var(--tg-theme-button-text-color, #ffffff);
  --danger: var(--tg-theme-destructive-text-color, #e0463e);
  --header: var(--tg-theme-header-bg-color, var(--bg));
  --sep: color-mix(in srgb, var(--hint) 22%, transparent);
}
@media (prefers-color-scheme: dark) {
  :root:not(.tg) { --bg:#17212b; --bg2:#232e3c; --text:#f5f5f5; --hint:#708499; --link:#6ab3f3;
    --accent:#5288c1; --accent-text:#fff; --danger:#ec3942; --header:#17212b; }
}
* { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
html, body { margin: 0; background: var(--bg); color: var(--text); }
body { font: 15px/1.4 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, sans-serif;
  -webkit-font-smoothing: antialiased; overscroll-behavior-y: none; }
button { font: inherit; color: inherit; background: none; border: 0; padding: 0; cursor: pointer; }

/* ---------- шапка */
header { position: sticky; top: 0; z-index: 5; background: var(--header);
  padding: 12px 16px 10px; border-bottom: 0.5px solid transparent; transition: border-color .2s; }
header.scrolled { border-bottom-color: var(--sep); }
.top { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
.top h1 { font-size: 22px; font-weight: 700; margin: 0; letter-spacing: -0.01em; }
.top .count { color: var(--hint); font-size: 13px; }
.sort { color: var(--link); font-size: 14px; white-space: nowrap; }
.search { position: relative; }
.search svg { position: absolute; left: 10px; top: 50%; transform: translateY(-50%); width: 16px; height: 16px; color: var(--hint); }
.search input { width: 100%; border: 0; outline: 0; border-radius: 10px; background: var(--bg2); color: var(--text);
  font: inherit; font-size: 16px; padding: 8px 12px 8px 34px; -webkit-appearance: none; }
.search input::placeholder { color: var(--hint); }
.chips { display: flex; gap: 6px; overflow-x: auto; margin: 10px -16px 0; padding: 0 16px; scrollbar-width: none; }
.chips::-webkit-scrollbar { display: none; }
.chip { flex: none; padding: 5px 12px; border-radius: 15px; background: var(--bg2); font-size: 13px; white-space: nowrap; }
.chip.on { background: var(--accent); color: var(--accent-text); }

/* ---------- сетка */
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(104px, 1fr)); gap: 20px 14px; padding: 14px 16px 40px;
  align-items: start; }
.card { display: block; text-align: left; min-width: 0; }
.card:active .cover { transform: scale(.97); }
.t { font-size: 13px; font-weight: 600; line-height: 1.25; margin-top: 8px;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.a { font-size: 12px; color: var(--hint); margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

/* ---------- обложка: из EPUB или нарисованная «сшитая книга» */
.cover { position: relative; aspect-ratio: 2 / 3; border-radius: 4px 7px 7px 4px; overflow: hidden; container-type: inline-size;
  box-shadow: 0 1px 2px rgba(0,0,0,.2), 0 8px 18px -8px rgba(0,0,0,.45); transition: transform .15s; background: var(--bg2); }
.cover img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; opacity: 0; transition: opacity .3s; }
.cover img.ok { opacity: 1; }
.gen { position: absolute; inset: 0; background-color: var(--c);
  background-image: radial-gradient(120% 80% at 70% 10%, rgba(255,255,255,.14), transparent 60%),
    linear-gradient(180deg, rgba(0,0,0,0) 40%, rgba(0,0,0,.28)); }
.gen::before { content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 10%;
  background: rgba(0,0,0,.2); box-shadow: inset -1px 0 rgba(255,255,255,.12); }
.gen::after { content: ""; position: absolute; left: 0; top: 4%; bottom: 4%; width: 13%;
  background: repeating-linear-gradient(180deg, transparent 0 calc(23% - 1.5px), rgba(240,228,204,.55) calc(23% - 1.5px) 23%); }
.slip { position: absolute; top: 7%; right: 11%; max-height: 62%; padding: 6cqw 3cqw; background: #efe5cf;
  border: 1px solid rgba(60,40,20,.35); box-shadow: inset 0 0 0 2px #efe5cf, inset 0 0 0 3px rgba(120,40,30,.45);
  text-align: center; overflow: hidden;
  font-family: "Songti SC", "STSong", "Noto Serif CJK SC", "Source Han Serif SC", serif; color: #2a1d12;
  font-size: 13.5cqw; line-height: 1.12; }
.gen .ru { position: absolute; left: 16%; right: 9%; bottom: 7%; color: #f4ead6;
  font-family: Georgia, "Times New Roman", serif; font-size: 10cqw; line-height: 1.15; text-shadow: 0 1px 2px rgba(0,0,0,.35);
  display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden; }
.gen.solo .ru { top: 14%; bottom: auto; font-size: 12.5cqw; -webkit-line-clamp: 6; }
.badge { position: absolute; left: 4px; top: 4px; z-index: 2; font-size: 11px; line-height: 1; padding: 3px 4px;
  border-radius: 6px; background: rgba(0,0,0,.42); -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px); }

/* ---------- состояния */
.msg { text-align: center; color: var(--hint); padding: 64px 32px; }
.msg b { display: block; color: var(--text); font-size: 17px; margin-bottom: 6px; }
.skel .cover { animation: pulse 1.2s ease-in-out infinite alternate; box-shadow: none; }
.skel .t, .skel .a { height: 10px; border-radius: 5px; background: var(--bg2); color: transparent; }
.skel .a { width: 60%; margin-top: 6px; }
@keyframes pulse { to { opacity: .45; } }

/* ---------- карточка книги */
.sheet { position: fixed; inset: 0; z-index: 10; background: var(--bg); overflow-y: auto;
  transform: translateX(100%); transition: transform .28s cubic-bezier(.3,.7,.2,1); visibility: hidden; }
.sheet.open { transform: none; visibility: visible; }
.hero { display: flex; gap: 16px; padding: 20px 16px 16px; align-items: flex-end; }
.hero .cover { width: 116px; flex: none; }
.hero h2 { font-size: 20px; line-height: 1.2; margin: 0 0 4px; letter-spacing: -0.01em; }
.hero .orig { font-size: 15px; color: var(--hint); margin-bottom: 6px; }
.hero .by { font-size: 14px; }
.tags { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
.tag { font-size: 12px; padding: 3px 8px; border-radius: 6px; background: var(--bg2); color: var(--hint); }
.sec { margin: 0 16px 14px; padding: 12px 14px; background: var(--bg2); border-radius: 12px; }
.sec h3 { margin: 0 0 6px; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; color: var(--hint); }
.sec p { margin: 0; white-space: pre-line; }
.names div + div { margin-top: 3px; }
.actions { margin: 4px 16px 24px; border-radius: 12px; overflow: hidden; background: var(--bg2); }
.actions button { display: block; width: 100%; text-align: left; padding: 12px 14px; color: var(--link); }
.actions button + button { border-top: 0.5px solid var(--sep); }
.actions .del { color: var(--danger); }
.primary { display: block; width: calc(100% - 32px); margin: 0 16px 14px; padding: 13px; border-radius: 10px;
  background: var(--accent); color: var(--accent-text); font-weight: 600; text-align: center; }
.tg .primary { display: none; }

.toast { position: fixed; left: 50%; bottom: calc(20px + env(safe-area-inset-bottom)); z-index: 20; max-width: calc(100% - 32px);
  transform: translate(-50%, 20px); opacity: 0; transition: .25s; pointer-events: none;
  background: rgba(30,30,34,.92); color: #fff; padding: 10px 14px; border-radius: 10px; font-size: 14px; }
.toast.show { transform: translate(-50%, 0); opacity: 1; }
</style>
</head>
<body>
<header id="head">
  <div class="top">
    <div><h1>Библиотека</h1><div class="count" id="count">&nbsp;</div></div>
    <button class="sort" id="sort">Сначала новые</button>
  </div>
  <label class="search">
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="7" cy="7" r="5"/><path d="m11 11 3.5 3.5"/></svg>
    <input id="q" type="search" placeholder="Название, автор, 中文, pinyin" autocomplete="off">
  </label>
  <div class="chips" id="chips"></div>
</header>
<main class="grid" id="grid"></main>

<section class="sheet" id="sheet" aria-hidden="true"></section>
<div class="toast" id="toast"></div>

<script>
(function () {
  var tg = window.Telegram && Telegram.WebApp;
  var INIT = tg ? tg.initData : "";
  if (tg && INIT) {
    document.documentElement.classList.add("tg");
    tg.ready(); tg.expand();
  }
  var MODES = {
    ru: { icon: "🇷🇺", name: "Перевод", chip: "Переводы" },
    bi: { icon: "🔀", name: "Китайский + русский", chip: "Двуязычные" },
    orig: { icon: "📖", name: "Оригинал", chip: "Оригиналы" },
    lib: { icon: "📗", name: "Загружено", chip: "Загруженные" }
  };
  var COLORS = ["#2f4a6d", "#7a2f2a", "#2e5b4e", "#86642c", "#56395a", "#3d4a55", "#3a5233", "#6a4632", "#24515e", "#7b3d55"];
  var st = { books: [], token: "", q: "", mode: "all", sort: "date", cur: null };
  var $ = function (id) { return document.getElementById(id); };

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function norm(x) {
    return String(x || "").toLowerCase().replace(/ё/g, "е").replace(/й/g, "\u0000").normalize("NFD")
      .replace(/\p{M}/gu, "").replace(/\u0000/g, "й").replace(/[\s\p{P}\p{S}]+/gu, "");
  }
  function plural(n, a, b, c) {
    var m = n % 10, h = n % 100;
    return n + " " + (m === 1 && h !== 11 ? a : m >= 2 && m <= 4 && (h < 12 || h > 14) ? b : c);
  }
  function hash(s) { var h = 0; for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; }
  function date(d) {
    if (!d) return "";
    try { return new Date(d).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" }); }
    catch (e) { return d.slice(0, 10); }
  }
  function haptic(kind) { try { tg && tg.HapticFeedback && tg.HapticFeedback.impactOccurred(kind || "light"); } catch (e) {} }
  var toastTimer;
  function toast(text) {
    var t = $("toast"); t.textContent = text; t.classList.add("show");
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.classList.remove("show"); }, 2600);
  }

  async function api(path, body) {
    var r = await fetch(path, { method: body ? "POST" : "GET",
      headers: { "x-init-data": INIT, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    var j = await r.json().catch(function () { return {}; });
    if (!r.ok) throw new Error(j.error || ("Ошибка " + r.status));
    return j;
  }

  // ---------- обложка
  function cover(b) {
    var title = b.t || b.o || "Без названия";
    var han = (b.o || b.t || "").match(/[㐀-鿿豈-﫿]/g);
    var html = '<div class="gen' + (han ? "" : " solo") + '" style="--c:' + COLORS[hash(b.o || title) % COLORS.length] + '">' +
      (han ? '<div class="slip">' + han.slice(0, 6).map(esc).join("<br>") + "</div>" : "") +
      (b.t && (!han || b.t !== b.o) ? '<div class="ru">' + esc(title) + "</div>" : "") + "</div>";
    if (b.c !== 0 && st.token)
      html += '<img alt="" loading="lazy" decoding="async" src="/cover/' + b.k + "?t=" + st.token +
        "&v=" + encodeURIComponent(b.d || "") + '" onload="this.classList.add(\'ok\')" onerror="this.remove()">';
    return html;
  }

  // ---------- список
  function visible() {
    var words = st.q.split(/\s+/).map(norm).filter(Boolean);
    var list = st.books.filter(function (b) {
      if (st.mode !== "all" && b.m !== st.mode) return false;
      if (!words.length) return true;
      var hay = [b.s, norm(b.t), norm(b.o), norm(b.a)].join("|");
      return words.every(function (w) { return hay.indexOf(w) >= 0; });
    });
    if (st.sort === "title") list.sort(function (a, b) { return (a.t || a.o || "").localeCompare(b.t || b.o || "", "ru"); });
    return list;
  }

  function renderChips() {
    var counts = {};
    st.books.forEach(function (b) { counts[b.m] = (counts[b.m] || 0) + 1; });
    var keys = Object.keys(MODES).filter(function (m) { return counts[m]; });
    if (keys.length < 2) { $("chips").innerHTML = ""; $("chips").style.display = "none"; return; }
    $("chips").style.display = "";
    $("chips").innerHTML = '<button class="chip' + (st.mode === "all" ? " on" : "") + '" data-m="all">Все</button>' +
      keys.map(function (m) {
        return '<button class="chip' + (st.mode === m ? " on" : "") + '" data-m="' + m + '">' +
          MODES[m].icon + " " + MODES[m].chip + " · " + counts[m] + "</button>";
      }).join("");
  }

  function render() {
    var list = visible();
    $("count").textContent = plural(st.books.length, "книга", "книги", "книг") +
      (list.length !== st.books.length ? " · найдено " + list.length : "");
    if (!st.books.length) {
      $("grid").innerHTML = '<div class="msg" style="grid-column:1/-1"><b>Пока пусто</b>' +
        "Пришлите боту ссылку на книгу или готовый EPUB, и он появится здесь.</div>";
      return;
    }
    if (!list.length) {
      $("grid").innerHTML = '<div class="msg" style="grid-column:1/-1"><b>Ничего не нашлось</b>' +
        "Попробуйте другое слово: подойдёт и китайское название, и пиньинь без тонов.</div>";
      return;
    }
    $("grid").innerHTML = list.map(function (b) {
      var sub = b.a || (b.o && b.o !== b.t ? b.o : "") || (b.n ? plural(b.n, "глава", "главы", "глав") : "");
      return '<button class="card" data-k="' + b.k + '"><div class="cover">' +
        '<span class="badge">' + (MODES[b.m] ? MODES[b.m].icon : "📘") + "</span>" + cover(b) + "</div>" +
        '<div class="t">' + esc(b.t || b.o || "Без названия") + "</div>" +
        '<div class="a">' + esc(sub) + "</div></button>";
    }).join("");
  }

  async function load() {
    $("grid").innerHTML = new Array(9).join('<div class="card skel"><div class="cover"></div><div class="t">.</div><div class="a">.</div></div>');
    if (!INIT) {
      $("grid").innerHTML = '<div class="msg" style="grid-column:1/-1"><b>Откройте из Telegram</b>' +
        "Библиотека работает внутри бота: кнопка «Библиотека» рядом с полем ввода.</div>";
      return;
    }
    try {
      var j = await api("/api/books");
      st.books = j.books; st.token = j.token;
      renderChips(); render();
    } catch (e) {
      $("grid").innerHTML = '<div class="msg" style="grid-column:1/-1"><b>Не удалось открыть</b>' + esc(e.message) + "</div>";
    }
  }

  // ---------- карточка книги
  function sheetHtml(b, d) {
    d = d || {};
    var info = d.info || {};
    var mode = MODES[b.m] || { icon: "📘", name: "" };
    var author = info.author || b.a || "";
    if (info.orig_author && info.orig_author !== author) author += (author ? " · " : "") + info.orig_author;
    var tags = [mode.icon + " " + mode.name];
    if (b.n) tags.push(plural(b.n, "глава", "главы", "глав"));
    if (info.genre) tags.push(info.genre);
    if (info.series) tags.push(info.series);
    var names = [info.title_ru, info.title_literal, info.title_en, info.title_pinyin].filter(function (x) { return x && x !== b.t && x !== b.o; });
    var html = '<div class="hero"><div class="cover">' + cover(b) + "</div><div>" +
      "<h2>" + esc(b.t || b.o || "Без названия") + "</h2>" +
      (b.o && b.o !== b.t ? '<div class="orig">' + esc(b.o) + "</div>" : "") +
      (author ? '<div class="by">' + esc(author) + "</div>" : "") +
      '<div class="tags">' + tags.map(function (t) { return '<span class="tag">' + esc(t) + "</span>"; }).join("") + "</div>" +
      "</div></div>";
    html += '<button class="primary" data-act="send">Прислать в чат' + (d.format ? " · " + d.format.toUpperCase() : "") + "</button>";
    if (d.other) html += '<div class="actions"><button data-act="other">📥 Прислать в ' + d.other.toUpperCase() +
      (d.other_ready ? "" : " (соберу за минуту)") + "</button></div>";
    if (info.synopsis) html += '<div class="sec"><h3>О книге</h3><p>' + esc(info.synopsis) + "</p></div>";
    else if (!d.info) html += '<div class="sec skel"><h3>О книге</h3><div class="t">.</div><div class="a">.</div></div>';
    else if (d.describe) html += '<div class="sec"><h3>О книге</h3><p style="color:var(--hint)">Описания пока нет. ' +
      "Нажмите «Составить описание» ниже: бот прочитает начало книги и определит название, автора и жанр.</p></div>";
    if (names.length) html += '<div class="sec names"><h3>Другие названия</h3>' +
      names.map(function (n) { return "<div>" + esc(n) + "</div>"; }).join("") + "</div>";
    if (b.d) html += '<div class="sec"><h3>В библиотеке</h3><p>с ' + esc(date(b.d)) + "</p></div>";
    html += '<div class="actions">' + (d.rebuild ? '<button data-act="edit">✏️ Название и обложка</button>' +
      '<button data-act="rebuild">🔄 Собрать заново</button>' : "") +
      (d.describe ? '<button data-act="describe">📝 ' + (d.described ? "Составить описание заново" : "Составить описание") + "</button>" : "") +
      '<button class="del" data-act="delete">🗑 Убрать из библиотеки</button></div>';
    return html;
  }

  async function openBook(k) {
    var b = st.books.find(function (x) { return x.k === k; });
    if (!b) return;
    haptic();
    st.cur = b;
    st.detail = null;
    var sh = $("sheet");
    sh.innerHTML = sheetHtml(b); sh.scrollTop = 0;
    sh.classList.add("open"); sh.setAttribute("aria-hidden", "false");
    if (tg && INIT) {
      tg.BackButton.show();
      tg.MainButton.setParams({ text: "Прислать в чат", is_visible: true, is_active: true });
    }
    try {
      var d = await api("/api/book?k=" + k);
      if (d.cover !== undefined) b.c = d.cover;
      if (d.info && d.info.author && !b.a) b.a = d.info.author;
      st.detail = d;
      if (st.cur === b) sh.innerHTML = sheetHtml(b, d);
    } catch (e) {
      if (st.cur === b) { sh.innerHTML = sheetHtml(b, { info: {} }); toast(e.message); }
    }
  }

  // Подтянуть свежие данные книги (после описания меняются название и автор).
  async function refresh(b) {
    try {
      var j = await api("/api/books");
      st.books = j.books;
      var nb = st.books.find(function (x) { return x.k === b.k; });
      if (nb && st.cur === b) openBook(nb.k);
    } catch (e) {}
  }

  function closeBook() {
    st.cur = null;
    $("sheet").classList.remove("open"); $("sheet").setAttribute("aria-hidden", "true");
    if (tg && INIT) { tg.BackButton.hide(); tg.MainButton.hide(); }
    render();
  }

  function confirmAsk(text) {
    return new Promise(function (res) {
      if (tg && INIT && tg.showConfirm) tg.showConfirm(text, res); else res(window.confirm(text));
    });
  }

  async function act(what) {
    var b = st.cur;
    if (!b) return;
    if (what === "send") {
      if (tg && INIT) tg.MainButton.showProgress();
      try {
        await api("/api/send", { k: b.k });
        haptic("medium");
        toast("Файл отправлен в чат с ботом");
        if (tg && INIT && tg.isVersionAtLeast && !tg.isVersionAtLeast("6.0")) tg.close();
      } catch (e) { toast(e.message); }
      if (tg && INIT) tg.MainButton.hideProgress();
    } else if (what === "other") {
      var d = st.detail || {};
      if (!d.other) return;
      try {
        var r = await api("/api/other", { k: b.k, f: d.other });
        haptic("medium");
        toast(r.started ? "Собираю " + d.other.toUpperCase() + " — файл придёт в чат" : "Файл отправлен в чат с ботом");
        if (r.started) setTimeout(function () { if (st.cur === b) refresh(b); }, 90000);
      } catch (e) { toast(e.message); }
    } else if (what === "rebuild") {
      if (!await confirmAsk("Перевести «" + (b.t || b.o) + "» заново? Новый файл заменит этот, перевод снова будет стоить денег.")) return;
      try { await api("/api/rebuild", { k: b.k }); toast("Запущено — прогресс в чате с ботом"); }
      catch (e) { toast(e.message); }
    } else if (what === "edit") {
      try { await api("/api/edit", { k: b.k }); toast("Меню изменений — в чате с ботом"); }
      catch (e) { toast(e.message); }
    } else if (what === "describe") {
      try {
        await api("/api/describe", { k: b.k });
        toast("Составляю описание — около минуты");
        setTimeout(function () { if (st.cur === b) refresh(b); }, 60000);
      } catch (e) { toast(e.message); }
    } else if (what === "delete") {
      if (!await confirmAsk("Убрать «" + (b.t || b.o) + "» из библиотеки?")) return;
      try {
        await api("/api/delete", { k: b.k });
        st.books = st.books.filter(function (x) { return x !== b; });
        renderChips(); closeBook(); toast("Книга убрана из библиотеки");
      } catch (e) { toast(e.message); }
    }
  }

  // ---------- события
  $("grid").addEventListener("click", function (e) {
    var c = e.target.closest(".card[data-k]"); if (c) openBook(c.getAttribute("data-k"));
  });
  $("sheet").addEventListener("click", function (e) {
    var a = e.target.closest("[data-act]"); if (a) act(a.getAttribute("data-act"));
  });
  $("chips").addEventListener("click", function (e) {
    var c = e.target.closest(".chip"); if (!c) return;
    st.mode = c.getAttribute("data-m"); haptic(); renderChips(); render();
  });
  $("sort").addEventListener("click", function () {
    st.sort = st.sort === "date" ? "title" : "date";
    this.textContent = st.sort === "date" ? "Сначала новые" : "По алфавиту";
    render();
  });
  $("q").addEventListener("input", function () { st.q = this.value; render(); });
  $("q").addEventListener("keydown", function (e) { if (e.key === "Enter") this.blur(); });
  window.addEventListener("scroll", function () { $("head").classList.toggle("scrolled", window.scrollY > 4); }, { passive: true });
  if (tg && INIT) {
    tg.BackButton.onClick(closeBook);
    tg.MainButton.onClick(function () { act("send"); });
  }
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && st.cur) closeBook(); });
  load();
})();
</script>
</body>
</html>
`;

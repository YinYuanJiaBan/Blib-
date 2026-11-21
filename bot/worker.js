// Telegram-бот «Книга в EPUB» — Cloudflare Worker.
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
  "📚 Я собираю книги с kanunu8.com в EPUB и перевожу их на русский.\n\n" +
  "• Пришлите ссылку на оглавление книги.\n" +
  "• Или пришлите файл .epub, и я его переведу.\n\n" +
  "Дополнительно в том же сообщении (необязательно):\n" +
  "• число — сколько первых глав взять, например: 3\n" +
  "• глоссарий имён, по строке на имя: 顾茫 = Гу Ман\n" +
  "• «без сносок» — не пояснять идиомы и метафоры\n\n" +
  "В переводе идиомы (成语), метафоры и аллюзии получают сноски: иероглифы, пиньинь, " +
  "дословный перевод и настоящий смысл. В книге сноска открывается нажатием на номер.\n\n" +
  "Сначала придёт справка о книге: русское название, о чём она, персонажи и термины. " +
  "Эти имена бот сам использует в переводе. Если имя не нравится, добавьте свою строку в глоссарий.\n\n" +
  "Перевод делает DeepSeek через OpenRouter. Готовый файл придёт сюда же.\n\n" +
  "📚 Готовые книги сохраняются: если попросить ту же книгу ещё раз, файл придёт сразу, " +
  "без нового перевода. Можно просто написать название (русское, китайское или английское) " +
  "или автора, и я найду книгу в библиотеке. /library — все сохранённые книги.";

const BUTTONS = {
  orig: "📖 Оригинал",
  ru: "🇷🇺 Перевод",
  bi: "🔀 Китайский + русский"
};
const ICONS = { orig: "📖", ru: "🇷🇺", bi: "🔀" };
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
      await tg(env, "setMyCommands", { commands: [
        { command: "help", description: "Как пользоваться" },
        { command: "library", description: "Сохранённые книги" },
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

    // Сюда задача из GitHub Actions сообщает о готовой книге, чтобы сохранить её в библиотеке.
    if (url.pathname === "/saved" && request.method === "POST") return onSaved(env, request);

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
  return { link, glossary: glossary.slice(0, 3000), limit, notes };
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
  if (text.startsWith("/start") || text.startsWith("/help")) return say(env, chat, HELP);
  if (text.startsWith("/library") || text.startsWith("/books")) {
    const q = text.replace(/^\/\S+\s*/, "");
    return q ? findBooks(env, chat, q) : showLibrary(env, chat);
  }

  const doc = msg.document;
  if (doc) {
    if (!/\.epub$/i.test(doc.file_name || "")) return say(env, chat, "Я понимаю только файлы .epub.");
    if (doc.file_size > 20 * 1024 * 1024) return say(env, chat, "Файл больше 20 МБ, Telegram не даст боту его скачать.");
    return ask(env, msg, ["ru", "bi"], "Что сделать с этим EPUB?");
  }

  const req = parseRequest(text);
  if (req.link) return ask(env, msg, ["orig", "ru", "bi"], "Как собрать книгу?" +
    (req.limit ? `\nГлав: первые ${req.limit}` : "") + (req.notes ? "" : "\nБез сносок") + (req.glossary ? `\nСтрок в глоссарии: ${req.glossary.split("\n").length}` : ""));

  // Без ссылки — ищем книгу в библиотеке по названию или автору.
  if (text && !text.startsWith("/")) return findBooks(env, chat, text);

  return say(env, chat, "Пришлите ссылку на оглавление книги с kanunu8.com, файл .epub или название книги.\n/help — подробнее");
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
  const [action, arg] = (cq.data || "").split(":");
  const msg = cq.message;

  // Книга из списка /library.
  if (action === "get") {
    const saved = env.BOOKS && await env.BOOKS.get("book:" + arg, "json");
    if (!saved) return done("Этой книги больше нет в библиотеке");
    await sendSaved(env, msg.chat.id, saved, arg);
    return done("Отправляю");
  }
  // «Собрать заново» под файлом из библиотеки: те же ссылка и настройки, что в прошлый раз.
  if (action === "rb") {
    const saved = env.BOOKS && await env.BOOKS.get("book:" + arg, "json");
    const q = saved && saved.req;
    if (!q || !(q.url || q.file_id) || !BUTTONS[q.mode]) return done("Не знаю, откуда собирать — пришлите ссылку ещё раз");
    const st = await say(env, msg.chat.id, `⏳ ${BUTTONS[q.mode]}: «${saved.title || saved.orig_title}» — собираю заново…`);
    const payload = { ...q, chat_id: msg.chat.id, status_id: st && st.result && st.result.message_id,
      save: { url: ORIGIN + "/saved", key: arg, sig: await sign(env, arg) } };
    return done(await dispatch(env, msg.chat.id, payload) ? "Запущено!" : "Ошибка запуска");
  }
  if (action === "del") {
    if (env.BOOKS) await env.BOOKS.delete("book:" + arg);
    await tg(env, "editMessageReplyMarkup", { chat_id: msg.chat.id, message_id: msg.message_id,
      reply_markup: { inline_keyboard: [] } });
    return done("Удалено из библиотеки");
  }

  const mode = arg;
  if (!["go", "re"].includes(action) || !BUTTONS[mode]) return done("Неизвестная команда");
  const src = msg && msg.reply_to_message;
  if (!src) return done("Не нашла исходное сообщение — пришлите ссылку ещё раз");

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

  // Та же книга с теми же настройками уже готова — отдаём сохранённый файл.
  const key = await bookKey(mode, source, req);
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

async function dispatch(env, chat_id, payload) {
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
  await say(env, chat_id, `❌ GitHub не принял задачу (${r.status}). Проверьте GH_TOKEN и GH_REPO.\n${t}`);
  return false;
}

// ---------------------------------------------------------------- библиотека
// Сами файлы хранит Telegram (по file_id), в KV лежит только запись о книге.

function normLink(link) {
  return link.trim().replace(/^https?:\/\/(?:www\.)?/i, "").replace(/[#?].*$/, "").replace(/\/+$/, "").toLowerCase();
}

async function bookKey(mode, source, req) {
  const raw = JSON.stringify([mode, source, req.limit || "", req.glossary || "", req.notes]);
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw)));
  return [...h.slice(0, 12)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sign(env, key) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const s = new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode("book:" + key)));
  return [...s].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sendSaved(env, chat_id, saved, key) {
  const row = [{ text: "🗑 Убрать из библиотеки", callback_data: "del:" + key }];
  if (saved.req) row.unshift({ text: "🔄 Собрать заново", callback_data: "rb:" + key });
  const date = saved.date ? `\nСохранено: ${saved.date.slice(0, 10)}` : "";
  // Длинная книга хранится несколькими томами: шлём их по порядку, подпись и кнопки — у последнего.
  const ids = Array.isArray(saved.file_ids) && saved.file_ids.length ? saved.file_ids : [saved.file_id];
  for (let i = 0; i < ids.length - 1; i++) {
    await tg(env, "sendDocument", { chat_id, document: ids[i], caption: `📕 Книга ${i + 1} из ${ids.length}` });
  }
  const last = ids.length > 1 ? `\n📕 Книга ${ids.length} из ${ids.length}` : "";
  return tg(env, "sendDocument", { chat_id, document: ids[ids.length - 1],
    caption: (saved.caption || "").slice(0, 940) + last + date, reply_markup: { inline_keyboard: [row] } });
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
  const rec = {
    file_id: String(b.file_id),
    file_ids: (Array.isArray(b.file_ids) ? b.file_ids : []).map(String).filter(Boolean).slice(0, 50),
    title: String(b.title || "").slice(0, 200),
    orig_title: String(b.orig_title || "").slice(0, 200), mode: String(b.mode || ""),
    chapters: b.chapters || 0, caption: String(b.caption || "").slice(0, 1000), date: new Date().toISOString(),
    names: (Array.isArray(b.names) ? b.names : []).map((x) => String(x).slice(0, 200)).filter(Boolean).slice(0, 12),
    req: b.request && typeof b.request === "object" ? b.request : null
  };
  // Все варианты названия и автор — в метаданных, чтобы искать без чтения каждой записи.
  const names = [...new Set([rec.title, rec.orig_title, ...rec.names].map(norm).filter(Boolean))].join("|");
  await env.BOOKS.put("book:" + b.key, JSON.stringify(rec), {
    metadata: { t: cutBytes(rec.title, 160), o: cutBytes(rec.orig_title, 90), m: rec.mode, n: rec.chapters,
      d: rec.date, s: cutBytes(names, 600) }
  });
  return new Response("ok");
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
  return say(env, chat, `📚 Сохранённые книги: ${items.length}` +
    (items.length > shown.length ? ` (показаны последние ${shown.length})` : "") +
    "\nНажмите, чтобы получить файл. Или напишите название, чтобы найти книгу.",
    { reply_markup: { inline_keyboard: bookButtons(shown) } });
}

async function findBooks(env, chat, query) {
  if (!env.BOOKS) return say(env, chat, "Пришлите ссылку на оглавление книги с kanunu8.com или файл .epub.\n/help — подробнее");
  const words = query.split(/\s+/).map(norm).filter(Boolean);
  if (!words.length) return say(env, chat, "Напишите название книги или пришлите ссылку.");
  const found = (await listBooks(env)).filter((k) => {
    const m = k.metadata || {};
    const hay = [m.s, norm(m.t), norm(m.o)].join("|");
    return words.every((w) => hay.includes(w));
  });
  if (!found.length) {
    return say(env, chat, `🔍 «${query.slice(0, 100)}» в библиотеке нет.\n` +
      "Пришлите ссылку на оглавление книги с kanunu8.com или файл .epub, и я её соберу. /library — все книги.");
  }
  if (found.length === 1) {
    const key = found[0].name.slice(5);
    const saved = await env.BOOKS.get(found[0].name, "json");
    if (saved) return sendSaved(env, chat, saved, key);
  }
  return say(env, chat, `🔍 Нашлось книг: ${found.length}` + (found.length > 30 ? " (показаны 30)" : "") +
    ". Какую прислать?", { reply_markup: { inline_keyboard: bookButtons(found.slice(0, 30)) } });
}

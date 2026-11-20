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

const HELP =
  "📚 Я собираю книги с kanunu8.com в EPUB и перевожу их на русский.\n\n" +
  "• Пришлите ссылку на оглавление книги.\n" +
  "• Или пришлите файл .epub, и я его переведу.\n\n" +
  "Дополнительно в том же сообщении (необязательно):\n" +
  "• число — сколько первых глав взять, например: 3\n" +
  "• глоссарий имён, по строке на имя: 顾茫 = Гу Ман\n\n" +
  "Перевод делает DeepSeek через OpenRouter. Готовый файл придёт сюда же.";

const BUTTONS = {
  orig: "📖 Оригинал",
  ru: "🇷🇺 Перевод",
  bi: "🔀 Китайский + русский"
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

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
        { command: "id", description: "Мой Telegram ID" }
      ] });
      const check = [
        ["BOT_TOKEN", !!env.BOT_TOKEN], ["WEBHOOK_SECRET", !!env.WEBHOOK_SECRET],
        ["GH_TOKEN", !!env.GH_TOKEN], ["GH_REPO", !!env.GH_REPO], ["ALLOWED_USERS", !!env.ALLOWED_USERS]
      ].map(([k, ok]) => `${ok ? "✅" : "❌"} ${k}`).join("\n");
      return new Response(`Webhook: ${hook?.ok ? "✅ установлен" : "❌ " + (hook?.description || "ошибка")}\n\n${check}`,
        { headers: { "content-type": "text/plain; charset=utf-8" } });
    }

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
  return { link, glossary: glossary.slice(0, 3000), limit };
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

  const doc = msg.document;
  if (doc) {
    if (!/\.epub$/i.test(doc.file_name || "")) return say(env, chat, "Я понимаю только файлы .epub.");
    if (doc.file_size > 20 * 1024 * 1024) return say(env, chat, "Файл больше 20 МБ, Telegram не даст боту его скачать.");
    return ask(env, msg, ["ru", "bi"], "Что сделать с этим EPUB?");
  }

  const req = parseRequest(text);
  if (req.link) return ask(env, msg, ["orig", "ru", "bi"], "Как собрать книгу?" +
    (req.limit ? `\nГлав: первые ${req.limit}` : "") + (req.glossary ? `\nСтрок в глоссарии: ${req.glossary.split("\n").length}` : ""));

  return say(env, chat, "Пришлите ссылку на оглавление книги с kanunu8.com или файл .epub.\n/help — подробнее");
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
  const mode = (cq.data || "").replace(/^go:/, "");
  if (!BUTTONS[mode]) return done("Неизвестная команда");

  const msg = cq.message;
  const src = msg && msg.reply_to_message;
  if (!src) return done("Не нашла исходное сообщение — пришлите ссылку ещё раз");

  const payload = { chat_id: msg.chat.id, status_id: msg.message_id, mode };
  const req = parseRequest((src.text || src.caption || "").trim());
  if (src.document) {
    payload.file_id = src.document.file_id;
    payload.file_name = src.document.file_name || "book.epub";
  } else if (req.link) {
    payload.url = req.link;
  } else {
    return done("В исходном сообщении нет ссылки");
  }
  if (req.limit) payload.limit = req.limit;
  if (req.glossary) payload.glossary = req.glossary;

  await tg(env, "editMessageText", {
    chat_id: msg.chat.id, message_id: msg.message_id,
    text: `⏳ ${BUTTONS[mode]}: задача отправлена, запуск займёт до минуты…`
  });

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
  if (r.status !== 204) {
    const t = (await r.text()).slice(0, 200);
    await tg(env, "editMessageText", {
      chat_id: msg.chat.id, message_id: msg.message_id,
      text: `❌ GitHub не принял задачу (${r.status}). Проверьте GH_TOKEN и GH_REPO.\n${t}`
    });
    return done("Ошибка запуска");
  }
  return done("Запущено!");
}

// Фоновый сервис: выполняет запросы к переводчику (обходит CORS страницы).
const ENDPOINT = "https://translate.googleapis.com/translate_a/t";

async function translateBatch(texts, from = "zh-CN", to = "ru") {
  const url = `${ENDPOINT}?client=gtx&sl=${encodeURIComponent(from)}&tl=${encodeURIComponent(to)}&format=text`;
  const body = new URLSearchParams();
  for (const t of texts) body.append("q", t);

  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
        body
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      // Ответ: ["перевод", ...] либо [["перевод","zh-CN"], ...]
      const list = Array.isArray(data) ? data : [data];
      return list.map((item) => (Array.isArray(item) ? item[0] : item));
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  throw lastErr;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "translate") {
    translateBatch(msg.texts, msg.from, msg.to)
      .then((translations) => sendResponse({ ok: true, translations }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true; // асинхронный ответ
  }
});

async function sendToTab(tabId, action) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: action });
  } catch (_) {
    /* на служебных страницах контент-скрипта нет */
  }
}

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "toggle-translation") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) sendToTab(tab.id, "toggle");
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "translate-page",
    title: "Перевести страницу на русский",
    contexts: ["page", "selection"]
  });
  chrome.contextMenus.create({
    id: "restore-page",
    title: "Показать оригинал",
    contexts: ["page", "selection"]
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id) return;
  sendToTab(tab.id, info.menuItemId === "restore-page" ? "restore" : "translate");
});

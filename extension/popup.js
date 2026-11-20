const $ = (id) => document.getElementById(id);

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function send(type) {
  const tab = await activeTab();
  try {
    return await chrome.tabs.sendMessage(tab.id, { type });
  } catch {
    $("status").textContent = "На этой странице перевод недоступен (обновите вкладку).";
    return null;
  }
}

(async () => {
  const tab = await activeTab();
  const host = tab?.url ? new URL(tab.url).hostname : "";
  const cfg = await chrome.storage.sync.get({ autoTranslate: false, neverSites: [] });
  $("auto").checked = cfg.autoTranslate;
  $("never").checked = cfg.neverSites.includes(host);

  const st = await send("status");
  if (st) $("status").textContent = st.active ? "Страница переведена" : st.hasChinese ? "Обнаружен китайский текст" : "";

  $("translate").onclick = async () => { await send("translate"); window.close(); };
  $("restore").onclick = async () => { await send("restore"); window.close(); };
  $("auto").onchange = (e) => chrome.storage.sync.set({ autoTranslate: e.target.checked });
  $("never").onchange = async (e) => {
    const { neverSites } = await chrome.storage.sync.get({ neverSites: [] });
    const set = new Set(neverSites);
    e.target.checked ? set.add(host) : set.delete(host);
    chrome.storage.sync.set({ neverSites: [...set] });
  };
})();

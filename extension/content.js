// Контент-скрипт: находит китайский текст на странице и заменяет его переводом.
(() => {
  if (window.__zhRuTranslator) return;
  window.__zhRuTranslator = true;

  const CJK = /[㐀-䶿一-鿿豈-﫿　-〿＀-￯]/;
  const HAN = /[㐀-䶿一-鿿豈-﫿]/;
  const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "CODE", "SVG", "MATH", "IFRAME", "TEMPLATE"]);
  const ATTRS = ["title", "placeholder", "alt", "aria-label"];
  const MAX_BATCH_CHARS = 4000;
  const MAX_BATCH_ITEMS = 100;

  const cache = new Map();          // китайский текст -> перевод
  const textOriginals = new Map();  // Text node -> исходный текст
  const attrOriginals = new Map();  // Element -> {attr: исходное значение}
  let originalTitle = null;
  let active = false;
  let busy = false;
  let pending = false;
  let observer = null;
  let debounceTimer = null;

  // ---------- сбор узлов ----------
  function isSkipped(el) {
    for (let e = el; e; e = e.parentElement) {
      if (SKIP_TAGS.has(e.tagName)) return true;
      if (e.isContentEditable) return true;
      if (e.classList?.contains("notranslate") || e.getAttribute?.("translate") === "no") return true;
    }
    return false;
  }

  function collect(root) {
    const textNodes = [];
    const attrItems = [];
    if (!root) return { textNodes, attrItems };

    if (root.nodeType === Node.TEXT_NODE) {
      if (HAN.test(root.nodeValue) && !isSkipped(root.parentElement)) textNodes.push(root);
      return { textNodes, attrItems };
    }
    if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_NODE) {
      return { textNodes, attrItems };
    }

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!HAN.test(node.nodeValue)) return NodeFilter.FILTER_REJECT;
        if (isSkipped(node.parentElement)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    let n;
    while ((n = walker.nextNode())) textNodes.push(n);

    const base = root.nodeType === Node.DOCUMENT_NODE ? root.documentElement : root;
    const els = [base, ...base.querySelectorAll(ATTRS.map((a) => `[${a}]`).join(","))];
    for (const el of els) {
      if (!el.getAttribute) continue;
      for (const a of ATTRS) {
        const v = el.getAttribute(a);
        if (v && HAN.test(v) && !isSkipped(el)) attrItems.push({ el, attr: a });
      }
      if (el.tagName === "INPUT" && /^(button|submit|reset)$/i.test(el.type) && HAN.test(el.value)) {
        attrItems.push({ el, attr: "value" });
      }
    }
    return { textNodes, attrItems };
  }

  // ---------- перевод ----------
  function splitWs(s) {
    const m = s.match(/^(\s*)([\s\S]*?)(\s*)$/);
    return { lead: m[1], core: m[2], trail: m[3] };
  }

  function endsWithSpace(node) {
    const t = node.textContent || "";
    return !t || /\s$/.test(t);
  }
  function startsWithPunct(node) {
    const t = node.textContent || "";
    return !t || /^[\s,.;:!?)\]»，。；：！？、）]/.test(t);
  }

  function requestTranslation(texts) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: "translate", texts, from: "zh-CN", to: "ru" }, (res) => {
        if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
        if (!res?.ok) return reject(new Error(res?.error || "Ошибка перевода"));
        resolve(res.translations);
      });
    });
  }

  async function fillCache(texts) {
    const todo = [...new Set(texts)].filter((t) => !cache.has(t));
    const batches = [];
    let cur = [];
    let len = 0;
    for (const t of todo) {
      if (cur.length && (len + t.length > MAX_BATCH_CHARS || cur.length >= MAX_BATCH_ITEMS)) {
        batches.push(cur);
        cur = [];
        len = 0;
      }
      cur.push(t);
      len += t.length;
    }
    if (cur.length) batches.push(cur);

    // До 4 параллельных запросов
    let i = 0;
    async function worker() {
      while (i < batches.length) {
        const batch = batches[i++];
        try {
          const out = await requestTranslation(batch);
          batch.forEach((src, k) => cache.set(src, out[k] ?? src));
        } catch (e) {
          console.warn("[zh→ru] пакет не переведён:", e);
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(4, batches.length) }, worker));
  }

  async function translateRoot(root) {
    const { textNodes, attrItems } = collect(root);
    const titleNeeds = root === document && document.title && HAN.test(document.title);
    if (!textNodes.length && !attrItems.length && !titleNeeds) return;

    const sources = [];
    for (const n of textNodes) sources.push(splitWs(n.nodeValue).core);
    for (const { el, attr } of attrItems) sources.push((attr === "value" ? el.value : el.getAttribute(attr)).trim());
    if (titleNeeds) sources.push(document.title.trim());

    await fillCache(sources.filter(Boolean));
    if (!active) return;

    for (const n of textNodes) {
      if (!n.isConnected) continue;
      const { lead, core, trail } = splitWs(n.nodeValue);
      const tr = cache.get(core);
      if (!tr || tr === core) continue;
      if (!textOriginals.has(n)) textOriginals.set(n, n.nodeValue);
      // В китайском между словами нет пробелов, а в русском нужны:
      // добавляем пробел на стыке с соседним inline-элементом.
      const l = lead || (n.previousSibling && !/^[\s,.;:!?)\]»]/.test(tr) && !endsWithSpace(n.previousSibling) ? " " : "");
      const t = trail || (n.nextSibling && !startsWithPunct(n.nextSibling) ? " " : "");
      n.nodeValue = l + tr + t;
    }
    for (const { el, attr } of attrItems) {
      const src = (attr === "value" ? el.value : el.getAttribute(attr)).trim();
      const tr = cache.get(src);
      if (!tr) continue;
      const saved = attrOriginals.get(el) || {};
      if (!(attr in saved)) saved[attr] = attr === "value" ? el.value : el.getAttribute(attr);
      attrOriginals.set(el, saved);
      if (attr === "value") el.value = tr;
      else el.setAttribute(attr, tr);
    }
    if (titleNeeds) {
      const tr = cache.get(document.title.trim());
      if (tr) {
        if (originalTitle === null) originalTitle = document.title;
        document.title = tr;
      }
    }
    observer?.takeRecords(); // игнорируем собственные изменения
  }

  // ---------- динамический контент ----------
  const dirtyRoots = new Set();

  function onMutations(records) {
    if (!active) return;
    for (const r of records) {
      if (r.type === "childList") r.addedNodes.forEach((n) => dirtyRoots.add(n));
      else if (r.type === "characterData") dirtyRoots.add(r.target);
      else if (r.type === "attributes") dirtyRoots.add(r.target);
    }
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(flushDirty, 400);
  }

  async function flushDirty() {
    if (busy) { pending = true; return; }
    busy = true;
    try {
      while (dirtyRoots.size && active) {
        const roots = [...dirtyRoots];
        dirtyRoots.clear();
        for (const r of roots) if (r.isConnected) await translateRoot(r);
      }
    } finally {
      busy = false;
      if (pending) { pending = false; flushDirty(); }
    }
  }

  function startObserver() {
    if (observer) return;
    observer = new MutationObserver(onMutations);
    observer.observe(document.documentElement, {
      childList: true, subtree: true, characterData: true,
      attributes: true, attributeFilter: ATTRS
    });
  }

  function stopObserver() {
    observer?.disconnect();
    observer = null;
    dirtyRoots.clear();
    clearTimeout(debounceTimer);
  }

  // ---------- индикатор ----------
  let badge = null;
  function showBadge(text, ms) {
    if (window.top !== window) return;
    if (!badge) {
      badge = document.createElement("div");
      badge.setAttribute("translate", "no");
      badge.style.cssText =
        "position:fixed;z-index:2147483647;right:16px;bottom:16px;padding:8px 14px;" +
        "background:#1f2937;color:#fff;font:13px/1.4 system-ui,sans-serif;border-radius:8px;" +
        "box-shadow:0 4px 14px rgba(0,0,0,.25);pointer-events:none;transition:opacity .3s";
      document.documentElement.appendChild(badge);
    }
    badge.textContent = text;
    badge.style.opacity = "1";
    clearTimeout(badge._t);
    if (ms) badge._t = setTimeout(() => (badge.style.opacity = "0"), ms);
  }

  // ---------- публичные действия ----------
  async function translatePage() {
    if (active) return;
    active = true;
    showBadge("Перевод…");
    startObserver();
    busy = true;
    try {
      await translateRoot(document);
      showBadge("Переведено на русский", 1500);
    } catch (e) {
      showBadge("Ошибка перевода: " + e.message, 4000);
    } finally {
      busy = false;
      if (dirtyRoots.size) flushDirty();
    }
  }

  function restorePage() {
    active = false;
    stopObserver();
    for (const [n, v] of textOriginals) if (n.isConnected) n.nodeValue = v;
    for (const [el, saved] of attrOriginals) {
      for (const [a, v] of Object.entries(saved)) {
        if (a === "value") el.value = v;
        else el.setAttribute(a, v);
      }
    }
    if (originalTitle !== null) document.title = originalTitle;
    textOriginals.clear();
    attrOriginals.clear();
    originalTitle = null;
    showBadge("Оригинал", 1200);
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg?.type) {
      case "translate": translatePage(); break;
      case "restore": restorePage(); break;
      case "toggle": active ? restorePage() : translatePage(); break;
      case "status": sendResponse({ active, hasChinese: looksChinese() }); return;
    }
    sendResponse({ active });
  });

  // ---------- автоперевод ----------
  function looksChinese() {
    const lang = (document.documentElement.lang || "").toLowerCase();
    if (lang.startsWith("zh")) return true;
    const sample = (document.body?.innerText || "").slice(0, 3000);
    if (!sample) return false;
    const han = (sample.match(new RegExp(HAN.source, "g")) || []).length;
    return han > 20 && han / sample.replace(/\s/g, "").length > 0.15;
  }

  chrome.storage.sync.get({ autoTranslate: false, neverSites: [] }, (cfg) => {
    if (!cfg.autoTranslate) return;
    if (cfg.neverSites.includes(location.hostname)) return;
    if (looksChinese()) translatePage();
  });
})();

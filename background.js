// Hexa Image Grabber v4 - background service worker.
// Flow: the popup COLLECTS images page by page into a basket (nothing is
// downloaded yet). One "Download ZIP" click then fetches everything in
// parallel (offscreen worker), builds ONE zip with a subfolder per website,
// and downloads that single file. Keeps the permanent duplicate registry
// (normalised URLs + SHA-256 content hashes).

const OFFSCREEN_URL = "offscreen.html";

// Identical copy lives in util.js (offscreen) - keep them in sync.
function normalizeUrl(u) {
  try {
    const url = new URL(u);
    const junk = ["v", "ver", "version", "utm_source", "utm_medium", "utm_campaign",
      "utm_term", "utm_content", "fbclid", "gclid", "_ga", "cache", "cb", "timestamp", "ts", "rand"];
    for (const p of junk) url.searchParams.delete(p);
    url.searchParams.sort();
    return url.href;
  } catch (e) {
    return u;
  }
}

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
  });
  if (contexts.length === 0) {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ["BLOBS"],
      justification: "Fetch collected images quickly in parallel and build one ZIP file.",
    });
  }
}

async function getBasket() {
  const d = await chrome.storage.local.get({ higBasket: [] });
  return d.higBasket;
}

async function refreshBadge() {
  const d = await chrome.storage.local.get({ higProgress: null, higBasket: [] });
  if (d.higProgress && d.higProgress.running) return; // progress % owns the badge
  const n = (d.higBasket || []).length;
  chrome.action.setBadgeText({ text: n > 0 ? String(n) : "" });
  if (n > 0) chrome.action.setBadgeBackgroundColor({ color: "#b8860b" });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg.type === "BASKET_ADD") {
      const basket = await getBasket();
      const data = await chrome.storage.local.get({ higRegistry: { urls: {}, hashes: {} } });
      const inBasket = new Set(basket.map((b) => normalizeUrl(b.url)));
      let added = 0, skipped = 0;
      for (const it of msg.items || []) {
        const key = normalizeUrl(it.url);
        if (inBasket.has(key) || data.higRegistry.urls[key]) { skipped++; continue; }
        basket.push({ url: it.url, domain: msg.domain || "", w: it.w || 0, h: it.h || 0 });
        inBasket.add(key);
        added++;
      }
      try {
        await chrome.storage.local.set({ higBasket: basket });
      } catch (e) {
        sendResponse({ ok: false, error: "storage full - clear the collection or some saved history first" });
        return;
      }
      await refreshBadge();
      sendResponse({ ok: true, added, skipped, total: basket.length });
      return;
    }

    if (msg.type === "BASKET_CLEAR") {
      await chrome.storage.local.set({ higBasket: [] });
      await refreshBadge();
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === "START_BASKET_ZIP" || msg.type === "START_URL_ZIP") {
      // one job at a time: two runs racing would corrupt progress and counts
      const cur = await chrome.storage.local.get({ higProgress: null });
      if (cur.higProgress && cur.higProgress.running && Date.now() - cur.higProgress.when < 30 * 60 * 1000) {
        sendResponse({ ok: false, error: "busy" });
        return;
      }
    }

    if (msg.type === "START_BASKET_ZIP") {
      const basket = await getBasket();
      if (!basket.length) { sendResponse({ ok: false, error: "basket empty" }); return; }
      const items = basket.map((b) => ({ url: b.url, folder: b.domain, allowDupe: false }));
      await chrome.storage.local.set({
        higProgress: { running: true, done: 0, total: items.length, failed: 0, status: "working", kind: "basket", when: Date.now() },
      });
      await ensureOffscreen();
      // offscreen documents cannot use chrome.storage - pass the registry along
      const data = await chrome.storage.local.get({ higRegistry: { urls: {}, hashes: {} } });
      chrome.runtime.sendMessage({
        type: "RUN_ZIP", items, domain: "collection", folder: msg.folder,
        regUrls: Object.keys(data.higRegistry.urls), regHashes: Object.keys(data.higRegistry.hashes),
      });
      sendResponse({ ok: true, total: items.length });
      return;
    }

    if (msg.type === "START_URL_ZIP") {
      await chrome.storage.local.set({
        higProgress: { running: true, done: 0, total: 0, failed: 0, status: "working", kind: "url", when: Date.now() },
      });
      await ensureOffscreen();
      const data = await chrome.storage.local.get({ higRegistry: { urls: {}, hashes: {} } });
      chrome.runtime.sendMessage({
        type: "RUN_URL_ZIP", urls: msg.urls || [], folder: msg.folder, crawl: !!msg.crawl, maxPages: (typeof msg.maxPages === "number" ? msg.maxPages : 50),
        regUrls: Object.keys(data.higRegistry.urls), regHashes: Object.keys(data.higRegistry.hashes),
      });
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === "CANCEL_JOB") {
      // forwarded to the offscreen worker, which stops at the next batch
      // boundary and still zips whatever it has collected so far
      try { chrome.runtime.sendMessage({ type: "JOB_CANCEL" }); } catch (e) { /* no worker running */ }
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === "ZIP_PROGRESS") {
      const cur = await chrome.storage.local.get({ higProgress: null });
      const kind = cur.higProgress ? cur.higProgress.kind : "basket";
      await chrome.storage.local.set({ higProgress: { running: true, done: msg.done, total: msg.total, failed: msg.failed || 0, status: "working", kind, phase: msg.phase || "", images: msg.images || 0, when: Date.now() } });
      if (msg.total > 0) {
        const pct = Math.min(99, Math.round((msg.done / msg.total) * 100));
        chrome.action.setBadgeText({ text: pct + "%" });
        chrome.action.setBadgeBackgroundColor({ color: "#6a5cff" });
      }
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === "ZIP_DONE") {
      const curP = await chrome.storage.local.get({ higProgress: null });
      const kind = curP.higProgress ? curP.higProgress.kind : "basket";
      // the ONE download of the whole job
      let downloadError = "";
      if (msg.dataUrl && msg.zipName) {
        try { await chrome.downloads.download({ url: msg.dataUrl, filename: msg.zipName, saveAs: false }); }
        catch (e) { downloadError = String(e && e.message || e); }
      }
      // merge newly saved urls + hashes into the permanent registry
      const data = await chrome.storage.local.get({ higRegistry: { urls: {}, hashes: {} } });
      const reg = data.higRegistry;
      for (const u of msg.savedUrls || []) reg.urls[u] = 1;
      for (const h of msg.savedHashes || []) reg.hashes[h] = 1;
      await chrome.storage.local.set({ higRegistry: reg });
      if (kind === "basket" && !msg.partial) await chrome.storage.local.set({ higBasket: [] }); // full delivery empties the basket; a stopped job keeps it

      await chrome.storage.local.set({
        higLastResult: {
          when: Date.now(),
          saved: msg.saved, duplicates: msg.duplicates, failed: msg.failed, pages: msg.pages || 0, partial: !!msg.partial,
          zipName: msg.zipName, kind, error: downloadError,
        },
      });
      await chrome.storage.local.set({ higProgress: { running: false, done: msg.saved + msg.duplicates + msg.failed, total: msg.total, failed: msg.failed, status: "done", kind, when: Date.now() } });
      chrome.action.setBadgeText({ text: "✓" });
      chrome.action.setBadgeBackgroundColor({ color: "#1faa55" });
      setTimeout(refreshBadge, 15000);
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === "ZIP_ERROR") {
      const curE = await chrome.storage.local.get({ higProgress: null });
      const kindE = curE.higProgress ? curE.higProgress.kind : "basket";
      await chrome.storage.local.set({ higProgress: { running: false, done: 0, total: 0, failed: 0, status: "error", error: msg.error || "unknown", kind: kindE, when: Date.now() } });
      chrome.action.setBadgeText({ text: "!" });
      chrome.action.setBadgeBackgroundColor({ color: "#d33" });
      sendResponse({ ok: true });
      return;
    }

    sendResponse({ ok: false, error: "unknown message" });
  })();
  return true; // async response
});

// show the basket count on the badge when the browser starts
refreshBadge();

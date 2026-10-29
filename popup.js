// Hexa Image Grabber v2 - popup.
// Click the toolbar icon -> see every image on the page with a live total,
// pick the ones you want, and download them all as ONE zip file.

// ---- injected into the page: collects content images (no icons/favicons) ----
function collectImages(includeBg) {
  const found = new Map();
  const skip = /favicon|apple-touch-icon|site-icon|mstile|mask-icon|safari-pinned-tab|\/icons?\/|[-_](icon|sprite)[-_.]/i;
  function add(rawUrl, w, h, kind) {
    if (!rawUrl) return;
    let url;
    try { url = new URL(rawUrl, location.href).href; } catch (e) { return; }
    if (!/^https?:/.test(url)) {
      // keep sizable data: images, drop tiny inline ones
      if (!/^data:image\//.test(url) || url.length < 9000) return;
    }
    if (skip.test(url)) return;
    const prev = found.get(url);
    if (!prev || (w * h) > (prev.w * prev.h)) found.set(url, { url, w: w || 0, h: h || 0, kind });
  }
  // <img> tags - take the largest srcset candidate; if the page loaded a
  // smaller variant than the largest candidate, scale the dimensions up
  // proportionally so a big available image is never treated as "small"
  for (const img of document.images) {
    let best = "", bestW = 0;
    if (img.srcset) {
      for (const part of img.srcset.split(",")) {
        const bits = part.trim().split(/\s+/);
        const candW = bits[1] && bits[1].endsWith("w") ? parseInt(bits[1]) : 0;
        if (bits[0] && candW >= bestW) { best = bits[0]; bestW = candW; }
      }
    }
    let w = img.naturalWidth, h = img.naturalHeight;
    if (bestW > w && w > 0) { h = Math.round(h * bestW / w); w = bestW; }
    add(best || img.currentSrc || img.src, w, h, "img");
  }
  // CSS background images of decent size (unless the user turned them off)
  const els = includeBg === false ? [] : document.querySelectorAll("body *");
  const limit = Math.min(els.length, 5000);
  for (let i = 0; i < limit; i++) {
    const el = els[i];
    const r = el.getBoundingClientRect();
    if (r.width < 48 || r.height < 48) continue;
    const bg = getComputedStyle(el).backgroundImage;
    if (bg && bg.startsWith("url(")) {
      const m = bg.match(/url\(["']?(.*?)["']?\)/);
      if (m) add(m[1], Math.round(r.width), Math.round(r.height), "background");
    }
  }
  // social / hero image
  for (const sel of ['meta[property="og:image"]', 'meta[name="twitter:image"]']) {
    const tag = document.querySelector(sel);
    if (tag && tag.content) add(tag.content, 0, 0, "og");
  }
  return { title: document.title, domain: location.hostname, items: [...found.values()] };
}

// ---- popup state ----
let ITEMS = [];        // every image found on the page
let BASKET = [];       // cross-page collection basket
let DOMAIN = "";
let SETTINGS = { minSize: 120, rootFolder: "HexaImages", includeBg: true };
let REG_URLS = new Set();
let selected = new Set();
let typeFilter = "all";
let sortMode = "page";
let pollTimer = null;
let jobStartedAt = 0;

const $ = (id) => document.getElementById(id);

function extOf(url) {
  const m = url.split(/[?#]/)[0].match(/\.([a-z0-9]{2,5})$/i);
  if (!m) return "other";
  let e = m[1].toLowerCase();
  if (e === "jpeg") e = "jpg";
  return ["jpg", "png", "webp", "gif", "svg", "avif", "bmp"].includes(e) ? e : "other";
}

function isSmall(it) {
  const d = Math.max(it.w, it.h);
  return d > 0 && d < SETTINGS.minSize;
}
// Identical copy lives in util.js / background.js - keep them in sync.
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
function isDupe(it) { return REG_URLS.has(normalizeUrl(it.url)); }

function visibleItems() {
  let list = ITEMS.filter((it) => {
    if (typeFilter !== "all" && extOf(it.url) !== typeFilter) return false;
    if (!$("showSmall").checked && isSmall(it)) return false;
    return true;
  });
  if (sortMode === "big") list = [...list].sort((a, b) => b.w * b.h - a.w * a.h);
  if (sortMode === "small") list = [...list].sort((a, b) => a.w * a.h - b.w * b.h);
  return list;
}

function render() {
  const list = visibleItems();
  $("totalNum").textContent = ITEMS.length;
  $("domain").textContent = DOMAIN || "—";
  const smallCount = ITEMS.filter(isSmall).length;
  $("status").textContent =
    "Showing " + list.length + " of " + ITEMS.length + " images" +
    (smallCount && !$("showSmall").checked ? " · " + smallCount + " small hidden" : "") +
    (REG_URLS.size ? " · gold “Saved” = downloaded before" : "");

  const grid = $("grid");
  grid.innerHTML = "";
  $("empty").hidden = list.length > 0;
  for (const it of list) {
    const card = document.createElement("div");
    card.className = "card" + (selected.has(it.url) ? " selected" : "");
    const dims = it.w && it.h ? it.w + "×" + it.h : "size ?";
    card.innerHTML =
      '<img class="thumb" loading="lazy" src="' + it.url.replace(/"/g, "%22") + '">' +
      '<div class="check">✓</div>' +
      (isDupe(it) ? '<div class="dupe-badge">Saved</div>' : "") +
      (BASKET.some((b) => b.url === it.url) ? '<div class="basket-badge">🧺</div>' : "") +
      '<button class="open-btn" title="Open full image">↗</button>' +
      '<div class="meta"><span>' + dims + '</span><span class="ext">' + extOf(it.url) + "</span></div>";
    card.addEventListener("click", () => {
      if (selected.has(it.url)) selected.delete(it.url); else selected.add(it.url);
      render();
    });
    card.querySelector(".open-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      chrome.tabs.create({ url: it.url });
    });
    grid.appendChild(card);
  }
  $("selCount").textContent = selected.size;
  $("collectBtn").disabled = selected.size === 0;
  $("collectBtn").textContent = selected.size ? "＋ Add to Collection (" + selected.size + ")" : "＋ Add to Collection";
}

function renderBasket() {
  $("basketBar").hidden = BASKET.length === 0;
  $("basketCount").textContent = BASKET.length;
  $("basketSites").textContent = new Set(BASKET.map((b) => b.domain)).size;
}

async function scan() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/^https?:/.test(tab.url || "")) {
    $("status").textContent = "Open a normal website first — browser pages can't be scanned.";
    $("totalNum").textContent = "0";
    return;
  }
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: collectImages, args: [SETTINGS.includeBg !== false] });
    ITEMS = res.result.items;
    DOMAIN = res.result.domain;
    selected = new Set(ITEMS.filter((it) => !isDupe(it) && !isSmall(it)).map((it) => it.url));
    render();
  } catch (e) {
    $("status").textContent = "Couldn't scan this page: " + e.message;
  }
}

function showProgress(p) {
  $("progressBox").hidden = false;
  const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
  $("barFill").style.width = pct + "%";
  $("progressText").textContent = p.phase === "pages"
    ? "Reading pages… " + p.done + (p.total && p.total !== p.done ? " / " + p.total : "") + (p.images ? " · " + p.images + " images found" : "")
    : p.total
      ? "Fetching images… " + p.done + " / " + p.total + (p.failed ? " · " + p.failed + " failed" : "")
      : "Reading the pages & finding their images…";
}

function showResult(r) {
  $("progressBox").hidden = true;
  const box = $("resultBox");
  box.hidden = false;
  if (r.error) {
    box.innerHTML = "⚠️ The ZIP was built (" + r.saved + " images) but the browser refused the download: " +
      r.error + "<br>Try a smaller batch.";
    return;
  }
  if (!r.zipName) {
    box.innerHTML = "ℹ️ Nothing new to download — every image was already saved before (" +
      (r.duplicates || 0) + " duplicates skipped).";
    return;
  }
  box.innerHTML =
    (r.partial ? "⏹ <b>Stopped early</b> — partial zip: " : "✅ ") + "<b>" + r.saved + " images</b> in ONE zip" +
    (r.pages > 1 ? " · from " + r.pages + " pages" : "") +
    (r.duplicates ? " · " + r.duplicates + " duplicates skipped" : "") +
    (r.failed ? " · " + r.failed + " failed" : "") +
    "<br>📁 Downloads/" + r.zipName;
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(async () => {
    const data = await chrome.storage.local.get({ higProgress: null, higLastResult: null });
    if (data.higProgress && data.higProgress.running) { showProgress(data.higProgress); return; }
    if (data.higProgress && data.higProgress.status === "error") {
      stopPolling();
      $("progressBox").hidden = true;
      const box = $("resultBox");
      box.hidden = false;
      box.innerHTML = "⚠️ Something went wrong: " + (data.higProgress.error || "unknown error") + ". Nothing was downloaded.";
      return;
    }
    if (data.higLastResult && data.higLastResult.when >= jobStartedAt) {
      stopPolling();
      showResult(data.higLastResult);
      // refresh duplicate badges + basket (a basket job empties the basket)
      const reg = await chrome.storage.local.get({ higRegistry: { urls: {}, hashes: {} }, higBasket: [] });
      REG_URLS = new Set(Object.keys(reg.higRegistry.urls));
      BASKET = reg.higBasket;
      renderBasket();
      render();
    }
  }, 600);
}
function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

document.addEventListener("DOMContentLoaded", async () => {
  const stored = await chrome.storage.local.get({
    settings: { minSize: 120, rootFolder: "HexaImages" },
    higRegistry: { urls: {}, hashes: {} }, higProgress: null, higLastResult: null, higBasket: [],
  });
  SETTINGS = { minSize: stored.settings.minSize || 120, rootFolder: stored.settings.rootFolder || "HexaImages", includeBg: stored.settings.includeBg !== false };
  REG_URLS = new Set(Object.keys(stored.higRegistry.urls));
  BASKET = stored.higBasket || [];
  renderBasket();

  // a "running" flag older than 10 minutes belongs to a job the browser
  // killed (closed/crashed) - clear it instead of spinning forever
  if (stored.higProgress && stored.higProgress.running && Date.now() - stored.higProgress.when > 10 * 60 * 1000) {
    await chrome.storage.local.set({ higProgress: { running: false, done: 0, total: 0, failed: 0, status: "stale", kind: stored.higProgress.kind || "", when: Date.now() } });
    stored.higProgress = null;
  }

  if (stored.higProgress && stored.higProgress.running) { jobStartedAt = Date.now() - 1; startPolling(); }
  else if (stored.higLastResult && Date.now() - stored.higLastResult.when < 10 * 60 * 1000) showResult(stored.higLastResult);

  $("typeChips").addEventListener("click", (e) => {
    const b = e.target.closest("[data-type]");
    if (!b) return;
    typeFilter = b.dataset.type;
    document.querySelectorAll("#typeChips .chip").forEach((c) => c.classList.toggle("active", c === b));
    render();
  });
  $("sortSel").addEventListener("change", () => { sortMode = $("sortSel").value; render(); });
  $("showSmall").addEventListener("change", render);
  $("selAll").addEventListener("click", () => { visibleItems().forEach((it) => selected.add(it.url)); render(); });
  $("selNone").addEventListener("click", () => { selected.clear(); render(); });

  $("stopBtn").addEventListener("click", async () => {
    $("stopBtn").disabled = true;
    $("stopBtn").textContent = "⏹ Stopping…";
    await chrome.runtime.sendMessage({ type: "CANCEL_JOB" });
    setTimeout(() => { $("stopBtn").disabled = false; $("stopBtn").textContent = "⏹ Stop"; }, 4000);
  });

  $("urlZipBtn").addEventListener("click", async () => {
    // pull every http(s) link out of whatever was pasted (text, commas,
    // brackets - anything), trimming trailing punctuation stuck to a link
    const found = $("urlInput").value.match(/https?:\/\/[^\s"'<>()[\]{}]+/gi) || [];
    const urls = [...new Set(found.map((u) => u.replace(/[.,;:!?]+$/, "")))];
    if (!urls.length) {
      $("status").textContent = "Paste at least one full page link first (starting with https://).";
      return;
    }
    jobStartedAt = Date.now();
    $("resultBox").hidden = true;
    showProgress({ done: 0, total: 0, failed: 0 });
    const resp = await chrome.runtime.sendMessage({
      type: "START_URL_ZIP", urls, folder: SETTINGS.rootFolder,
      crawl: $("crawlChk").checked,
      maxPages: $("crawlMax").value === "all" ? 0 : (parseInt($("crawlMax").value, 10) || 50), // 0 = ALL, no limit
    });
    if (resp && !resp.ok) {
      $("progressBox").hidden = true;
      $("status").textContent = resp.error === "busy"
        ? "⏳ Another job is already running — wait for it or stop it first."
        : "⚠️ Could not start: " + (resp.error || "unknown");
      return;
    }
    startPolling();
  });

  $("collectBtn").addEventListener("click", async () => {
    const items = ITEMS.filter((it) => selected.has(it.url)).map((it) => ({ url: it.url, w: it.w, h: it.h }));
    if (!items.length) return;
    const r = await chrome.runtime.sendMessage({ type: "BASKET_ADD", items, domain: DOMAIN });
    if (!r || !r.ok) {
      $("status").textContent = "⚠️ Could not add to the collection: " + ((r && r.error) || "no response");
      return;
    }
    const reg = await chrome.storage.local.get({ higBasket: [] });
    BASKET = reg.higBasket;
    renderBasket();
    render();
    $("status").textContent =
      "🧺 Added " + r.added + " to the collection" +
      (r.skipped ? " · " + r.skipped + " skipped (already collected/saved)" : "") +
      " · Collection total: " + r.total + ". Keep browsing other sites — when you finish, press Download ONE ZIP and everything comes down together in a single file.";
  });

  $("basketZip").addEventListener("click", async () => {
    if (!BASKET.length) return;
    jobStartedAt = Date.now();
    $("resultBox").hidden = true;
    showProgress({ done: 0, total: BASKET.length, failed: 0 });
    const resp = await chrome.runtime.sendMessage({ type: "START_BASKET_ZIP", folder: SETTINGS.rootFolder });
    if (resp && !resp.ok) {
      $("progressBox").hidden = true;
      $("status").textContent = resp.error === "busy"
        ? "⏳ Another job is already running — wait for it or stop it first."
        : "⚠️ Could not start: " + (resp.error || "unknown");
      return;
    }
    startPolling();
  });

  $("basketClear").addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ type: "BASKET_CLEAR" });
    BASKET = [];
    renderBasket();
    render();
    $("status").textContent = "Collection cleared.";
  });

  scan();
});

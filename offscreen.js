// Hexa Image Grabber v4.3 - offscreen worker.
// Ways in, one way out (a single ZIP):
//  A) RUN_ZIP     - items collected from pages via the popup gallery/basket
//  B) RUN_URL_ZIP - links pasted by the user. Two sub-modes:
//       - exact pages: fetch each pasted page, take THAT page's images
//       - whole website (crawl): from each pasted main URL, automatically
//         discover the site's sub-pages (same site only) and take the
//         images of EVERY page - the user never pastes sub-pages by hand
// Fetching is parallel. Duplicates are dropped three ways: same normalised
// address, same content hash as anything saved before, same content twice in
// one run. The ZIP keeps one subfolder per website.

const POOL_SIZE = 6;
const FETCH_TIMEOUT_MS = 30000;
const SKIP_URL = /favicon|apple-touch-icon|site-icon|mstile|mask-icon|safari-pinned-tab|\/icons?\/|[-_](icon|sprite)[-_.]/i;
const SKIP_PATH = /wp-admin|wp-login|\/login|\/logout|\/cart|\/checkout|my-account|\/feed(\/|\?|$)|cdn-cgi/i;
const ASSET_EXT = /\.(png|jpe?g|gif|webp|svg|avif|css|js|mjs|pdf|zip|rar|mp4|webm|mp3|wav|ico|woff2?|ttf|xml|json|txt|csv)(\?|#|$)/i;

function fileNameFor(url, used, prefix) {
  let base = "image";
  try {
    const u = new URL(url);
    const seg = u.pathname.split("/").filter(Boolean).pop() || "";
    base = decodeURIComponent(seg) || "image";
  } catch (e) { /* keep default */ }
  base = base.replace(/[^\w.\-]+/g, "_").replace(/^\.+/, "") || "image";
  if (!/\.[a-z0-9]{2,5}$/i.test(base)) base += ".jpg";
  let name = base;
  let i = 2;
  while (used.has((prefix + name).toLowerCase())) {
    const dot = base.lastIndexOf(".");
    name = base.slice(0, dot) + " (" + i + ")" + base.slice(dot);
    i++;
  }
  used.add((prefix + name).toLowerCase());
  return name;
}

async function sha256Hex(buf) {
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}

async function fetchBytes(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { credentials: "include", signal: ctrl.signal });
    if (!resp.ok) return null;
    return new Uint8Array(await resp.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

function largestFromSrcset(srcset) {
  let best = "", bestW = 0;
  for (const part of String(srcset || "").split(",")) {
    const bits = part.trim().split(/\s+/);
    const w = bits[1] && bits[1].endsWith("w") ? parseInt(bits[1]) : 0;
    if (bits[0] && w >= bestW) { best = bits[0]; bestW = w; }
  }
  return best;
}

function hostKey(hostname) {
  return String(hostname || "").toLowerCase().replace(/^www\./, "");
}

// The site's root key: last 2 labels of the start host (3 when the middle
// label is a common second-level suffix like co.uk). Pages on the host itself
// or on any of its subdomains count as the same website.
function rootKeyOf(hostname) {
  const parts = hostKey(hostname).split(".").filter(Boolean);
  if (parts.length <= 2) return parts.join(".");
  const sld = ["co", "com", "org", "net", "ac", "gov", "edu"];
  return (sld.includes(parts[parts.length - 2]) ? parts.slice(-3) : parts.slice(-2)).join(".");
}

function sameSite(url, rootKey) {
  const hk = hostKey(url.hostname);
  return hk === rootKey || hk.endsWith("." + rootKey);
}

// Scheme-insensitive identity of a page, so the http/https and www variants
// of the same page are visited only once.
function pageKey(u) {
  try {
    const url = new URL(self.HigUtil.normalizeUrl(u));
    return hostKey(url.hostname) + url.pathname + url.search;
  } catch (e) {
    return u;
  }
}

// Fetch one URL once. Returns { doc } for an HTML page, { image: true } for a
// direct image link, or null when unreachable.
async function fetchDoc(pageUrl) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  let resp;
  try {
    resp = await fetch(pageUrl, { credentials: "include", signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
  if (!resp || !resp.ok) return null;
  const ctype = (resp.headers.get("content-type") || "").toLowerCase();
  if (ctype.startsWith("image/")) return { image: true };
  const html = await resp.text();
  // resolve the page's links/images against the FINAL url after redirects
  return { doc: new DOMParser().parseFromString(html, "text/html"), finalUrl: resp.url || pageUrl };
}

// Every content image referenced by a parsed page.
function imagesFromDoc(doc, pageUrl) {
  const host = new URL(pageUrl).hostname;
  const found = new Map();
  const add = (raw) => {
    if (!raw) return;
    let u;
    try { u = new URL(raw, pageUrl).href; } catch (e) { return; }
    if (!/^https?:/.test(u) && !/^data:image\//.test(u)) return;
    if (SKIP_URL.test(u)) return;
    if (!found.has(u)) found.set(u, { url: u, folder: host, allowDupe: false });
  };
  doc.querySelectorAll("img").forEach((img) => {
    const w = parseInt(img.getAttribute("width") || "0", 10);
    const h = parseInt(img.getAttribute("height") || "0", 10);
    if (w > 0 && h > 0 && Math.max(w, h) < 40) return; // declared tiny = tracking pixel / spacer
    add(largestFromSrcset(img.getAttribute("srcset")) || img.getAttribute("src") || img.getAttribute("data-src") || img.getAttribute("data-lazy-src"));
  });
  doc.querySelectorAll("source[srcset]").forEach((s) => add(largestFromSrcset(s.getAttribute("srcset"))));
  doc.querySelectorAll('meta[property="og:image"], meta[name="twitter:image"]').forEach((m) => add(m.getAttribute("content")));
  const bgUrls = (text) => {
    const out = [];
    const re = /url\(\s*["']?([^"')]+)["']?\s*\)/g;
    let mm;
    while ((mm = re.exec(text || ""))) out.push(mm[1]);
    return out;
  };
  doc.querySelectorAll("[style]").forEach((el) => bgUrls(el.getAttribute("style")).forEach(add));
  doc.querySelectorAll("style").forEach((st) => bgUrls(st.textContent).forEach(add));
  return [...found.values()];
}

// Sub-page links of the SAME website (for the whole-website crawl).
function linksFromDoc(doc, pageUrl, rootKey) {
  const out = [];
  doc.querySelectorAll("a[href]").forEach((a) => {
    let u;
    try { u = new URL(a.getAttribute("href"), pageUrl); } catch (e) { return; }
    if (!/^https?:$/.test(u.protocol)) return;
    if (!sameSite(u, rootKey)) return;                 // same website only
    if (ASSET_EXT.test(u.pathname + u.search)) return; // not a page
    if (SKIP_PATH.test(u.pathname)) return;            // login/cart/admin etc.
    u.hash = "";
    out.push(self.HigUtil.normalizeUrl(u.href));
  });
  return out;
}

async function extractFromPage(pageUrl) {
  const r = await fetchDoc(pageUrl);
  if (!r) return [];
  if (r.image) return [{ url: pageUrl, folder: new URL(pageUrl).hostname, allowDupe: false }];
  return imagesFromDoc(r.doc, r.finalUrl || pageUrl);
}

// Many real sites render their menus with JavaScript, so the homepage HTML
// may contain few or no sub-page links. The site's sitemap lists its pages
// directly - read it (and any child sitemaps) to seed the crawl. Sitemaps
// are parsed as raw text: a <loc> ending in .xml is a child sitemap, one
// ending in an image extension is an image, anything else is a page.
async function sitemapSeeds(startUrl, rootKey, seen, items) {
  const pageUrls = [];
  const IMG_EXT = /\.(png|jpe?g|gif|webp|svg|avif|bmp|ico)(\?|#|$)/i;
  const locsOf = (xml) => {
    const out = [];
    const re = /<loc>\s*([^<]+?)\s*<\/loc>/gi;
    let m;
    while ((m = re.exec(xml || ""))) out.push(m[1].trim());
    return out;
  };
  const fetchText = async (u) => {
    try {
      const r = await fetch(u, { credentials: "include" });
      if (!r.ok) return "";
      return await r.text();
    } catch (e) { return ""; }
  };
  try {
    const origin = new URL(startUrl).origin;
    const pending = locsOf(await fetchText(origin + "/sitemap.xml"));
    let childBudget = 5;
    while (pending.length) {
      const loc = pending.shift();
      if (/\.xml($|\?)/i.test(loc)) {
        if (childBudget-- > 0) pending.push(...locsOf(await fetchText(loc)));
        continue;
      }
      if (IMG_EXT.test(loc)) {
        let u;
        try { u = new URL(loc); } catch (e) { continue; }
        if (SKIP_URL.test(u.href)) continue;
        const key = self.HigUtil.normalizeUrl(u.href);
        if (!seen.has(key)) {
          seen.add(key);
          items.push({ url: u.href, folder: u.hostname, allowDupe: false });
        }
        continue;
      }
      pageUrls.push(loc);
    }
  } catch (e) { /* no sitemap - the crawl continues from links alone */ }
  return pageUrls.filter((u) => {
    try {
      const url = new URL(u);
      return sameSite(url, rootKey) && !ASSET_EXT.test(url.pathname) && !SKIP_PATH.test(url.pathname);
    } catch (e) { return false; }
  });
}

// Whole-website crawl: BFS over the site's own sub-pages, collecting every
// page's images into the shared items list. Seeds come from the sitemap as
// well as from page links. Returns { pages, pageFails }.
async function crawlSite(startUrl, maxPages, seen, items, report) {
  report(0, items.length); // show life immediately - the sitemap read can take a moment
  const rootKey = rootKeyOf(new URL(startUrl).hostname);
  const start = self.HigUtil.normalizeUrl(startUrl);
  const visited = new Set([pageKey(start)]);
  const queue = [start];
  for (const seed of await sitemapSeeds(startUrl, rootKey, seen, items)) {
    const k = pageKey(seed);
    if (!visited.has(k)) { visited.add(k); queue.push(seed); }
  }
  let pages = 0, pageFails = 0;
  while (queue.length && pages < maxPages && !jobCancelled) {
    const batch = queue.splice(0, 3); // 3 pages at a time
    const results = await Promise.all(batch.map(async (u) => {
      try { return { u, r: await fetchDoc(u) }; } catch (e) { return { u, r: null }; }
    }));
    for (const { u, r } of results) {
      if (pages >= maxPages) break;
      pages++;
      if (!r) { pageFails++; continue; }
      if (r.image || !r.doc) continue;
      const base = r.finalUrl || u;
      for (const it of imagesFromDoc(r.doc, base)) {
        const key = self.HigUtil.normalizeUrl(it.url);
        if (seen.has(key)) continue;
        seen.add(key);
        items.push(it);
      }
      for (const link of linksFromDoc(r.doc, base, rootKey)) {
        const k = pageKey(link);
        if (!visited.has(k)) { visited.add(k); queue.push(link); }
      }
    }
    report(pages, items.length);
  }
  return { pages, pageFails };
}

let jobCancelled = false;

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "JOB_CANCEL") { jobCancelled = true; return; }
  if (msg.type !== "RUN_ZIP" && msg.type !== "RUN_URL_ZIP") return;
  jobCancelled = false;
  (async () => {
    let failed = 0, duplicates = 0, saved = 0, pagesTotal = 0, stoppedEarly = false;
    try {
      let items = msg.items || [];
      if (msg.type === "RUN_URL_ZIP") {
        const urls = msg.urls || [];
        const seen = new Set();
        if (msg.crawl) {
          // maxPages 0 (or missing) = ALL pages, no limit; otherwise the chosen cap
          const maxPages = msg.maxPages > 0 ? msg.maxPages : Number.MAX_SAFE_INTEGER;
          for (const startUrl of urls) {
            if (jobCancelled) break;
            const res = await crawlSite(startUrl, maxPages, seen, items, (pages, imgCount) => {
              chrome.runtime.sendMessage({
                type: "ZIP_PROGRESS", done: pages,
                total: maxPages === Number.MAX_SAFE_INTEGER ? pages : maxPages,
                failed, phase: "pages", images: imgCount,
              });
            });
            pagesTotal += res.pages;
            failed += res.pageFails;
          }
          // Stop pressed during the crawl: keep what was collected and still
          // download those images. Pressing Stop again during the download
          // phase cuts that short instead.
          if (jobCancelled) { stoppedEarly = true; jobCancelled = false; }
        } else {
          let pagesDone = 0;
          let pIdx = 0;
          async function pageWorker() {
            while (pIdx < urls.length) {
              const pageUrl = urls[pIdx++];
              try {
                for (const it of await extractFromPage(pageUrl)) {
                  const key = self.HigUtil.normalizeUrl(it.url);
                  if (seen.has(key)) continue;
                  seen.add(key);
                  items.push(it);
                }
              } catch (e) { failed++; }
              pagesDone++;
              chrome.runtime.sendMessage({ type: "ZIP_PROGRESS", done: pagesDone, total: urls.length, failed, phase: "pages" });
            }
          }
          await Promise.all(Array.from({ length: Math.min(4, urls.length) }, pageWorker));
          pagesTotal = pagesDone;
          if (jobCancelled) { stoppedEarly = true; jobCancelled = false; }
        }
        if (!items.length) {
          chrome.runtime.sendMessage({ type: "ZIP_DONE", saved: 0, duplicates: 0, failed, total: 0, pages: pagesTotal, partial: stoppedEarly || jobCancelled, zipName: "", savedUrls: [], savedHashes: [], dataUrl: null });
          return;
        }
        chrome.runtime.sendMessage({ type: "ZIP_PROGRESS", done: 0, total: items.length, failed });
      }

      const total = items.length;
      let done = 0;
      const reg = { urls: new Set(msg.regUrls || []), hashes: new Set(msg.regHashes || []) };
      const usedNames = new Set();
      const batchHashes = new Set();
      const entries = [];
      const savedUrls = [];
      const savedHashes = [];

      async function processOne(item) {
        try {
          const key = self.HigUtil.normalizeUrl(item.url);
          if (!item.allowDupe && reg.urls.has(key)) { duplicates++; return; }
          const buf = await fetchBytes(item.url);
          if (!buf || buf.length < 120) { failed++; return; } // error pages / 1x1 tracking pixels
          const hash = await sha256Hex(buf);
          // synchronous check-and-reserve: race-safe even in the parallel pool
          if (batchHashes.has(hash) || (!item.allowDupe && reg.hashes.has(hash))) {
            duplicates++;
            savedUrls.push(key); // same content already kept - never offer again
            return;
          }
          batchHashes.add(hash);
          const site = String(item.folder || "site").replace(/[^\w.\-]+/g, "_");
          const prefix = site + "/";
          entries.push({ name: prefix + fileNameFor(item.url, usedNames, prefix), data: buf });
          savedUrls.push(key);
          savedHashes.push(hash);
          saved++;
        } catch (e) {
          failed++;
        } finally {
          done++;
          if (done % 3 === 0 || done === total) {
            chrome.runtime.sendMessage({ type: "ZIP_PROGRESS", done, total, failed });
          }
        }
      }

      let idx = 0;
      async function worker() {
        while (idx < items.length && !jobCancelled) {
          const item = items[idx++];
          await processOne(item);
        }
      }
      await Promise.all(Array.from({ length: Math.min(POOL_SIZE, items.length) }, worker));

      let zipName = "";
      let dataUrl = null;
      if (entries.length > 0) {
        const folder = (msg.folder || "HexaImages").replace(/[^\w\- ]/g, "").trim() || "HexaImages";
        const hosts = [...new Set(items.map((i) => String(i.folder || "site")))];
        zipName = folder + "/" + (hosts.length === 1 ? hosts[0] + "-images.zip" : "all-images.zip");
        const blob = self.HexaZip.createZip(entries);
        // offscreen documents have no chrome.downloads - hand the zip to the
        // service worker as a data URL and let it run the single download
        dataUrl = await blobToDataUrl(blob);
      }

      chrome.runtime.sendMessage({
        type: "ZIP_DONE", saved, duplicates, failed, total, pages: pagesTotal,
        partial: stoppedEarly || jobCancelled,
        zipName, savedUrls, savedHashes, dataUrl,
      });
    } catch (e) {
      chrome.runtime.sendMessage({ type: "ZIP_ERROR", error: String(e && e.message || e) });
    }
  })();
});

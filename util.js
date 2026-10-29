// Hexa Image Grabber - shared helpers (loaded by the offscreen worker;
// the service worker and popup keep identical copies of normalizeUrl).

// Canonical key for "is this the same image address?" - strips tracking and
// cache-buster query params so the same image under a slightly different
// address is still recognised as a duplicate. Size params (w/h) are kept:
// they usually mean a genuinely different file.
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

self.HigUtil = { normalizeUrl };

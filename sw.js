// Service worker for the voice speed test. It does two jobs:
//  1. Adds the cross-origin-isolation headers the page needs (GitHub Pages cannot send headers), which lets
//     ONNX Runtime use every processor core. Without them Pocket TTS runs on one core and looks slower than it is.
//  2. Keeps every downloaded file (page, libraries, models) so the page works with Wi-Fi off after the first run.
const CACHE = "voice-speed-test-v1";
const THIRD_PARTY = ["cdn.jsdelivr.net", "cdnjs.cloudflare.com", "huggingface.co"];

const isThirdPartyCached = (url) =>
  THIRD_PARTY.includes(url.hostname) || url.hostname.endsWith(".hf.co");

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) if (name !== CACHE) await caches.delete(name);
      await self.clients.claim();
    })()
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "clear-cache") {
    event.waitUntil(caches.delete(CACHE).then(() => event.source && event.source.postMessage({ type: "cache-cleared" })));
  }
});

function isolate(response) {
  if (!response || response.status === 0) return response; // opaque: cannot be changed
  const headers = new Headers(response.headers);
  headers.set("Cross-Origin-Embedder-Policy", "require-corp");
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Cross-Origin-Resource-Policy", "cross-origin");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function remember(cache, request, response) {
  try {
    if (response.ok && response.status === 200 && response.type !== "opaque") await cache.put(request, response);
  } catch (err) {
    // a full disk or a Vary header just means this file is not kept; the page still works online
  }
}

async function handle(request) {
  const url = new URL(request.url);
  const cache = await caches.open(CACHE);
  const sameOrigin = url.origin === self.location.origin;

  if (sameOrigin) {
    // our own files: newest first so edits show up, the saved copy when offline
    try {
      const fresh = await fetch(request, { cache: "no-cache" });
      remember(cache, request, fresh.clone());
      return isolate(fresh);
    } catch (err) {
      const saved = await cache.match(request, { ignoreSearch: false });
      if (saved) return isolate(saved);
      throw err;
    }
  }

  // libraries and models: saved copy first (they never change under the same address)
  const saved = await cache.match(request);
  if (saved) return isolate(saved);
  const fresh = await fetch(request);
  remember(cache, request, fresh.clone()); // not awaited: the page gets its bytes while the copy is being saved
  return isolate(fresh);
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  if (request.cache === "only-if-cached" && request.mode !== "same-origin") return;
  if (request.headers.has("range")) return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin && !isThirdPartyCached(url)) return;
  event.respondWith(handle(request));
});

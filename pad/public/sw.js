// Serves the pinned wasm packages from this origin instead of Wasmer's CDN.
//
// The SDK has no registry override and cannot decode in-memory WEBC in the
// browser — `packages.load(bytes)` fails with `FeatureNotEnabled {
// "authoring" }`. So the packages are fetched by registry name as usual, and
// this rewrites the requests on their way out.
//
// A service worker rather than a patched `fetch`, because the SDK does its
// downloading inside workers, which have their own globals. This is the one
// interception point that covers the page and everything it spawns.
//
// What it buys: Wasmer's CDN sends `.webc` with no content encoding at all, so
// python is 58.9 MB on the wire. The same file from here, behind zstd, is
// roughly a quarter of that — and immutable caching makes any later visit free.
//
// Anything not in the manifest passes straight through. A package we forgot to
// mirror still works, just slowly, which is the right way round.

const MANIFEST = "/packages/manifest.json";
let mirrors = null;

async function map() {
  mirrors ??= fetch(MANIFEST)
    .then((r) => (r.ok ? r.json() : {}))
    .catch(() => ({}));
  return mirrors;
}

self.addEventListener("install", (event) => {
  // Active immediately rather than after the next navigation: the page that
  // registers this is the page about to download 60 MB.
  event.waitUntil(map().then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

let intercepted = 0;
let mirrored = 0;

self.addEventListener("message", (event) => {
  if (event.data === "stats") {
    event.source?.postMessage({ intercepted, mirrored });
  }
});

self.addEventListener("fetch", (event) => {
  const url = event.request.url;
  if (!url.startsWith("https://cdn.wasmer.io/")) return;
  intercepted += 1;
  event.respondWith(
    (async () => {
      const local = (await map())[url];
      if (!local) return fetch(event.request);
      const res = await fetch(local);
      // A mirror that 404s must not break the app — fall back to the origin it
      // was mirroring rather than failing the request.
      if (!res.ok) return fetch(event.request);
      mirrored += 1;

      // Strip the encoding headers before handing this back.
      //
      // `fetch` has already decompressed the body by the time it reaches us,
      // but `Content-Encoding` and `Content-Length` still describe the
      // compressed form. The SDK does its own HTTP decoding inside wasm, sees
      // the header, and tries to decompress bytes that are already plain —
      // failing with "zstd content-encoding is not supported on wasm32", which
      // reads like a server misconfiguration and is the opposite.
      //
      // Stripping them is what lets the wire stay compressed: the transfer is
      // 16 MB of zstd, and what the SDK receives is the 72 MB it expects.
      const headers = new Headers(res.headers);
      headers.delete("content-encoding");
      headers.delete("content-length");
      return new Response(res.body, {
        status: res.status,
        statusText: res.statusText,
        headers,
      });
    })(),
  );
});

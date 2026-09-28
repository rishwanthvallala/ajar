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

/**
 * The one version a dependency may resolve to.
 *
 * A package names what it depends on as a range — bash asks for
 * `wasmer/coreutils@^1.0.19` — and the SDK takes the newest version the
 * registry lists in it. So when Wasmer published coreutils 1.0.26 and 1.0.27,
 * every visitor moved to 1.0.27 without a deploy, from Wasmer's CDN because
 * the mirror had never seen it. The next release would have done the same.
 *
 * The packages the page asks for are pinned in runtime.ts with `=`. A
 * dependency cannot be pinned there — bash resolves its own range whatever
 * else is installed — so it is pinned here, where the SDK asks the registry
 * which versions exist: the answer lists only this one. Changing a version
 * here means running fetch-packages.mjs, which records through this worker.
 *
 * 1.0.27 and not the 1.0.25 it replaced, though that was 1.2 MB on the wire
 * against 2.8. Measured on 28 September: with 1.0.25 the browser check hung
 * on a python command near its end in 11 runs out of 11; with 1.0.27, and the
 * same worker passing every answer through, it finished in all 7.
 */
const PINS = {
  "wasmer/coreutils": "1.0.27",
};
const REGISTRY = "https://registry.wasmer.io/graphql";

/** The registry's answer, with a pinned package's other versions left out. */
async function pinned(request) {
  let name = null;
  try {
    name = /getPackage\(name: "([^"]+)"\)/.exec(JSON.parse(await request.clone().text()).query)?.[1] ?? null;
  } catch {
    // Not a query this knows how to read; pass it through untouched.
  }
  const res = await fetch(request);
  const version = name && PINS[name];
  if (!version || !res.ok) return res;
  const body = await res.clone().json().catch(() => null);
  const versions = body?.data?.getPackage?.versions;
  if (!Array.isArray(versions)) return res;
  const kept = versions.filter((v) => v.version === version);
  // A pin the registry no longer has would leave nothing to resolve. Floating
  // is worse than pinned and better than broken, and app-check says so.
  if (kept.length === 0) return res;
  body.data.getPackage.versions = kept;
  pinnedCount += 1;
  return new Response(JSON.stringify(body), {
    status: res.status,
    statusText: res.statusText,
    headers: { "Content-Type": "application/json" },
  });
}

let intercepted = 0;
let mirrored = 0;
let pinnedCount = 0;

self.addEventListener("message", (event) => {
  if (event.data === "stats") {
    event.source?.postMessage({ intercepted, mirrored, pinned: pinnedCount });
  }
});

self.addEventListener("fetch", (event) => {
  const url = event.request.url;
  if (url === REGISTRY && event.request.method === "POST") {
    event.respondWith(pinned(event.request));
    return;
  }
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

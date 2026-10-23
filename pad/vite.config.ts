import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { cp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { defineConfig, type Plugin } from "vite";

/**
 * Cross-origin isolation.
 *
 * WASIX threads need `SharedArrayBuffer`, and a browser only hands that to a
 * document that has opted out of sharing a process with anything cross-origin.
 * These headers are that opt-out. Without them the runtime fails where it is
 * constructed rather than where it is used, which is a confusing place to
 * start debugging.
 *
 * The real deploy sets the same three in Caddy.
 */
const isolation: Plugin = {
  name: "cross-origin-isolation",
  configureServer(server) {
    server.middlewares.use((_req, res, next) => {
      res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
      res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
      next();
    });
  },
};

/**
 * Serve `@wasmer/sdk` verbatim instead of bundling it.
 *
 * The SDK computes its worker URL at runtime — `new URL("./browser-worker.js",
 * import.meta.url)` — and that worker then statically imports two siblings of
 * its own. A bundler flattens all of that into hashed chunks, so the worker
 * loads from a path whose neighbours no longer exist under the names it asks
 * for, and every command hangs forever waiting on a worker that failed to
 * start. Nothing throws; the requests just abort.
 *
 * Copying the package's own directory layout and importing from that URL keeps
 * every relative path true. The cost is one unbundled dependency.
 *
 * Under a folder named for what is in it, as the hashed assets are, because
 * the Caddyfile keeps everything under /vendor for a year and never asks
 * again. It was one folder, /vendor/wasmer, until 21 October: a browser that
 * had kept the SDK from before 0.18 (16 October) and fetched one file of it
 * afresh ran 0.18's WebAssembly against the old glue — `WebAssembly.
 * instantiate(): Import #1 "./wasmer_sdk_js_bg.js" "__wbg___wasmerHost
 * FileSystem_…": function import requires a callable` — and no Run started
 * again in it. The code review of 16 September had said so (F36).
 */
const sdkEntry = createRequire(import.meta.url).resolve("@wasmer/sdk");
const sdkRoot = new URL("../", pathToFileURL(sdkEntry));

/** Twelve hex digits of a hash of every file under `dirs` of `root`, with their names. */
function contentHash(root: URL, dirs: string[]): string {
  const hash = createHash("sha256");
  const walk = (dir: URL, rel: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (entry.isDirectory()) walk(new URL(`${entry.name}/`, dir), `${rel}${entry.name}/`);
      else hash.update(`${rel}${entry.name}\0`).update(readFileSync(new URL(entry.name, dir)));
    }
  };
  for (const dir of dirs) walk(new URL(`${dir}/`, root), `${dir}/`);
  return hash.digest("hex").slice(0, 12);
}

const SDK_URL = `/vendor/wasmer/${contentHash(sdkRoot, ["dist", "pkg"])}`;
// The SDK's WISP transport is the one file in it that assumes a bundler:
// `wisp-network.js` opens with a bare `import … from
// "@mercuryworkshop/wisp-js/client"`, and nothing resolves that in a browser.
// It is the only thing standing between this sandbox and outbound TCP.
//
// The import happens in the main document — `index.js` does
// `await import("./wisp-network.js")` — so an import map in the page is enough,
// and an import map is exactly what this situation is for. Workers would not
// have been: they do not get the document's map.
//
// Vendored the same way and for the same reason as the SDK: the package's own
// `src/` layout is copied whole, so its internal relative imports stay true.
// Resolved through an exported entry, because the package does not export its
// own package.json, and then cut back to the package root by name rather than
// by counting `../` — `createRequire` resolves with the `require` condition and
// lands in `dist/`, which is one level deeper than the ESM entry it advertises.
const WISP_PKG = "@mercuryworkshop/wisp-js";
const wispEntry = createRequire(import.meta.url).resolve(`${WISP_PKG}/client`);
const wispRoot = new URL("../", pathToFileURL(wispEntry));
// Not named for its version, as the SDK is: the pages' import map names it,
// and the Caddyfile's Content-Security-Policy allows that one inline script
// by its hash. Put in, the version changed the map and the browser refused
// it, and with it the SDK's import of wisp — no command started, on 21
// October, for 65 minutes. deploy.sh now refuses a build whose inline
// scripts the policy would refuse.
const vendorSdk: Plugin = {
  name: "vendor-wasmer-sdk",
  async buildStart() {
    // Only this version's, so the build carries one copy and no stale ones.
    const wasmer = new URL("./public/vendor/wasmer/", import.meta.url);
    await rm(wasmer, { recursive: true, force: true });
    const to = new URL(`.${SDK_URL.slice("/vendor/wasmer".length)}/`, wasmer);
    for (const dir of ["dist", "pkg"]) {
      await cp(new URL(`${dir}/`, sdkRoot), new URL(`${dir}/`, to), { recursive: true });
    }
    // The SDK's half of the preview (the Caddyfile's /wasmer-host.js), at a
    // name the preview origin can find without knowing the version. It is
    // one file with no imports of its own, and served there asked again
    // each time.
    await cp(new URL("dist/service-worker-host.js", sdkRoot), new URL("service-worker-host.js", wasmer));
    const wisp = new URL("./public/vendor/wisp/", import.meta.url);
    await rm(wisp, { recursive: true, force: true });
    const wispTo = new URL("./src/", wisp);
    await cp(new URL("src/", wispRoot), wispTo, { recursive: true });
    // The substitution the package expects a bundler to make, and says so in
    // the file itself: compat.mjs pulls in `ws`, `crypto`, `node:net` and
    // friends, none of which resolve in a browser, and compat_browser.mjs maps
    // the same names onto the standard APIs. Without this the module resolves
    // and the sandbox then dies on `Failed to resolve module specifier "ws"`.
    await cp(new URL("compat_browser.mjs", wispTo), new URL("compat.mjs", wispTo));
    // The preview origin's service worker and control-page script. They are
    // served only by preview.rishwanth.dev, from here — see the Caddyfile —
    // and under vendor/ because that name is already one no pad can take.
    await cp(new URL("./preview/", import.meta.url), new URL("./public/vendor/preview/", import.meta.url), { recursive: true });
  },
};

/**
 * Whether this build serves the suggestion model (pad/src/complete.ts): it is
 * not in git, and packages/complete/scripts/install-model.mjs puts its manifest
 * here. A deploy from CI copies the server's packages in before it builds, so
 * the build knows what the server has. Without it the page shows no Suggest
 * switch at all; asked for at the first key instead, the switch offered a
 * download and then vanished as typing began.
 */
const SUGGEST = existsSync(new URL("./public/packages/ajar-complete.json", import.meta.url));

export default defineConfig({
  plugins: [isolation, vendorSdk],
  server: {
    port: 5175,
    strictPort: true,
    watch: {
      // Generated binary/vendor trees are copied as a unit. Watching them is
      // wasted work and triggers Windows EBUSY errors on SDK source maps.
      ignored: ["**/public/vendor/**", "**/public/packages/**"],
    },
    proxy: {
      "/api": "http://127.0.0.1:8787",
      // Signing in, for a relay run with AJAR_PUBLIC_ORIGIN set to this
      // server — see docs/dev/operations.md#signing-in.
      "/auth": "http://127.0.0.1:8787",
      "/ws": {
        target: "ws://127.0.0.1:8787",
        ws: true,
      },
    },
  },
  define: { __SDK_URL__: JSON.stringify(SDK_URL), __SUGGEST__: JSON.stringify(SUGGEST) },
  build: {
    sourcemap: false,
    target: "es2022",
    rollupOptions: {
      input: {
        // The app, and the page the browser checks run in. Two entries rather
        // than one, so a check never ships in the bundle a visitor downloads.
        index: fileURLToPath(new URL("./index.html", import.meta.url)),
        check: fileURLToPath(new URL("./check.html", import.meta.url)),
        // The package probe. Also kept out of the visitor's bundle: it exists
        // to install packages we have not decided to ship.
        probe: fileURLToPath(new URL("./probe.html", import.meta.url)),
        net: fileURLToPath(new URL("./net.html", import.meta.url)),
        wisp: fileURLToPath(new URL("./wisp.html", import.meta.url)),
      },
    },
  },
});

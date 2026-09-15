import { cp } from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
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
 */
const SDK_URL = "/vendor/wasmer";
const sdkEntry = createRequire(import.meta.url).resolve("@wasmer/sdk");
const sdkRoot = new URL("../", pathToFileURL(sdkEntry));
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
const wispRoot = pathToFileURL(
  `${wispEntry.slice(0, wispEntry.lastIndexOf(WISP_PKG) + WISP_PKG.length)}/`,
);
const vendorSdk: Plugin = {
  name: "vendor-wasmer-sdk",
  async buildStart() {
    const to = new URL("./public/vendor/wasmer/", import.meta.url);
    for (const dir of ["dist", "pkg"]) {
      await cp(new URL(`${dir}/`, sdkRoot), new URL(`${dir}/`, to), { recursive: true });
    }
    const wispTo = new URL("./public/vendor/wisp/src/", import.meta.url);
    await cp(new URL("src/", wispRoot), wispTo, { recursive: true });
    // The substitution the package expects a bundler to make, and says so in
    // the file itself: compat.mjs pulls in `ws`, `crypto`, `node:net` and
    // friends, none of which resolve in a browser, and compat_browser.mjs maps
    // the same names onto the standard APIs. Without this the module resolves
    // and the sandbox then dies on `Failed to resolve module specifier "ws"`.
    await cp(new URL("compat_browser.mjs", wispTo), new URL("compat.mjs", wispTo));
  },
};

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
      "/ws": {
        target: "ws://127.0.0.1:8787",
        ws: true,
      },
    },
  },
  define: { __SDK_URL__: JSON.stringify(SDK_URL) },
  build: {
    sourcemap: false,
    target: "es2022",
    rollupOptions: {
      input: {
        // The app, and the page the browser checks run in. Two entries rather
        // than one, so a check never ships in the bundle a visitor downloads.
        index: new URL("./index.html", import.meta.url).pathname,
        check: new URL("./check.html", import.meta.url).pathname,
        // The package probe. Also kept out of the visitor's bundle: it exists
        // to install packages we have not decided to ship.
        probe: new URL("./probe.html", import.meta.url).pathname,
        net: new URL("./net.html", import.meta.url).pathname,
      },
    },
  },
});

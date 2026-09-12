import { cp } from "node:fs/promises";
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
const vendorSdk: Plugin = {
  name: "vendor-wasmer-sdk",
  async buildStart() {
    const from = new URL("./node_modules/@wasmer/sdk/", import.meta.url);
    const to = new URL("./public/vendor/wasmer/", import.meta.url);
    for (const dir of ["dist", "pkg"]) {
      await cp(new URL(dir, from), new URL(dir, to), { recursive: true });
    }
  },
};

export default defineConfig({
  plugins: [isolation, vendorSdk],
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
      },
    },
  },
});

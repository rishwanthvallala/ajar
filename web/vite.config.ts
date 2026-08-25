import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 5173,
    // Session links are /j/<id>; hand them all to the SPA.
    proxy: {},
  },
  appType: "spa",
  build: {
    outDir: "dist",
    // Off for the shipped build. Monaco's vendor maps were 42 MB of a 56 MB
    // deploy — rsynced every time, on a 20 GB disk — and the source they map
    // back to is public on GitHub anyway. `npm run build -- --sourcemap` when
    // something needs debugging against a production bundle.
    sourcemap: false,
  },
});

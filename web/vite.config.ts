import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 5173,
    // Session links are /j/<id>; hand them all to the SPA.
    proxy: {},
  },
  appType: "spa",
  build: { outDir: "dist", sourcemap: true },
});

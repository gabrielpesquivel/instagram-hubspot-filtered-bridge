import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  define: {
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  // mupdf (Cut Files page) loads its WASM with top-level await.
  worker: { format: "es" },
  optimizeDeps: { exclude: ["mupdf"] },
  build: {
    target: "es2022",
    outDir: "../public",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/api": "http://localhost:8787",
      "/auth": "http://localhost:8787",
    },
  },
});

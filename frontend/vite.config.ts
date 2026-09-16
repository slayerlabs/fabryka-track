import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "../src/fabryka_track/web",
    emptyOutDir: true,
    assetsDir: "assets",
  },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:8131",
      "/assets/plotly-basic-3.1.0.min.js": "http://127.0.0.1:8131",
      "/goals/250m-english-base-model.md": "http://127.0.0.1:8131",
    },
  },
});

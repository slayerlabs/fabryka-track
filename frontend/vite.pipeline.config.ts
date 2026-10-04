import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: fileURLToPath(new URL("./pipeline", import.meta.url)),
  base: "/pipeline/",
  publicDir: false,
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL("../src/fabryka_track/pipeline_web", import.meta.url)),
    emptyOutDir: true,
    assetsDir: "assets",
    sourcemap: false,
    manifest: true,
  },
});

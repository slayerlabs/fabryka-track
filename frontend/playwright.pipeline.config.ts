import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/pipeline",
  testMatch: "*.spec.ts",
  outputDir: "test-artifacts/playwright",
  timeout: 60000,
  expect: { timeout: 15000 },
  use: {
    baseURL: "http://127.0.0.1:4174",
    channel: process.env.PIPELINE_BROWSER_CHANNEL || undefined,
    trace: "off",
    video: "off",
    screenshot: "off",
  },
  webServer: {
    command: "npx vite preview --config vite.pipeline.config.ts --host 127.0.0.1 --port 4174 --strictPort",
    url: "http://127.0.0.1:4174/pipeline/",
    reuseExistingServer: false,
    timeout: 30000,
  },
});

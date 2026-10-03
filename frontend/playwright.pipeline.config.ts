import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "@playwright/test";

const repo = resolve(import.meta.dirname, "..");
const localPython = resolve(repo, ".venv/bin/python");
const python = process.env.PIPELINE_TEST_PYTHON ?? (existsSync(localPython) ? localPython : "python");

export default defineConfig({
  testDir: "./tests/pipeline",
  testMatch: "*.spec.ts",
  outputDir: "test-artifacts/playwright",
  timeout: 60000,
  expect: { timeout: 15000 },
  use: {
    baseURL: "http://127.0.0.1:4174",
    httpCredentials: { username: "operator", password: "local-test-password" },
    channel: process.env.PIPELINE_BROWSER_CHANNEL || undefined,
    trace: "off",
    video: "off",
    screenshot: "off",
  },
  webServer: {
    command: `"${python}" ../scripts/serve_pipeline_test.py`,
    env: { PYTHONPATH: resolve(repo, "src") },
    url: "http://127.0.0.1:4174/health",
    reuseExistingServer: false,
    timeout: 30000,
  },
});

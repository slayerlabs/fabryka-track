import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { TEST_NOW, installFixtureJourney, type Journey } from "./fixtures.ts";

const JSONL = '{"text":"Synthetic corpus record","license":"CC0-1.0"}\n';

async function fill(page: Page, contents = JSONL) {
  await page.goto("/pipeline/");
  await page.getByLabel("Input file").setInputFiles({
    name: "synthetic.jsonl", mimeType: "application/jsonl", buffer: Buffer.from(contents),
  });
  await page.getByLabel("Source").fill("synthetic_ui");
}

function clean(journey: Journey) {
  expect(journey.unexpected).toEqual([]);
  expect(journey.credentialLeaks).toEqual([]);
}

test("failed QA exposes diagnostic action, never passed", async ({ page }) => {
  const journey = await installFixtureJourney(page, "failed_qa");
  await fill(page);
  await page.getByRole("button", { name: "Upload" }).click();
  await expect(page.getByText("QA failed — diagnostic only")).toBeVisible();
  await expect(page.getByRole("button", { name: "Download diagnostic result" })).toBeVisible();
  await expect(page.getByText("Upload passed", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Download diagnostic result" }).click();
  await expect.poll(() => journey.downloads).toEqual(["/result/diagnostic"]);
  clean(journey);
});

test("passed upload goes directly to storage, confirms once and offers report and result", async ({ page }) => {
  const journey = await installFixtureJourney(page, "passed");
  await fill(page);
  await page.getByLabel("Default license").fill("CC0-1.0");
  await page.getByRole("button", { name: "Upload" }).click();
  await expect(page.getByRole("heading", { name: "Upload passed" })).toBeFocused();
  expect(journey.backend.stored.get(1)).toEqual(new Uint8Array(Buffer.from(JSONL)));
  const [create] = journey.createCalls();
  const body = JSON.parse(String(create.body));
  expect(body.metadata).toEqual({ source: "synthetic_ui", added: body.metadata.added, license: "CC0-1.0" });
  expect(body.encoded_bytes).toBe(Buffer.byteLength(JSONL));
  expect(journey.confirmCalls()).toHaveLength(1);
  await expect(page.getByText(/Report and result available until/)).toBeVisible();
  await page.getByRole("button", { name: "View report" }).click();
  const report = page.getByRole("region", { name: "QA report" });
  await expect(report.getByText("Rows written: 2", { exact: false })).toBeVisible();
  await expect(report.getByText("PERSON and street-address coverage is unmeasured.")).toBeVisible();
  await expect(report.getByText("residual pii: passed; count: 0")).toBeVisible();
  await page.getByRole("button", { name: "Download result" }).click();
  await expect.poll(() => journey.downloads).toEqual(["/result/passed"]);
  await expect(page.getByRole("button", { name: "Cancel job" })).toHaveCount(0);
  clean(journey);
});

test("finalizing is shown explicitly before the verdict is published", async ({ page }) => {
  const journey = await installFixtureJourney(page, "passed");
  await fill(page);
  await page.getByRole("button", { name: "Upload" }).click();
  await expect(page.getByRole("heading", { name: "Finalizing…" })).toBeVisible();
  await expect(page.getByText("Publication or cleanup is still pending.")).toBeVisible();
  await expect(page.getByText(/Last update:/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Download result" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Upload passed" })).toBeVisible();
  clean(journey);
});

test("a lost confirmation is retried manually with the same key and body", async ({ page }) => {
  const journey = await installFixtureJourney(page, "passed");
  journey.confirmReply = (attempt) => (attempt === 1 ? "network" : undefined);
  await fill(page);
  await page.getByRole("button", { name: "Upload" }).click();
  await expect(page.getByRole("status")).toHaveText("Connection lost. Check the network, then select Retry");
  await expect(page.getByRole("button", { name: "Retry" })).toBeFocused();
  await expect(page.getByRole("button", { name: "Upload" })).toBeDisabled();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Upload passed" })).toBeVisible();
  const [first, second] = journey.confirmCalls();
  expect(second.key).toBe(first.key);
  expect(second.body).toBe(first.body);
  expect(journey.createCalls()).toHaveLength(1);
  expect(journey.backend.storageCalls().filter((call) => call.method === "PUT")).toHaveLength(1);
  clean(journey);
});

test("empty QA result says no result is available", async ({ page }) => {
  const journey = await installFixtureJourney(page, "empty_result");
  await fill(page);
  await page.getByRole("button", { name: "Upload" }).click();
  await expect(page.getByRole("heading", { name: "QA failed — diagnostic only" })).toBeVisible();
  await expect(page.getByText("No result available.")).toBeVisible();
  await expect(page.getByRole("button", { name: /Download/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "View report" })).toBeVisible();
  clean(journey);
});

test("failed processing offers nothing to download", async ({ page }) => {
  const journey = await installFixtureJourney(page, "failed");
  await fill(page);
  await page.getByRole("button", { name: "Upload" }).click();
  await expect(page.getByRole("heading", { name: "Upload failed" })).toBeVisible();
  await expect(page.getByText("Reason: Processing failed.")).toBeVisible();
  await expect(page.getByText("No result available.")).toBeVisible();
  await expect(page.getByRole("button", { name: /Download|View report/ })).toHaveCount(0);
  clean(journey);
});

test("expired results are explicit and never downloadable", async ({ page }) => {
  const journey = await installFixtureJourney(page, "expired");
  await fill(page);
  await page.getByRole("button", { name: "Upload" }).click();
  await expect(page.getByRole("heading", { name: "Results expired" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Download|View report/ })).toHaveCount(0);
  await expect(page.getByText("Upload passed", { exact: true })).toHaveCount(0);
  clean(journey);
});

for (const [outcome, text] of [["quota", "Pipeline capacity is full"], ["invalid", "Invalid input or metadata"]] as const) {
  test(`${outcome} admission failure is explicit`, async ({ page }) => {
    const journey = await installFixtureJourney(page, outcome);
    await fill(page);
    await page.getByRole("button", { name: "Upload" }).click();
    await expect(page.getByRole("status")).toHaveText(text);
    expect(journey.backend.storageCalls()).toHaveLength(0);
    await expect(page.getByRole("heading", { level: 2 })).toHaveCount(0);
    clean(journey);
  });
}

for (const [status, code, text] of [[401, "unauthorized", "Authentication required"],
  [403, "forbidden_origin", "Request origin denied"],
  [503, "provider_unavailable", "Pipeline temporarily unavailable"]] as const) {
  test(`create ${status} shows fixed text`, async ({ page }) => {
    const journey = await installFixtureJourney(page, "passed");
    journey.createReply = () => journey.backend.error(status, code, status === 503,
      status === 503 ? { "Retry-After": "120" } : undefined);
    await fill(page);
    await page.getByRole("button", { name: "Upload" }).click();
    await expect(page.getByRole("status")).toHaveText(text);
    await expect(page.getByText(/Synthetic/)).toHaveCount(0);
    clean(journey);
  });
}

test("a retried create replays the same key and body and makes one job", async ({ page }) => {
  const journey = await installFixtureJourney(page, "passed");
  journey.createReply = (attempt) => (attempt === 1
    ? journey.backend.error(503, "provider_unavailable", true, { "Retry-After": "120" }) : undefined);
  await fill(page);
  await page.getByRole("button", { name: "Upload" }).click();
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByRole("heading", { name: "Upload passed" })).toBeVisible();
  const [first, second] = journey.createCalls();
  expect(second.key).toBe(first.key);
  expect(second.body).toBe(first.body);
  clean(journey);
});

test("empty and unsupported files are refused before hashing or contacting the pipeline", async ({ page }) => {
  const journey = await installFixtureJourney(page, "passed");
  await fill(page, "");
  await page.getByRole("button", { name: "Upload" }).click();
  await expect(page.getByRole("status")).toHaveText("The selected file is empty");
  await page.getByLabel("Input file").setInputFiles({ name: "x.jsonl", mimeType: "application/jsonl",
    buffer: Buffer.from([0x1f, 0x8b, 0x08, 0x00]) });
  await page.getByRole("button", { name: "Upload" }).click();
  await expect(page.getByRole("status")).toHaveText("Unsupported file format. Use JSONL or Parquet");
  expect(journey.backend.calls).toHaveLength(0);
  clean(journey);
});

test("cancel sends a stable cancel key and shows the cancelled job", async ({ page }) => {
  const journey = await installFixtureJourney(page, "passed");
  journey.confirmReply = () => "network";
  await fill(page);
  await page.getByRole("button", { name: "Upload" }).click();
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel job" }).click();
  await expect(page.getByRole("heading", { name: "Upload cancelled" })).toBeVisible();
  const cancels = journey.backend.controlCalls().filter((call) => call.url.endsWith("/cancel"));
  expect(cancels).toHaveLength(1);
  expect(cancels[0].key).toMatch(/^[0-9a-f-]{36}$/);
  await expect(page.getByRole("button", { name: "Upload" })).toBeEnabled();
  clean(journey);
});

test("after a reload the same job resumes only with the original file", async ({ page }) => {
  const journey = await installFixtureJourney(page, "passed");
  journey.storageReply = (attempt) => (attempt === 1 ? "network" : undefined);
  await fill(page);
  await page.getByRole("button", { name: "Upload" }).click();
  await expect(page.getByRole("status")).toHaveText("Connection lost. Check the network, then select Retry");
  await page.reload();
  await expect(page.getByRole("status")).toContainText("An unfinished upload was found");
  await expect(page.getByText(/Upload deadline: /)).toBeVisible();
  await expect(page.getByRole("button", { name: "Upload" })).toBeDisabled();
  await page.getByLabel("Original file").setInputFiles({ name: "other.jsonl", mimeType: "application/jsonl",
    buffer: Buffer.from('{"text":"Different"}\n') });
  await page.getByRole("button", { name: "Resume transfer" }).click();
  await expect(page.getByRole("status")).toHaveText("The selected file does not match this upload");
  await page.getByLabel("Original file").setInputFiles({ name: "synthetic.jsonl", mimeType: "application/jsonl",
    buffer: Buffer.from(JSONL) });
  await page.getByRole("button", { name: "Resume transfer" }).click();
  await expect(page.getByRole("heading", { name: "Upload passed" })).toBeVisible();
  expect(journey.createCalls()).toHaveLength(1);
  expect(journey.backend.stored.get(1)).toEqual(new Uint8Array(Buffer.from(JSONL)));
  const stored = await page.evaluate(() => sessionStorage.getItem("pipeline-upload-operation") ?? "");
  expect(stored).not.toMatch(/synthetic|CC0|Signature|filename|source_ref|author|license/);
  clean(journey);
});

test("the form is labelled and usable from the keyboard", async ({ page }) => {
  const journey = await installFixtureJourney(page, "passed");
  await fill(page);
  for (const label of ["Input file", "Source", "Added date", "Default license", "Default author",
    "Default reference", "Require a reference in each record"]) {
    await expect(page.getByLabel(label)).toHaveCount(1);
  }
  await expect(page.getByRole("status")).toHaveAttribute("aria-live", "polite");
  await page.getByLabel("Source").press("Enter");
  await expect(page.getByRole("heading", { name: "Upload passed" })).toBeFocused();
  clean(journey);
});

test("the private screen has no public navigation or HF login", async ({ page }) => {
  await installFixtureJourney(page, "passed");
  await page.goto("/pipeline/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Data Pipeline Upload");
  await expect(page.getByRole("navigation")).toHaveCount(0);
  await expect(page.getByText(/Hugging Face|Sign in/i)).toHaveCount(0);
});

test("a stalled cleanup after the verdict never blocks the operator", async ({ page }) => {
  const journey = await installFixtureJourney(page, "passed");
  journey.stallCleanup = true;
  await fill(page);
  await page.getByRole("button", { name: "Upload" }).click();
  await expect(page.getByRole("button", { name: "Download result" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Cancel job" })).toHaveCount(0);
  await page.clock.setFixedTime(TEST_NOW + 61000);
  await expect(page.getByRole("status")).toHaveText(
    "Finalizing is taking longer than expected. Select Retry to check again");
  await expect(page.getByRole("button", { name: "Upload" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Cancel job" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Download result" })).toBeVisible();
  expect(journey.backend.controlCalls().filter((call) => call.url.endsWith("/cancel"))).toHaveLength(0);
  clean(journey);
});

test("cancel after a lost create replays the same create and cancels that job", async ({ page }) => {
  const journey = await installFixtureJourney(page, "passed");
  journey.createReply = (attempt) => (attempt === 1
    ? journey.backend.error(503, "provider_unavailable", true, { "Retry-After": "120" }) : undefined);
  await fill(page);
  await page.getByRole("button", { name: "Upload" }).click();
  await expect(page.getByRole("status")).toHaveText("Pipeline temporarily unavailable");
  await page.getByRole("button", { name: "Cancel job" }).click();
  await expect(page.getByRole("heading", { name: "Upload cancelled" })).toBeVisible();
  const [first, second] = journey.createCalls();
  expect(second.key).toBe(first.key);
  expect(second.body).toBe(first.body);
  expect(journey.createCalls()).toHaveLength(2);
  expect(journey.backend.controlCalls().filter((call) => call.url.endsWith("/cancel"))).toHaveLength(1);
  expect(journey.backend.storageCalls()).toHaveLength(0);
  await expect(page.getByRole("button", { name: "Upload" })).toBeEnabled();
  clean(journey);
});

test("an unconfirmed cancel keeps the operation and says a job may exist", async ({ page }) => {
  const journey = await installFixtureJourney(page, "passed");
  journey.createReply = (attempt) => (attempt <= 2
    ? journey.backend.error(503, "provider_unavailable", true, { "Retry-After": "120" }) : undefined);
  await fill(page);
  await page.getByRole("button", { name: "Upload" }).click();
  await expect(page.getByRole("status")).toHaveText("Pipeline temporarily unavailable");
  await page.getByRole("button", { name: "Cancel job" }).click();
  await expect(page.getByRole("status")).toHaveText(
    "Cancellation is not confirmed and a job may have been created. Select Retry to cancel it");
  await expect(page.getByRole("button", { name: "Upload" })).toBeDisabled();
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByRole("heading", { name: "Upload cancelled" })).toBeVisible();
  expect(new Set(journey.createCalls().map((call) => call.key)).size).toBe(1);
  expect(journey.backend.controlCalls().filter((call) => call.url.endsWith("/cancel"))).toHaveLength(1);
  clean(journey);
});

test("a confirm refused after the upload window shows the expired job", async ({ page }) => {
  const journey = await installFixtureJourney(page, "passed");
  journey.confirmReply = () => {
    journey.uploadExpired = true;
    return journey.backend.error(410, "expired");
  };
  await fill(page);
  await page.getByRole("button", { name: "Upload" }).click();
  await expect(page.getByRole("heading", { name: "Upload window expired" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Upload" })).toBeEnabled();
  expect(journey.confirmCalls()).toHaveLength(1);
  clean(journey);
});

test("download waits for its grant and an expired grant refreshes the job", async ({ page }) => {
  const journey = await installFixtureJourney(page, "passed");
  let release = () => {};
  journey.resultGate = new Promise((resolve) => { release = resolve; });
  journey.resultExpired = true;
  await fill(page);
  await page.getByRole("button", { name: "Upload" }).click();
  await expect(page.getByRole("heading", { name: "Upload passed" })).toBeVisible();
  await page.getByRole("button", { name: "Download result" }).click();
  await expect(page.getByRole("button", { name: "Download result" })).toBeDisabled();
  release();
  await expect(page.getByRole("heading", { name: "Results expired" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Download|View report/ })).toHaveCount(0);
  expect(journey.downloads).toEqual([]);
  clean(journey);
});

test.describe("actual private server without fixture interception", () => {
  const CHALLENGE = 'Basic realm="Pipeline Upload", charset="UTF-8"';

  async function builtPaths(request: APIRequestContext) {
    const html = await (await request.get("/pipeline/")).text();
    const assets = [...html.matchAll(/(?:src|href)="(\/pipeline\/assets\/[^"]+)"/g)].map((match) => match[1]);
    expect(assets.length).toBeGreaterThanOrEqual(2);
    return assets;
  }

  test("every private path needs Basic before any bytes", async ({ request, baseURL }) => {
    const paths = ["/pipeline", "/pipeline/", "/pipeline/index.html", "/pipeline/api/jobs",
      ...await builtPaths(request)];
    // Plain fetch: Playwright request contexts inherit the configured operator pair.
    for (const path of paths) {
      for (const method of ["GET", "HEAD"]) {
        const response = await fetch(baseURL + path, { method, redirect: "manual", headers: { "If-None-Match": "*" } });
        expect(response.status, method + " " + path).toBe(401);
        expect(response.headers.get("www-authenticate")).toBe(CHALLENGE);
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(await response.text()).not.toContain("Data Pipeline Upload");
      }
    }
  });

  test("authenticated operator gets only the built entry and assets", async ({ request }) => {
    for (const path of await builtPaths(request)) {
      expect((await request.get(path)).status(), path).toBe(200);
      expect((await request.get(path + ".map")).status()).toBe(404);
    }
    for (const path of ["/pipeline/index.html", "/pipeline/.vite/manifest.json", "/pipeline/src/pipeline/main.tsx",
      "/pipeline/assets/", "/pipeline/assets/%2e%2e/index.html"]) {
      expect((await request.get(path)).status(), path).toBe(404);
    }
  });

  test("a browser without the pair sees no private screen", async ({ browser }) => {
    const context = await browser.newContext({ httpCredentials: undefined });
    const page = await context.newPage();
    const response = await page.goto("/pipeline/");
    expect(response?.status()).toBe(401);
    await expect(page.getByRole("heading", { name: "Data Pipeline Upload" })).toHaveCount(0);
    await context.close();
  });

  test("the guard refuses the local test origin and never reaches a controller", async ({ page }) => {
    await page.goto("/pipeline/");
    const replies = await page.evaluate(async () => {
      const post = (headers: Record<string, string>) => fetch("/pipeline/api/jobs", { method: "POST",
        headers: { "Content-Type": "application/json", ...headers }, body: "{}" })
        .then(async (response) => [response.status, (await response.json()).code]);
      return [await post({ "X-Pipeline-Request": "1" }), await post({})];
    });
    expect(replies).toEqual([[403, "forbidden_origin"], [403, "forbidden_origin"]]);
    const status = await page.request.get("/pipeline/api/jobs/10000000-0000-4000-8000-000000000001");
    // The fixed request_id proves the request passed the guard and reached the harness transport.
    expect([status.status(), await status.json()]).toEqual([503, expect.objectContaining({
      code: "provider_unavailable", request_id: "90000000-0000-4000-8000-000000000001" })]);
  });
});

# Private pipeline upload

`https://track.fabryka.ai/pipeline/` is an unadvertised operator screen for the upload pipeline
(`upload-control-v1`). It is served by the same Track application as the public site; Caddy only
routes `/pipeline` and `/pipeline/*` to it explicitly. HF login and the public `/api/` browser guard
play no part in it.

## Configuration

Set in the server `.env` (names only; never commit values):

| Variable | Meaning |
| --- | --- |
| `FABRYKA_PIPELINE_USERNAME` | Shared pipeline Basic user (no `:`). |
| `FABRYKA_PIPELINE_PASSWORD` | Shared pipeline Basic password. |
| `FABRYKA_PIPELINE_CONTROLLER_URL` | Fixed controller base, default `https://data-pipeline.fabryka.ai`. HTTPS only, no userinfo, query or fragment. |

An empty pair or an invalid controller URL disables only the private screen: every `/pipeline*`
request answers 503 and the public site is unaffected. The Basic pair must equal the controller's
client pair. Provider, S3 and worker credentials never belong to Track.

## Authentication boundary

- Every `/pipeline/*` request (HTML, assets, HEAD, conditional, `/pipeline/api/*`) needs the shared Basic
  pair before any bytes are returned; a failure is 401 with
  `WWW-Authenticate: Basic realm="Pipeline Upload", charset="UTF-8"`.
- `/pipeline` without the slash answers a fixed 308 to `/pipeline/` for every method, before the Basic
  check, with no body, no `WWW-Authenticate` and the private headers; the query string is never echoed.
  A challenge there would make browsers scope the cached pair to `/` and send it to public Track
  endpoints that refuse any `Authorization` header. The redirect only reveals that `/pipeline/` exists.
- The decision uses the routed path (root_path stripped), and the router repeats the check.
- All private responses carry `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: DENY`.

## Controller proxy

`/pipeline/api/<route>` maps to `<controller>/uploads/v1/<route>` for exactly these client routes:

| Method | Route |
| --- | --- |
| GET, POST | `jobs` (`GET /pipeline/api/jobs` is proxied for contract completeness; the screen never lists jobs) |
| GET | `jobs/{job_id}` |
| POST | `jobs/{job_id}/parts`, `jobs/{job_id}/confirm`, `jobs/{job_id}/cancel` |
| GET | `jobs/{job_id}/report` |
| GET, HEAD | `jobs/{job_id}/result` |

`{job_id}` is a lowercase UUID. Anything else is 404; another method on a listed route is 405 with
`Allow` (OPTIONS included). Worker routes (`/worker/v1/*`) are never reachable. The raw path is checked
once and never decoded again: percent escapes, `//`, backslashes and dot segments are 422.

Query parameters are rebuilt from validated values only: `limit` (1–100) and `cursor`
(`[A-Za-z0-9_-]{1,256}`) on `GET jobs`, `diagnostic=true|false` on `result`. Any other parameter is 422.

### Browser mutations

Basic credentials are replayed by browsers cross-site, so every POST additionally needs
`X-Pipeline-Request: 1`, `Origin: https://track.fabryka.ai` exactly (missing, `null` or foreign is
refused) and, when present, `Sec-Fetch-Site: same-origin`. Failures are 403 `forbidden_origin`.
Bodies must be UTF-8 `application/json` (optionally `charset=utf-8`) of at most 65536 bytes (413 above,
422 otherwise) and are forwarded byte-for-byte so idempotent replays keep their digest.

### Forwarding rules

- Upstream request headers are built from an allowlist: the caller's own `Authorization` (already
  verified as the pipeline pair, never replaced), `Content-Type`, `Idempotency-Key`,
  `X-Pipeline-Request`, `Origin`, `Sec-Fetch-Site`. Cookies, `Host`, forwarding and hop-by-hop
  headers are dropped.
- Responses keep status, `Content-Type`, `WWW-Authenticate`, `Retry-After` and `Allow`, plus the
  private headers above. Upstream redirects are never followed; they become 502.
- Upstream error bodies must match the contract `Error` schema; otherwise, like non-JSON or oversized
  (> 1 MiB + 64 KiB) bodies, they are replaced by 502 `provider_unavailable`. Transport failures and
  timeouts (10 s) are 503 `provider_unavailable` with `Retry-After: 5`. The browser waits 15 s per control
  call, so that 503 and its `Retry-After` reach it.
- Track's own log lines record only the failure type, never credentials or bodies. httpx may log the
  upstream request line (method, controller route, status) at INFO; that route holds at most a job ID
  and the validated `limit`, `cursor` or `diagnostic` values, never credentials or signed storage URLs.

Storage transfers go directly from the browser to signed storage URLs and never pass through
this proxy or carry Basic credentials.

## Operator journey

1. Open `/pipeline/` and sign in with the shared pipeline pair (the browser keeps it; the page never
   stores it).
2. Choose a JSONL or Parquet file (at most 512 MiB) and fill in **Source** (lowercase letters, digits,
   `_`) and **Added date**. Default license, author and reference are optional and omitted when blank;
   **Require a reference in each record** turns on per-record provenance.
3. **Upload** checks the file type and size locally, computes its SHA-256 in the browser, creates the
   job, waits until storage is ready, sends parts of the session's `part_size_bytes` (8 MiB today) straight
   to signed storage URLs, confirms the upload and then follows the job.
4. The status panel shows processing, publication and cleanup separately. While publication or cleanup
   is unresolved the title is **Finalizing…** with the time of the last update; a verdict is shown only
   once it is published.
5. When the job ends: **Upload passed** offers **Download result**; **QA failed — diagnostic only**
   offers **Download diagnostic result**, never a passed result; an empty curated output or a failed
   job shows **No result available**. **View report** appears once the report is published and shows
   only aggregate counts. **Results expired** offers nothing.

### Reading the QA report

Blocking checks decide the verdict: any failed check makes the job diagnostic only. Warnings
(`masking_only_duplicate`, `license_needs_legal_review`) never block a passed result. Records removed
during curation (filtering, deduplication) show as the difference between rows read and rows written;
removal fails the job only through a blocking check such as `rejection_share`. PII is masked, not
removed. Detection covers PESEL, e-mail and phone numbers; **PERSON and street-address coverage is unmeasured**, so a passed report is not a
claim that names or addresses are absent.

### Errors and retries

Messages are fixed English texts; server error text, job IDs and signed URLs are never shown.

| Response | Message |
| --- | --- |
| 401 | Authentication required |
| 403 | Request origin denied |
| 409 | Operation is not available in this state |
| 410 | Upload or artifact expired |
| 413 | Input exceeds the limit |
| 422 | Invalid input or metadata |
| 429 | Pipeline capacity is full |
| 502, 503, 504 | Pipeline temporarily unavailable |

- Transient control errors are retried automatically up to three times with the same idempotency key
  and body. A lost connection stops automatic attempts and shows **Retry**, which repeats exactly the
  last step (create, part transfer, confirm, cancel or status) with its original key and body; it never
  creates a second job. **Upload** stays disabled until the job has a verdict; if publication or cleanup
  is still pending it becomes available again once the 60 s **Finalizing…** limit ends polling.
- Status is polled every 2 s. Polling stops on `complete`, `rejected` or `expired`, after three
  consecutive failed requests, after 60 s of **Finalizing…**, or when an unfinished job passes its
  upload or job deadline; each case shows **Retry**. **Refresh status**, report and result stay
  available after processing ends, until the artifacts expire, and only until the next **Upload**: the
  screen keeps no job list, so a previous job's status, report and result are not reachable afterwards.
- **Cancel job** aborts the local transfer and, once a job exists, sends a cancel request with its own
  stable key. If the create was sent but never confirmed, Cancel first replays it with the same create key
  and body; that replay is idempotent, so it returns the job the lost create made or, if none was stored,
  creates it, and the job is then cancelled.
- `sessionStorage` keeps only the job's upload session (IDs, hash, size, deadlines) and the three
  operation keys, never the file name, metadata or signed URLs. After a reload the screen shows the
  original upload deadline and asks for the original file; a file with a different hash or size is
  refused, and the matching file continues the same job and parts. The stored entry is dropped once the
  job is settled or the controller answers `not_found` for it, so a stale entry never disables **Upload**.

## Local browser tests

`frontend/playwright.pipeline.config.ts` starts `scripts/serve_pipeline_test.py` on `127.0.0.1:4174`. It
serves the actual private build through the production `pipeline_app` boundary (Basic, static allowlist,
controller proxy, literal origin `https://track.fabryka.ai`) with the non-secret test pair
`operator` / `local-test-password`; its controller transport answers every request with 503, so nothing
leaves the machine. `/health` (`"evidence": "local_fixture"`) exists only in this harness.

- Journey tests (`frontend/tests/pipeline/fixtures.ts`, `installFixtureJourney`) load the page through
  Basic and intercept control and storage requests in the browser with approved contract fixtures
  (outcomes passed, failed_qa, empty_result, failed, expired, quota, invalid). The local origin is
  accepted only by these interceptors, never by the application guard. Any other host is aborted and
  fails the test; storage requests carrying `Authorization` or cookies fail it too.
- Server tests send requests to the harness without interception: every built path, `/pipeline/`,
  `/pipeline/api/jobs` × GET/HEAD/conditional without the pair → 401 with no bytes; `/pipeline` → 308
  without the pair and without `WWW-Authenticate`; alternates and
  source maps → 404 after auth; a POST from the local origin → 403 `forbidden_origin`.

Trace, video and screenshots are off. These are local fixture results, not evidence of a deployed
controller, storage, provider or TLS; live browser, API, storage and cost proof belongs to #765.

```bash
cd frontend
npm ci && npm run build
npx playwright install chromium
npx playwright test --config playwright.pipeline.config.ts
```

`PIPELINE_TEST_PYTHON` selects the interpreter for the harness (default `../.venv/bin/python`, else
`python`); it needs the `test` extra and `src` on `PYTHONPATH`, which the config sets.
`PIPELINE_BROWSER_CHANNEL` selects an installed browser channel instead of the bundled Chromium.

## Release and hand-off

CI builds both entries once (`npm run build` = public `web/` + private `pipeline_web/`), runs the Node
contract/state tests, the full pytest suite and the private browser suite, then packages:

```bash
git archive --format=tar --output=release.tar HEAD
tar -rf release.tar src/fabryka_track/web src/fabryka_track/pipeline_web
```

`tests/test_pipeline_build.py` replays exactly these packaging lines from the workflow into a scratch
archive and checks that every built private file is included and no source map exists. The SDK wheel
(`src/fabryka`) is unchanged.

Private path manifest of a build: `/pipeline` (fixed 308 to `/pipeline/`, before Basic); behind Basic:
`/pipeline/`,
`/pipeline/assets/index-<hash>.js`, `/pipeline/assets/index-<hash>.css`, `/pipeline/api/<route>` (table
above). `pipeline_web/.vite/manifest.json` ships in the archive but is never served (404). List a build
with `find src/fabryka_track/pipeline_web -type f | sort | xargs shasum -a 256`.

Operator check after a separately authorized deploy (#765): Basic prompt → choose JSONL or Parquet →
metadata → direct PUT to storage → confirm (a replay keeps its key) → status → report, result or
diagnostic → expiry.

### Rollback

Rollback touches only the private feature: clear `FABRYKA_PIPELINE_USERNAME` / `FABRYKA_PIPELINE_PASSWORD`
(every `/pipeline*` answers 503) or ship a release without `pipeline_web` (`/pipeline/` answers 503,
assets 404); optionally drop the `@pipeline` Caddy handle, which falls through to the same app. The
public Track site, HF login, training jobs and jobs already held by the controller keep their behavior;
controller-side jobs continue and expire on their own deadlines.

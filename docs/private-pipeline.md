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

- Every `/pipeline*` request (HTML, assets, HEAD, conditional, `/pipeline/api/*`) needs the shared Basic
  pair before any bytes are returned; a failure is 401 with
  `WWW-Authenticate: Basic realm="Pipeline Upload", charset="UTF-8"`.
- The decision uses the routed path (root_path stripped), and the router repeats the check.
- All private responses carry `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: DENY`.

## Controller proxy

`/pipeline/api/<route>` maps to `<controller>/uploads/v1/<route>` for exactly these client routes:

| Method | Route |
| --- | --- |
| GET, POST | `jobs` |
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
  timeouts (10 s) are 503 `provider_unavailable` with `Retry-After: 5`.
- Logs record only the failure type, never credentials, bodies or URLs with signatures.

Storage transfers go directly from the browser to signed storage URLs and never pass through
this proxy or carry Basic credentials.

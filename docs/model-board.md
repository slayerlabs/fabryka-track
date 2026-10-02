# Model leaderboard

`/models` ranks one checkpoint per model, separately for English and Polish: the checkpoint its owner marked as the result, or else the latest checkpoint the track evaluated itself. It reads the public, anonymous endpoint `GET /api/leaderboard/models`; the page is `frontend/src/pages/ModelBoard.tsx` with pure helpers in `frontend/src/pages/model-board-data.ts` (tested by `tests/model-board.test.mjs`). The separate `/leaderboard` (Training results) and `/benchmark-results` pages are unchanged.

## Putting a run on the board

Every public, finished run with a server evaluation is on the board without any action from its owner (see [Rows measured by the track](#rows-measured-by-the-track)). An owner can instead put a specific checkpoint and their own board series on it. An owner-marked row appears when all of these hold:

1. The run is `finished` and public (the same `is_public` gate as the anonymous run view).
2. Its owner opted in to public board metrics: attribute `visibility/public_board_metrics` is literally `true`. The same flag already publishes the run's `board/*` series in the read-only run view; on this board it also publishes the `board_pl/*` values at the result step. Setting it to anything else removes the row.
3. It logged the board series at the result step:
   - EN: `board/eff`, `board/arc_easy`, `board/blimp` (Glint 0–100 scale) and `board/wiki_byte_ppl` (raw byte perplexity). The row is in the EN category only when all four exist at that step.
   - PL: `board_pl/multiblimp` (G, MultiBLiMP-pl accuracy in %; the length baseline, always picking the shorter sentence, scores about 60 %, not 50 %). The row is in the PL category when it exists. Optional: `board_pl/arc_easy` (K, ARC-Easy-PL accuracy in %), `board_pl/byte_ppl` (W, byte perplexity on a private held-out Polish text; the text is never published, only the number) and `board_pl/eff` (eff-PL = (G + K + WS) / 3 × the same size multiplier as EN, where WS is the score derived from W; our protocol, not an official one). Values are copied as logged; the server does not recompute them.
4. It carries a valid `leaderboard/result` attribute (below). Studio runs cannot be marked because their records are managed by the training worker; log results from an SDK run.

Values are read at exactly `result.step`, never the latest step. A missing value is `null`, never 0; a row with neither category complete is omitted. When several runs report the same `checkpoint_sha256`, a trusted owner's run wins over any other, then the earliest finished run, so a later copy of a checkpoint sha cannot replace the original row. An opted-in `visibility/public_note` is shown with the row. No other attribute, config, note or series leaves the server. A run with an owner-marked row is never shown with its track-measured row as well.

## Rows measured by the track

Rows with the badge "measured by track" come from the server's own benchmark evaluations, not from anything the owner logged. They are built per run as follows:

1. The run is public and `finished`, and the evaluation is `finished` in `full` mode: the same gate as the public `/api/benchmark-results`. Evaluations whose provenance is marked `private` are excluded (Tiny-ML: see 2). Synthetic reference runs (`engine: benchmark-reference`, other boards' imported references) are not track participants and are excluded.
2. EN comes from the track's Tiny-ML suite (`tiny-ml-en-v2-byte-sliding-aci`), scored on the server with the frozen Tiny-ML formula: eff is the Tiny-ML Efficiency, ARC-Easy and BLiMP are accuracies in %, Wiki byte-PPL is raw. Only evaluations with a valid aggregate (all four tasks) count. The Tiny-ML suite is owner-only ([private Tiny-ML comparisons](private-tiny-ml.md)), so its aggregate scores appear here only when the deployment sets `FABRYKA_MODEL_BOARD_PUBLISH_TINY_ML=true`; then eff, ARC-Easy, BLiMP and Wiki byte-PPL are published, never ACI or per-item results. Otherwise track rows carry no EN values.
3. PL comes from any other evaluation that ran MultiBLiMP-pl (`multiblimp_polish`, for example the `polish` or `leaderboard_pl` suites): accuracy × 100. Track rows carry only MultiBLiMP-pl; ARC-Easy-PL, byte-PPL PL and eff-PL stay `null`.
4. The latest qualifying evaluation (by end time) fixes the row's checkpoint: the last measured checkpoint, never the best one. The other category is filled only from its own latest qualifying evaluation of the same `checkpoint_sha256`, so one row never mixes checkpoints.
5. `n_params` and the eff size bonus use only `parameters_counted`: the unique parameters (a tied embedding/head counts once) counted from the loaded checkpoint by the evaluation worker or an authenticated benchmark runner (admin-issued token, same worker code). Owner-declared `parameters` (run config) are not used; evaluations recorded before this count existed appear after re-evaluation. `step` and `tokens_seen` come from the evaluation's checkpoint provenance (`checkpoint_step`, `training_tokens`). `harness` names the evaluation protocol(s); `scale_rev` is `tiny_ml <reference revision> (1000–150M)` when EN is present.
6. A run that already has an owner-marked row, or whose checkpoint sha is already on the board through an owner-marked row, gets no track row. Among track rows that share a checkpoint sha the earliest finished run is kept.

Owners cannot claim `track` in `leaderboard/result`. The track's Tiny-ML eff and the Glint eff are different formulas on different scales; compare eff only between rows with the same `scale_rev`. `visibility/public_note` is shown with a track row only while `visibility/public_board_metrics` is `true`. Track-measured rows carry no `author`; the Author column shows the run owner's account name.

## `leaderboard/result`

Set it as one object; the server validates it on every write path (attribute endpoint, parent path such as `leaderboard`, and `run.attribute` events) and answers 422 on any violation. Its fields cannot be assigned one by one. Setting it to `null` withdraws the row.

| Field | Rule |
|---|---|
| `step` | required integer ≥ 0; the metric step of the result |
| `checkpoint_sha256` | required, 64 lowercase hex characters |
| `n_params` | required integer > 0; drives the size filter (≤16M · ≤32M · ≤64M · ≤150M · ≤350M · >350M, disjoint, upper bounds inclusive, decimal M). The eff size bonus stops at 150M parameters (Glint formula), so larger models get no bonus. |
| `label` | required, exactly `"final checkpoint (result)"` |
| `kind` | `"track"` (default, trained on this run) or `"external"` (trained elsewhere, measured and logged here) |
| `trust` | `"verified"`, `"measured"` or `"reported"`; see below |
| `tokens_seen` | optional integer ≥ 0 |
| `harness_sha` | optional, 7–64 lowercase hex characters |
| `harness` | optional plain text ≤ 80 characters |
| `scale_rev` | optional plain text ≤ 40 characters: revision of the Glint min/max ranges used to compute eff, e.g. `"Glint 2c5ea968 (2026-09-28)"` |
| `author` | plain text ≤ 80 characters; required for external models, optional for track runs. The board's Author column shows it, or the run owner's account name when a track run names no author. |
| `model_name` | external only, required plain text ≤ 80 characters |
| `hf_repo` | external only, required `org/name` (`[A-Za-z0-9._-]`) |
| `revision` | external only, required 7–40 lowercase hex characters (the Hugging Face commit) |

Plain text rejects `<`, `>` and control or formatting characters; the page renders every value as text. Unknown keys, including any URL field, are rejected. External rows link only to `https://huggingface.co/{hf_repo}/tree/{revision}`, built by the server.

### Trust levels

`trust` in the attribute is the owner's claim. The badge on the page is granted by the server from two deployment settings (comma-separated): `FABRYKA_MODEL_BOARD_TRUSTED_OWNERS` (account names; default `hf_maggio33`, the Fabryka account that logs the board rows it measured itself) and `FABRYKA_MODEL_BOARD_HARNESS_SHAS` (evaluation-harness revisions, 7+ hex characters; prefixes match). Account names match exactly, including case; setting `FABRYKA_MODEL_BOARD_TRUSTED_OWNERS=` (empty) trusts nobody. Rows measured by the track always carry `track` (badge "measured by track"), which no owner can claim.

- `verified` (badge "verified ✓"): a trusted owner's track run whose `harness_sha` is a listed harness revision. External models are never verified.
- `measured` (badge "measured by Fabryka"): any other row from a trusted owner that did not declare itself `reported`. Default claim for track runs; external rows must claim `measured` or `reported` explicitly.
- `reported` (badge "self-reported (different protocol)"): every row from an account outside the trusted list, whatever it claims, and rows declared `reported` (which must name their protocol in `harness`). The page can hide these rows.

Ranking ignores the badge:

- EN ranks by eff.
- PL ranks by eff-PL. Rows without eff-PL are listed below all ranked rows, sorted by MultiBLiMP-pl, with no rank; their eff-PL cell shows "—" (nothing is imputed).
- PL+EN ranks by `combined` = (eff + eff-PL) / 2, computed by the server only for rows ranked in both EN and PL that have both effs; only such rows get the `plen` category. It favours bilingual models.

Missing values show "—". On rows of external models with the badge "measured by Fabryka" (`trust: measured`), PL values and PL+EN are marked "†": measured by us with our protocol; may differ from the authors' own evaluation. Self-reported rows never carry it.

### `scale_rev`

eff maps each axis onto 0–100 with the Glint min/max ranges pinned at a given revision. A different revision changes eff for the same model, so the revision is shown with each row; compare eff only between rows with the same `scale_rev`.

## Example: model trained on a Track run

```python
from fabryka import run

run.init(project="glint", name="glint-16m-baseline", config={"parameters": 16_000_000})
# … training …
step = 80_000
run.log({"board/eff": 41.2, "board/arc_easy": 38.1, "board/blimp": 70.4,
         "board/wiki_byte_ppl": 3.12, "board_pl/multiblimp": 61.5, "board_pl/arc_easy": 33.0,
         "board_pl/byte_ppl": 3.4512, "board_pl/eff": 38.7}, step=step)
run["visibility/public_board_metrics"] = True
run["leaderboard/result"] = {
    "step": step,
    "checkpoint_sha256": "<sha256 of the checkpoint file>",
    "n_params": 16_000_000,
    "tokens_seen": 320_000_000,
    "harness_sha": "2c5ea968",
    "scale_rev": "Glint 2c5ea968 (2026-09-28)",
    "kind": "track",
    "trust": "verified",
    "label": "final checkpoint (result)",
}
run.finish()
```

## Example: external model measured here

Create a run that only evaluates the downloaded checkpoint, log its board series at one step (for example 0) and describe the model. This evaluation run is only a container for the measurement: it is an SDK run, so it never appears in Training results (that page lists Studio training runs only). Name it after the model, for example `external: Tiny Llama 20M (Jane Doe)`, log no training curve, and set `visibility/public_note` to "External model, measured by Fabryka; not trained here." The board row shows the model name, its authors and the pinned Hugging Face revision, not the container run.

```python
run["leaderboard/result"] = {
    "step": 0,
    "checkpoint_sha256": "<sha256 of the evaluated weights file>",
    "n_params": 20_000_000,
    "kind": "external",
    "trust": "measured",
    "model_name": "Tiny Llama 20M",
    "author": "Jane Doe",
    "hf_repo": "jane/tiny-llama-20m",
    "revision": "0123abcd4567",
    "harness_sha": "2c5ea968",
    "scale_rev": "Glint 2c5ea968 (2026-09-28)",
    "label": "final checkpoint (result)",
}
```

For numbers copied from the authors, use `"trust": "reported"` and name their protocol in `harness`.

Validation: `pytest tests/test_model_board.py`, `node --experimental-strip-types --test tests/model-board.test.mjs`, `npm --prefix frontend run build`.

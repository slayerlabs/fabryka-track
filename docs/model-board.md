# Model leaderboard

`/models` ranks one final checkpoint per model, separately for English and Polish. It reads the public, anonymous endpoint `GET /api/leaderboard/models`; the page is `frontend/src/pages/ModelBoard.tsx` with pure helpers in `frontend/src/pages/model-board-data.ts` (tested by `tests/model-board.test.mjs`). The separate `/leaderboard` (Training results) and `/benchmark-results` pages are unchanged.

## Putting a run on the board

A run appears when all of these hold:

1. The run is `finished` and public (the same `is_public` gate as the anonymous run view).
2. Its owner opted in to public board metrics: attribute `visibility/public_board_metrics` is literally `true`. The same flag already publishes the run's `board/*` series in the read-only run view; on this board it also publishes the `board_pl/*` values at the result step. Setting it to anything else removes the row.
3. It logged the board series at the result step:
   - EN: `board/eff`, `board/arc_easy`, `board/blimp` (Glint 0–100 scale) and `board/wiki_byte_ppl` (raw byte perplexity). The row is in the EN category only when all four exist at that step.
   - PL: `board_pl/multiblimp` (MultiBLiMP-pl accuracy in %, random = 50 %). Optional `board_pl/eff` is shown next to it but is never ranked, because the eff-PL formula is not frozen yet.
4. It carries a valid `leaderboard/result` attribute (below). Studio runs cannot be marked because their records are managed by the training worker; log results from an SDK run.

Values are read at exactly `result.step`, never the latest step. A missing value is `null`, never 0; a row with neither category complete is omitted. When several runs report the same `checkpoint_sha256`, a trusted owner's run wins over any other, then the earliest finished run, so a later copy of a checkpoint sha cannot replace the original row. An opted-in `visibility/public_note` is shown with the row. No other attribute, config, note or series leaves the server.

## `leaderboard/result`

Set it as one object; the server validates it on every write path (attribute endpoint, parent path such as `leaderboard`, and `run.attribute` events) and answers 422 on any violation. Its fields cannot be assigned one by one. Setting it to `null` withdraws the row.

| Field | Rule |
|---|---|
| `step` | required integer ≥ 0; the metric step of the result |
| `checkpoint_sha256` | required, 64 lowercase hex characters |
| `n_params` | required integer > 0; drives the size filter (≤16M · ≤32M · ≤64M · ≤150M · >150M, disjoint, upper bounds inclusive, decimal M) |
| `label` | required, exactly `"final checkpoint (result)"` |
| `kind` | `"track"` (default, trained on this run) or `"external"` (trained elsewhere, measured and logged here) |
| `trust` | `"verified"`, `"measured"` or `"reported"`; see below |
| `tokens_seen` | optional integer ≥ 0 |
| `harness_sha` | optional, 7–64 lowercase hex characters |
| `harness` | optional plain text ≤ 80 characters |
| `scale_rev` | optional plain text ≤ 40 characters: revision of the Glint min/max ranges used to compute eff, e.g. `"Glint 2c5ea968 (2026-09-28)"` |
| `model_name`, `author` | external only, required plain text ≤ 80 characters |
| `hf_repo` | external only, required `org/name` (`[A-Za-z0-9._-]`) |
| `revision` | external only, required 7–40 lowercase hex characters (the Hugging Face commit) |

Plain text rejects `<`, `>` and control or formatting characters; the page renders every value as text. Unknown keys, including any URL field, are rejected. External rows link only to `https://huggingface.co/{hf_repo}/tree/{revision}`, built by the server.

### Trust levels

`trust` in the attribute is the owner's claim. The badge on the page is granted by the server from two deployment settings (comma-separated): `FABRYKA_MODEL_BOARD_TRUSTED_OWNERS` (account names) and `FABRYKA_MODEL_BOARD_HARNESS_SHAS` (evaluation-harness revisions, 7+ hex characters; prefixes match).

- `verified` (badge "verified ✓"): a trusted owner's track run whose `harness_sha` is a listed harness revision. External models are never verified.
- `measured` (badge "measured by Fabryka"): any other row from a trusted owner that did not declare itself `reported`. Default claim for track runs; external rows must claim `measured` or `reported` explicitly.
- `reported` (badge "self-reported (different protocol)"): every row from an account outside the trusted list, whatever it claims, and rows declared `reported` (which must name their protocol in `harness`). The page can hide these rows.

Ranking ignores the badge: EN ranks by eff, PL by MultiBLiMP-pl. EN and PL are never combined because the two scores live on different scales.

### `scale_rev`

eff maps each axis onto 0–100 with the Glint min/max ranges pinned at a given revision. A different revision changes eff for the same model, so the revision is shown with each row; compare eff only between rows with the same `scale_rev`.

## Example: model trained on a Track run

```python
from fabryka import run

run.init(project="glint", name="glint-16m-baseline", config={"parameters": 16_000_000})
# … training …
step = 80_000
run.log({"board/eff": 41.2, "board/arc_easy": 38.1, "board/blimp": 70.4,
         "board/wiki_byte_ppl": 3.12, "board_pl/multiblimp": 61.5}, step=step)
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

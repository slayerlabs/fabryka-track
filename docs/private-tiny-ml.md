# Private Tiny-ML comparisons

The `/benchmarks` page includes an owner-only Tiny-ML board and evaluation suite.
Choose a finished native Track checkpoint, select **Tiny-ML**, and run **Full**.
Smoke mode checks execution with 10 documents/examples per subtask, but never
enters the private ranking. The suite is private even if its parent run is public.
It is excluded from anonymous run history and every public benchmark report.

## Reproducible protocol

`tiny-ml-en-v1-byte-sliding` uses lm-eval 0.4.13 definitions, zero-shot prompts,
seed 42, the saved checkpoint hash, and fixed dataset revisions in
`tiny_ml_suite.py`. BLiMP macro-averages all 67 subtasks, ARC-Easy uses raw
`acc,none`, and WikiText-2 uses the harness document-level test split and
its detokenizer. Wiki byte perplexity is exp(total negative log likelihood /
total UTF-8 bytes), distinct from word or model-token perplexity. The native
adapter scores every byte with its maximum available sliding context and a
space-byte prefix at document start. ARC acc_norm and Wiki bits per byte remain
available separately. No item text or answers are copied into reports.

The board uses the latest complete full evaluation per run/checkpoint; metrics
are never selected independently from different checkpoints. Failed, incomplete,
non-finite and smoke results cannot receive a ranked aggregate.

## Glint reference

The reference is the public Space revision
`3fce6037267585847b2a1d9f5556c8fd82f7c4ca`:
https://huggingface.co/spaces/Glint-Research/Tiny-ML-Leaderboard/tree/3fce6037267585847b2a1d9f5556c8fd82f7c4ca

Overall is the average of percentage BLiMP accuracy, percentage raw ARC-Easy
accuracy and normalized Wiki byte perplexity. Wiki normalization is
`100 * clip(1 - ln(min(ppl, 500)/1.86)/ln(500/1.86), 0, 1)`.
Efficiency multiplies Overall by
`1 + 0.5 * clip(ln(150000000/parameters)/ln(150000000/1000), 0, 1)`.
These bounds are frozen from the reference cohort so your earlier scores remain
stable as your board grows. Glint recalculates bounds from its live cohort;
Track does not. Efficiency measures a size adjustment, not hardware cost.

The Space contains reported model scores and scoring formulas, not a single
shared evaluator. Its rows do not establish uniform prompts, checkpoint choice,
context handling or dataset revisions. Track therefore implements the same
three tasks and frozen scoring formula, not verified numerical parity with
external self-reports. Compare your experiments under this single protocol.

## Worker deployment

Deploy the web/API release and update the dedicated benchmark worker source.
Updated workers advertise this protocol when claiming jobs; older workers skip
these jobs. Keep existing GPU admission, time and memory limits. The existing
worker will wait when the GPU is occupied; adding the suite does not provision
paid compute or interrupt training. Native byte checkpoints are supported by
this route; arbitrary Hugging Face architectures are not added by this change.

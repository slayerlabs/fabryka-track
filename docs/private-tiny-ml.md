# Private Tiny-ML comparisons

The `/benchmarks` page includes an owner-only Tiny-ML board and evaluation suite.
New training requests and Studio runs default to automatic **Full Tiny-ML**:
**WikiText-2 BYTE_PPL ↓, BLiMP ↑, ARC-Easy ↑, ACI ↑**. Explicit opt-outs and
alternative suites remain supported. Unversioned PIQA defaults in saved Studio
drafts and fork recipes migrate once; new explicit choices are versioned.
You can also choose a finished checkpoint and enqueue **Tiny-ML / Full** manually.
Smoke mode checks execution with 10 documents/examples per subtask, but never
enters the private ranking. The suite stays private even when its parent run is
public, including automatic leaderboard summaries. Automatic reconciliation
checks the selected suite, protocol and final checkpoint when recovering a
missing or incompatible link; an old PIQA link does not satisfy Tiny-ML.

## Reproducible protocol

`tiny-ml-en-v2-byte-sliding-aci` uses lm-eval 0.4.13 definitions, zero-shot prompts,
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
non-finite, smoke and older-protocol results cannot receive a current ranked
aggregate. All four metrics must be valid. Older three-task evaluations remain
in history; they are not silently relabeled or mixed into new evaluations.

## Attention Clarity Index

ACI is **Attention Clarity Index**, not ARC normalized accuracy, Overall or
Efficiency. The reference implementation and dataset are pinned together:
https://huggingface.co/datasets/AxiomicLabs/ACI-Bench/tree/eaf77566763d6a924692d011499908cf05201941

An evaluation-only eager forward uses the checkpoint's unchanged native weights
and exposes differentiable attention. Saliency is the sum over layers and heads
of `abs(attention * gradient)` for mean causal next-byte cross-entropy. Unicode
character spans map to their overlapping UTF-8 bytes. Priority compares mean
saliency of relevant and distractor tokens; Linkage compares annotated segment
pairs with their distractor controls. ACI is the mean of mean Priority and mean
Linkage, on a 0–100 scale. The reference's neutral Linkage value of 50 applies
only when no valid linked pairs survive; zero valid items fails the task.

Full mode attempts all 5,000 checksum-verified test items. Smoke samples 10 with
seed 42. The reference's default limit is 256 tokens: for native byte models this
means the first `min(256, checkpoint context length)` bytes, not 256 subword
tokens. Reports retain valid/skipped counts, reasons, truncation, a sample digest,
component scores, dataset revision/checksum and runtime provenance, never item
text or answers. Context-limited coverage must be considered when comparing
models; unavailable ACI is never replaced with an unrelated score.

## Methodology reference

Fabryka maintains its own pinned Tiny-ML protocol and leaderboard. The board is
inspired by public small-model evaluation work, but its scores, ownership and
evaluation history are maintained by Track and do not depend on an external
leaderboard page.

Secondary Overall is the average of percentage BLiMP accuracy, percentage raw ARC-Easy
accuracy and normalized Wiki byte perplexity. Wiki normalization is
`100 * clip(1 - ln(min(ppl, 500)/1.86)/ln(500/1.86), 0, 1)`.
Efficiency multiplies Overall by
`1 + 0.5 * clip(ln(150000000/parameters)/ln(150000000/1000), 0, 1)`.
These bounds are frozen for the Fabryka board so scores remain stable as the
cohort grows. Efficiency measures a size adjustment, not hardware cost.
ACI is measured independently and is not included in either secondary formula.

The Space contains reported model scores and scoring formulas, not a single
shared evaluator. Its rows do not establish uniform prompts, checkpoint choice,
context handling or dataset revisions. Track therefore implements the same
four named metrics and pinned protocols, not verified numerical parity with
external self-reports. Tokenizers, context limits and reported ACI sampling can
differ. Compare your experiments under this single recorded protocol.

## Worker deployment

Deploy the web/API release and update the dedicated benchmark worker source.
Updated workers advertise this protocol when claiming jobs; older workers skip
these jobs. Keep existing GPU admission, time and memory limits. The existing
worker will wait when the GPU is occupied; adding the suite does not provision
paid compute or interrupt training. Native byte checkpoints are supported by
this route; arbitrary Hugging Face architectures are not added by this change.

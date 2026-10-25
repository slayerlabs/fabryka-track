# Leaderboard: datasets, runners and scoring

**Start here for the datasets and benchmarks behind [track.fabryka.ai/models](https://track.fabryka.ai/models).**
This is the shared entrypoint for the Fabryka AI benchmark/autoevaluation team.
It maps the existing instruments; it does not launch evaluations or change rankings.
For publishing a measured checkpoint, use the [model-board API/SDK contract](model-board.md).

This handover shares existing benchmark data, code, protocols and control values.
The benchmark group owns running model evaluations, extending the instruments and
building its automatic evaluation workflow. Our models' new scores are not part
of this handover.

## Start here — benchmark team

Elwenor, author of Koliber, leads the benchmark group. Project contact:
Arkadiusz Słota, Fabryka AI.

1. **Find an input or runner:** [column-to-dataset/code map](#all-columns-data-and-code).
2. **Choose the existing execution path:** [native Track worker or owner/HF measurement](#which-evaluation-are-you-reproducing).
3. **Check a result before comparing it:** [references and calibration](#calibration-keep-instruments-separate).
4. **Submit a checkpoint and measured values:** [SDK contract](model-board.md#putting-a-run-on-the-board).
5. **Change a benchmark:** retain the old data/protocol identity and version the change; do not silently replace a published input.

## Which evaluation are you reproducing?

| Path | Runnable implementation | Checkpoints and publication |
|---|---|---|
| Track's native automatic evaluations | [benchmark worker](../src/fabryka_track/benchmark_worker.py), [native byte adapter](../src/fabryka_track/benchmark_model.py), [Tiny-ML suite](../src/fabryka_track/tiny_ml_suite.py) | Saved native byte-model checkpoints; `tiny-ml-en-v2-byte-sliding-aci`, `lm-eval==0.4.13`. Full results, not smoke results, can qualify for ranking. [Worker setup and permissions](run-workspace.md#persistent-gpu-benchmark-workers). |
| Owner-marked SDK rows, including imported HF models | The row declares its `harness`, `harness_sha`, `scale_rev`, dataset provenance and exact checkpoint. The published standalone ARC-PL and W scorers are linked in the column map below. | The owner logs measured `board/*` and `board_pl/*` series at `leaderboard/result.step`. These are not automatically evidence that Track's native worker evaluated the model. |

**Same metric name or normalization constants do not establish numerical parity.**
The historical Glint-parity owner protocol uses the model's tokenizer and 256-token
reset windows; the native Track adapter uses UTF-8 bytes and sliding context.
Native Track jobs do not provide a generic arbitrary-HF-model adapter.
A published model card is a reference for its declared instrument, not a golden
output for a different evaluator.

## All columns: data and code

Links below pin upstream inputs where the implementation has a fixed pin. A Git
revision identifies repository content; it is not a claim that the worker also
checks a SHA-256 for every downloaded file. Where a revision is resolved per job,
retain that job's `provenance.dataset_revisions` rather than silently using a new `main`.

| Column / benchmark | Data to use | Scoring implementation and reporting |
|---|---|---|
| EN BLiMP | [nyu-mll/blimp @877fba08](https://huggingface.co/datasets/nyu-mll/blimp/tree/877fba0801ffb7cbd8c39c1ff314a46f053f6036), all 67 configurations, `train` | Native [worker](../src/fabryka_track/benchmark_worker.py) and lm-eval 0.4.13 task definitions; macro-average the 67 accuracies. Public owner series: `board/blimp`, in percent. The full historical owner evaluation has 67,000 pairs, not the older erroneous 73,000-pair variant. |
| EN ARC-Easy | [allenai/ai2_arc @210d026f](https://huggingface.co/datasets/allenai/ai2_arc/tree/210d026faf9955653af8916fad021475a3f00453), `ARC-Easy`, `test`, 2,376 questions | Native [worker](../src/fabryka_track/benchmark_worker.py), zero-shot lm-eval task; use raw accuracy, not `acc_norm`. Owner series: `board/arc_easy`, in percent. Historical owner Glint-parity uses the bare `question + " " + answer` template instead of the harness template. |
| EN WikiText-2 BYTE-PPL | Native: [EleutherAI/wikitext_document_level @64723477](https://huggingface.co/datasets/EleutherAI/wikitext_document_level/tree/647234772b9554e208af6c826f23b99e3cac88c8), `wikitext-2-raw-v1`, `test`. Historical owner instrument: [Salesforce/wikitext @b08601e0](https://huggingface.co/datasets/Salesforce/wikitext/tree/b08601e04326c79dfdd32d625aee71d232d685c3), same named configuration/split. | Native [suite](../src/fabryka_track/tiny_ml_suite.py) and [worker](../src/fabryka_track/benchmark_worker.py). The separate [WikiText suite](../src/fabryka_track/wikitext_suite.py) records its document preprocessing and rolling policy explicitly. Owner series: `board/wiki_byte_ppl`, raw byte perplexity, lower is better. Document-level rolling and a space-joined 256-token reset corpus are different protocols. |
| PL G / MultiBLiMP-pl | [jumelet/multiblimp](https://huggingface.co/datasets/jumelet/multiblimp), configuration `pol`, split `train`. Native jobs record their resolved immutable revision. Historical 3,272-pair input: [pol/data.tsv @de923efa](https://huggingface.co/datasets/jumelet/multiblimp/blob/de923efa8d2483d6b13364ee68e65308e990a991/pol/data.tsv); content identity below. | Native [worker](../src/fabryka_track/benchmark_worker.py), task `multiblimp_polish`. Owner series: `board_pl/multiblimp`, in percent. A 50% random-choice baseline and the roughly 60% shorter-sentence baseline are different diagnostics; neither is subtracted from the G value in eff-PL. Do not silently substitute historical selection/clean subsets for the full set. |
| PL K / ARC-Easy-PL | Main: [Eurolingua/arcx @f2e35fbe](https://huggingface.co/datasets/Eurolingua/arcx/tree/f2e35fbebdb572a9653eda706b00083b0892ed43), `arc_easy_PL_test.jsonl`. Control: [ddudek/ai2_arc_translated_pol @e61110df](https://huggingface.co/datasets/ddudek/ai2_arc_translated_pol/tree/e61110df4097ca5f5284a62e60d01d8f80d15069), `ARC-Easy/test-00000-of-00001.parquet`. Each has 2,376 questions. | Public [Probierz scorer and instructions @47cee070](https://github.com/slayerlabs/Probierz/tree/47cee070f47fab4b52f144daf0531419d7dd0072/benchmarks/zewnetrzne/arc-easy-pl). Raw continuation likelihood, no answer-length normalization. Owner series: `board_pl/arc_easy`, in percent, is **EU20**. Report ddudek separately, not as an interchangeable replacement. |
| PL W / BYTE-PPL PL | **[SlayerLab/fabryka-track-w-pl @b25c13a4](https://huggingface.co/datasets/SlayerLab/fabryka-track-w-pl/tree/b25c13a445ba8639759264654f37295ebe08871c)**, `w_final.jsonl`, 463 articles | **[Standalone W scorer, command and reference output @2af7b868](https://github.com/slayerlabs/Probierz/tree/2af7b8688452964a10e1cc2251a3787e32ce45fa/benchmarks/zewnetrzne/byte-ppl-w-pl)**; [frozen dataset card](https://huggingface.co/datasets/SlayerLab/fabryka-track-w-pl/blob/b25c13a445ba8639759264654f37295ebe08871c/README.md). Owner series: `board_pl/byte_ppl`, raw byte perplexity. The exact byte and window accounting is specified below. |
| ACI: native Tiny-ML eligibility, not a public model-board column | [AxiomicLabs/ACI-Bench @eaf77566](https://huggingface.co/datasets/AxiomicLabs/ACI-Bench/tree/eaf77566763d6a924692d011499908cf05201941), `test/test-00000-of-00001.parquet`, 5,000 test items | [Pinned native implementation](../src/fabryka_track/aci_suite.py), [protocol and coverage](private-tiny-ml.md#attention-clarity-index). Gradient-times-attention Attention Clarity Index, not ARC normalized accuracy. Native Tiny-ML requires a valid ACI result; ACI is not part of its three-axis Overall/eff formula and is not published by `/api/leaderboard/models`. |

Other Studio diagnostics and the separate Sandbox leaderboard are not extra
columns of `/models`. Their definitions remain in the [English diagnostic ladder](fast-ladder.md)
and [workspace guide](run-workspace.md).

### File identities checked by the Polish instruments

| Input | SHA-256 |
|---|---|
| Historical full MultiBLiMP-pl `pol/data.tsv` | `c3dd7cdafe689f5d5c6bd86162f550b2d0399f36dbe4c568cb52ae1303306cda` |
| EU20 `arc_easy_PL_test.jsonl` | `c6732eeba3b2f3cfda95d65d42fb9d4e0f10edc1b9e6c8582d46c069b6706186` |
| ddudek `ARC-Easy/test-00000-of-00001.parquet` | `f4f30341da404f5d5134ab38e25a55cc9267fdaccb42584607e2830d21bdb934` |
| W `w_final.jsonl` | `234e7ec21bf2236bc74425591531f2c4772f8c49ff853d57f6fa16f33ee90ac7` |
| ACI test Parquet | `76d892d2c3295af87f4bbfef50344901b5f3526f4efee7dcc75b9c1aab5e04d8` |

The MultiBLiMP TSV fingerprint identifies the historical full input; it does not
claim that a native job consumes that TSV serialization or uses a single globally
fixed revision. Native revisions and sample digests are saved with the job.

## Polish W: exact public input

The dataset was **published as an evaluation set on 2026-10-25**. Previously its
selection was unpublished and only scores were shared. The source articles are
Polish Wikipedia; keep the dataset card's attribution and CC BY-SA 4.0 terms.
Publication does not change old scores or make any model's training data clean.

Do not confuse these byte counts:

| Object | UTF-8 bytes |
|---|---:|
| Downloaded `w_final.jsonl`, including JSON serialization | 1,454,970 |
| Sum of the 463 article `text` fields | 1,430,217 |
| Evaluated text: `"\n\n".join(texts).strip()` | **1,431,141** |

The joined evaluation text has SHA-256
`6821ff4ab07256ec485535f1def727ad3797b3b8c02b941276d8e56546fc8e0e`.
Check the downloaded **file** against its file checksum before parsing it; use the
joined **text** bytes, not JSONL bytes, for the W denominator. Do not sort articles,
normalize whitespace, replace the dataset with another Wikipedia sample, or
change the context policy while retaining the same benchmark identity.

The frozen W instrument uses these exact rules:

1. Let `V` be the supplied tokenizer's vocabulary size. Keep the IDs returned by
   `encode(text)` that are `< V`. Keep the tokenizer's configured post-processor:
   it may add BOS/EOS; the scorer does not manually add or remove them. Crop model
   logits to `[..., :V]` before computing loss. Fewer than two retained IDs is an
   error, not a valid perplexity.
2. For starts `i = 0, 256, 512, ...`, take `chunk = ids[i:i+257]`.
   The input is `chunk[:-1]`, and the targets are `chunk[1:]`. Reset context for
   each chunk. The last chunk may be shorter; do not pad it.
3. Adjacent chunks share one boundary token: the last target of the preceding
   chunk is the first input of the next. **Targets are never repeated. Only the
   first token of the entire text is not a target**, not one token per window.
4. `token_ppl = exp(total_target_cross_entropy / num_targets)`.
   For byte conversion use **all** token IDs:
   `byte_ppl = token_ppl ** (len(ids) / num_text_bytes)`, not `num_targets` in
   that exponent.

For the pinned GoLLeM v6 calibration model, the counters are:

| Counter | Count |
|---|---:|
| All token IDs, used in the byte-conversion exponent | 350,087 |
| Predicted targets, used in the mean cross-entropy | 350,086 |

**BPB = log2(byte_ppl)**; BPB and byte-PPL are not the same value. Byte normalization
does not remove differences in tokenization, prefix handling or available context
between evaluators.

W was decontaminated against the GoLLeM v6 training pool, **not every model's
training corpus**. Disclose known overlap per checkpoint and the scope of any
scan. Overlap with the union of future training streams is not proof that an
earlier checkpoint consumed every matching window. A low perplexity by itself
is not evidence of generalization or proof of memorization.

## Calibration: keep instruments separate

A public historical owner-protocol reference is
[GoLLeM v6 250M @77d75a2b](https://huggingface.co/SlayerLab/GoLLeM-v6-250M/blob/77d75a2b48eaab7aec59816f9849cee75a7bdfc1/README.md),
final step 760,000. These are **published historical measurements**, not new native
Track-worker measurements:

| Axis | Declared owner-protocol reference |
|---|---:|
| EN ARC-Easy, % | 50.21 |
| EN BLiMP, % | 77.61 |
| EN WikiText-2 byte-PPL | 2.2884 |
| PL G, %, full 3,272 pairs | 98.14 |
| PL K, %, EU20 | 42.09 |
| PL W, byte-PPL | **1.9578** |

For a W port, reproduce that W reference before reporting new numbers; retain the
model revision, reviewed model code, device/dtype, input checksum and runner
revision with the result. The W port check requires absolute error **≤ 0.001
byte-PPL** from the reference above; a larger difference means stop and investigate.
Do not widen the tolerance or silently change the text after seeing the result.

The pinned GoLLeM v6 reference uses the model card's custom PyTorch
`load_gollem_v6` loader. Its configuration is not a Transformers AutoModel
registration; `--trust-remote-code` alone is not a substitute for that loader.

The standalone ARC-PL runner has a separate, public
[GoLLeM-45M-PL calibration JSON](https://github.com/slayerlabs/Probierz/blob/47cee070f47fab4b52f144daf0531419d7dd0072/benchmarks/zewnetrzne/arc-easy-pl/wyniki-gollem-45m-pl.json)
for model revision `1b1791fcd67727920db39bcf1e7022ce7a209e12`:

| Translation | CPU float32 accuracy, % |
|---|---:|
| EU20 | 31.61 |
| ddudek | 31.73 |

That runner's README explains the CPU/GPU tie case. It is not a universal bound
on numerical differences for arbitrary models or hardware.

For the **native** suite, the pinned code and
[numerical/eligibility regression cases](../tests/test_tiny_ml.py) define the
instrument. Historical owner-card values are not native calibration targets;
compare checkpoints under the same recorded evaluator and dataset revisions.

## From a measured result to the public board

1. Preserve checkpoint SHA, exact result step, model/runner revisions, dataset
   identities and the evaluation scope. Do not combine axes from different
   checkpoints or replace final checkpoints with independently selected best axes.
2. Owner-marked SDK runs log `board/blimp`, `board/arc_easy`, `board/wiki_byte_ppl`
   and `board/eff` for EN; `board_pl/multiblimp`, `board_pl/arc_easy`,
   `board_pl/byte_ppl` and `board_pl/eff` for PL. Percentages and raw perplexities
   retain the units in the map above. A missing result is `null`, not zero.
3. Use the [existing SDK example and `leaderboard/result` schema](model-board.md#leaderboardresult),
   including a finished public run and `visibility/public_board_metrics=true`.
   The server reads exactly `result.step`. It copies owner-supplied eff-PL;
   logging W alone does **not** calculate or log eff-PL.
4. WS is the frozen 0–100 score derived from byte-PPL;
   eff-PL = `(G + K + WS) / 3 × size_multiplier`. The shared bounds and multiplier
   are defined in [Tiny-ML scoring](../src/fabryka_track/tiny_ml_suite.py).
   PL+EN = `(eff_EN + eff_PL) / 2` is computed by the server only when both
   categories have finite eff values for the same row.
5. Native automatic Tiny-ML evaluations have their own
   [worker and publication rules](private-tiny-ml.md). The native PL path currently
   publishes MultiBLiMP only; it does not automatically populate owner-protocol
   K, W or eff-PL. Publishing this catalog or an HF dataset is not itself an
   implementation of those additional autoevaluations.

Do not silently relabel old instruments as new ones. Keep the historical
`harness`/`scale_rev` and training-overlap disclosures with each result. Future
changes to data, templates, windows or eligibility need a new recorded protocol,
not a replacement under the old name.

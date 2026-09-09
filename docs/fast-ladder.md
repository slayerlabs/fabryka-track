# Fast English diagnostic ladder v1

A separate evaluation protocol (`fast-en-v1`), never merged with TinyScore. Smoke mode checks execution with 10 items per component and 8,192 held-out bytes. Full mode uses the fixed diagnostic pack, not entire source datasets.

| Component | Full diagnostic sample | Measurements | Weight |
|---|---:|---|---:|
| Held-out LM | up to 1M UTF-8 bytes; at least 500k | NLL in nats/byte, BPB | 40% |
| BLiMP-fast | 127 per phenomenon, 8,509 pairs | logprob margin, accuracy | 35% |
| BLiMP Supplement | 5,218 available pairs | logprob margin, accuracy | 10% |
| EWoK-fast | 1,500 items, both contexts | preference margin, accuracy | 5% |
| ARC-Easy | 1,000 test-split items | correct-choice probability, margin, accuracy | 10% |

The current model tokenizer is UTF-8 bytes. Counts are not subword-token counts. The LM dataset is WikiText-103 raw validation; it is an external validation split, not a guarantee of no overlap with arbitrary user training data. Do not train on this diagnostic pack or use it as a final unseen test.

BLiMP and Supplement use BabyLM's 2024 vocabulary-filtered datasets from the official [evaluation pipeline](https://github.com/babylm/evaluation-pipeline-2024) and its linked [OSF archive](https://osf.io/ad7qg/). EWoK uses the authors' [ewok-core-1.0](https://huggingface.co/datasets/ewok-core/ewok-core-1.0), which requires Hugging Face access approval. The current deployment exposes four ready components; EWoK and the combined FastScore are unavailable until access is configured. Its weight is not redistributed.

`build_fast_ladder.py` pins HF revisions, deterministically selects samples with seed 42, and writes a checksummed local pack. Every evaluation verifies component checksums and records the sample digest and source metadata. Regenerating a different pack requires a new protocol version to prevent reuse across sample changes.

## Internal normalization

Raw metrics are primary. The optional experimental composite uses fixed transformations, not data-fitted rankings:

- LM: `1 - BPB / 8`, relative to uniform byte prediction.
- Pair diagnostics: mean `tanh(margin_nats / (max(candidate_bytes) * ln(2)))`.
- ARC-Easy: mean `(P(correct) - 1/K) / (1 - 1/K)`, using summed conditional log-likelihood and softmax over choices.
- Apply the requested weights only when all five components have measurements. Negative values remain negative. No score is emitted for missing components.

This is an internal diagnostic score, not an official BabyLM score, validated calibration, or a substitute for raw NLL/margins. Pair ties count as incorrect. LM uses independent context-length blocks with the preceding byte as prefix; each byte is scored once. Comparisons should match protocol, sample digest, scoring mode and context policy.

## Deployment verification, 2026-09-09

The four-component smoke evaluation `417fa4f7-a0b6-411f-b1bd-a90feca7775f` on the saved Basic Test checkpoint finished without errors. It measured 5.7020 BPB on the 8,192-byte smoke slice and produced pair/MC metrics for BLiMP-fast, Supplement and ARC-Easy. These are execution checks, not full-suite quality claims. EWoK is excluded from runnable tasks pending source access; its missing result keeps FastScore null. Both runner checkouts have the same pack and implementation.

Backend benchmark/runner tests and two fast-ladder calculation/integrity tests passed. Ten JavaScript tests passed against the published HTML, including the missing-component display. Interactive browser testing was unavailable.

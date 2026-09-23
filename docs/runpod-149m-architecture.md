# ARC-E 149M RunPod architecture

This is the execution topology for the `Deep576-37L` model. The model has
149,863,232 trainable parameters, a 32,768-token vocabulary and a 2,048-token
context. Q/K RoPE, grouped-query attention (9 query / 3 KV heads), QK-Norm,
SwiGLU and tied embeddings are all in the checked-in runner.

```text
Ultra-FineWeb revision + tokenizer
          |  immutable uint32 shards and manifest
          v
Cloudflare R2  <------>  provenance manifest / checkpoints / final weights
          |
          | sync only selected pilot shards
          v
RunPod network volume (same region as the selected RTX 5090)
  /runpod-volume/datasets/ultra-fineweb-r0a/*.bin
          |
          v
Track creates one scoped RunPod pod ---> bundled verified worker
          |                                      |
          +--- metrics, logs, cancellation -------+--> track.fabryka.ai/runs
```

## Immutable data contract

The worker never downloads or tokenizes web data. Before launch, materialize
each shard as little-endian `uint32` token IDs and place it below
`/runpod-volume/datasets`. The Track request uses a relative path, token count
and SHA-256 for every shard. The worker rejects paths outside that directory,
wrong byte counts and hashes. This makes a resumed or audited run use exactly
the declared data.

The canonical R2 prefix should be:

```text
r2://<bucket>/arc-e-149m/r0a/
  source.json             # HF revision, split, text-column and exclusions
  tokenizer/              # tokenizer.json plus SHA-256 manifest
  shards/manifest.json    # exact paths, SHA-256, token count and doc split
  shards/train-*.bin
  checkpoints/<run-id>/
```

Keep ARC-Easy and ARC-Challenge questions, answer choices, answers and
paraphrases out of both the source selection and synthetic augmentation.

## Track launch contract

Use `configs/arc-e-149m-r0a-track-request.example.json` only after replacing
the placeholder hash with the generated shard manifest. `steps` is
`ceil(1,000,000,000 / (8 * 2048))`; the runner reports actual tokens seen, so
the request is an explicit 1B-token systems pilot rather than a claim about the
100B main run.

The production Track service must be configured with a pinned image digest and
the real compatible volume, never a region-mismatched volume:

```text
FABRYKA_RUNPOD_GPU_TYPE=NVIDIA GeForce RTX 5090
FABRYKA_RUNPOD_CLOUD_TYPE=SECURE
FABRYKA_RUNPOD_MAX_HOURLY_USD=0.99
FABRYKA_RUNPOD_MAX_SECONDS=86400
FABRYKA_RUNPOD_NETWORK_VOLUME_ID=p01chmugmg
FABRYKA_RUNPOD_VOLUME_MOUNT=/runpod-volume
FABRYKA_RUNNER_IMAGE=<pinned-cuda-pytorch-image-digest>
```

The dedicated 50GB EUR-NO-1 pilot volume is `p01chmugmg`
(`slayerlab-arc-e-149m-pilot-cache`). The earlier Tokyo volume must not be
attached to this run. The 100B run needs canonical R2 storage and a larger,
region-matched cache; 50GB is a pilot cache, not its durable corpus store.

## Preflight gate

1. Pin the FineWeb-Edu dataset revision and write `source.json`.
2. Train or select the 32k tokenizer, publish its files and hashes to R2.
3. Tokenize, document-split, deduplicate and hash the selected 1B-token pilot.
4. Sync the exact shard prefix to a compatible RunPod volume; verify every
   local SHA-256 against `manifest.json`.
5. Verify current 5090 availability and image CUDA/BF16 support with a cheap
   Track smoke job.
6. Launch the real Track run, then monitor it at
   `https://track.fabryka.ai/runs`. Track owns cancellation, logs, artifacts
   and pod cleanup.

For R0a, pin `openbmb/Ultra-FineWeb`, select only English `score >= 0.90`
documents, then split at the whole-document level before tokenization. This is
the general-web control. Follow it with a matched FineWeb-Edu/science-curriculum
ablation before claiming that either corpus improves ARC-Easy.

The 1B run is a systems and optimization pilot. Scale only after a fixed
validation set and independent science diagnostic show that the learning curve
is healthy; do not use ARC-Easy test during selection.

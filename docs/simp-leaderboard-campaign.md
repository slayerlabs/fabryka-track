# Full leaderboard campaign on the existing simp GPU

`python -m fabryka_track.benchmark_campaign --name NAME --runner simp` inventories
finished public native checkpoints and prints the plan. `--enqueue` reserves one
durable full evaluation per checkpoint in the database. Repeating the same name
and checkpoint hashes does not duplicate jobs. The operator batch can exceed the
interactive API's 20-job admission limit; execution is still serial on simp.
The command never allocates a cloud GPU. Private runs and unsupported checkpoints
are excluded. Existing unrelated evaluations cause enqueue to fail before writes.

The `leaderboard` suite runs ARC Easy, ARC Challenge, PIQA, ArithMark 2,
ArithMark 3, BananaMind Base Bench 1.1 and HellaSwag. It then calculates INT Index.
All evaluations use zero-shot prompts, seed 42, FP32 and native UTF-8 byte tokens.
Dataset revisions and custom dataset checksums are fixed in `leaderboard_suite.py`.
The new protocol separates this campaign from older evaluations. It performs a
fresh evaluation of every task instead of mixing old and new scoring records.

## GPU worker

The existing `fabryka-track-bench.service` uses its existing scoped runner key.
Install the tested source on simp and configure a systemd drop-in with:

```
[Service]
Environment=TRACK_BENCHMARK_REQUIRE_IDLE=1
Environment=TRACK_BENCHMARK_GPU_INDEX=0
Environment=TRACK_BENCHMARK_MIN_FREE_MB=10000
Environment=TRACK_BENCHMARK_TIMEOUT_SECONDS=43200
Environment=TRACK_BENCHMARK_DATA_DIR=/home/kacper/fabryka-track-benchmark-data
Nice=10
```

Before claiming, require three checks ten seconds apart with GPU utilization at
most 15% and at least 10,000 MiB free. Failed GPU probes block claims. An existing
training job is never stopped. This admission check is not GPU preemption: a new
training process started after a benchmark claim can still share the GPU.

For explicitly chosen concurrent training and evaluation, keep the admission
check enabled and set `TRACK_BENCHMARK_MAX_UTILIZATION=100`,
`TRACK_BENCHMARK_MIN_FREE_MB=4096`, and `TRACK_BENCHMARK_MEMORY_LIMIT_MB=2048`.
The last setting caps each evaluation child's PyTorch caching allocator at
2 GiB; driver/context allocations are additional. The existing OOM handling
reduces evaluation batches. The existing simp policy stays idle-only unless
the utilization override is set. Measure the
effect on training throughput before enabling concurrent operation: spare VRAM
does not imply spare compute. GPU peak allocation/reservation and the configured
cap are recorded in evaluation provenance.

### Measured sharing cost on 2026-09-15

A short RTX 3090 probe ran the native 128M architecture with random weights
through the production continuation scorer on sampled HellaSwag inputs. This
was a capacity measurement, not a checkpoint quality evaluation. Training
throughput was measured from token deltas and wall-clock update arrivals:

| Phase | Training tokens/s | Maximum GPU memory used | Minimum GPU memory free |
| --- | ---: | ---: | ---: |
| Training baseline | 21,723 | 15,909 MiB | 8,216 MiB |
| Concurrent scoring | 10,219 | 17,898 MiB | 6,227 MiB |
| After scoring exited | 21,714 | 15,909 MiB | 8,216 MiB |

The probe used a 2,048 MiB allocator cap and reached 1,676 MiB reserved by
PyTorch. There were five observed training updates per phase; scoring took
100 seconds, with 60-second baseline and recovery windows. Memory fit, but
training throughput fell by about 53% for this workload and recovered after
the probe. Other checkpoint sizes and task mixes may have different effects.
The campaign remains configured to wait for an idle GPU.

`jobs/status.json` records waiting-for-GPU, waiting-for-job or running state
without credentials. Database results are saved after each task. A failed job
retains completed tasks; the owner can resume it using the `leaderboard` suite.
Lease loss terminates the child. The configured 12-hour limit bounds each job.

## Evaluation-only data

Keep the three pinned files in the private directory above, mode 0700:
`arithmark2.jsonl`, `arithmark3.jsonl`, `bananamind_base_1_1.jsonl`.
The latter requires existing authorized access to the BananaMind dataset. Never
commit the dataset, copy it into training corpora, or publish its answer keys.
The worker verifies exact SHA-256 hashes before evaluation. Standard harness
datasets use its normal Hugging Face cache with pinned revisions.

Sources:

- [ArithMark 2](https://huggingface.co/datasets/AxiomicLabs/ArithMark-2.0)
- [ArithMark 3](https://huggingface.co/datasets/AxiomicLabs/Arithmark-3.0)
- [BananaMind 1.1 scoring](https://huggingface.co/datasets/BananaMind/BananaMind-Base-Bench-1.1)
- [INT formula](https://huggingface.co/spaces/AxiomicLabs/Open_SLM_Leaderboard/blob/75ebf270c9230e39bf661a8e26ae51a824a7e672/index.html)

ArithMark 2 reports raw continuation accuracy; ArithMark 3 uses mean likelihood
per native token. BananaMind uses mean likelihood to select answers and the
published weighted fixed-item Elo estimator (four-game prior at 1000).
The full INT formula uses normalized HellaSwag, average ARC Easy/Challenge,
PIQA and ArithMark 3 with weights 1, 1, 1, 0.65. Track requires every component;
missing results never produce an index. Published reference inputs reproduce
23.041095890410958. Below-chance values remain negative.

In the pinned ArithMark 3 file, the correct number is always one of the two
middle numeric options (508 and 492 items). The published INT formula still uses
a nominal 25% baseline. This limitation is disclosed on the results page.

## Scoring and verification

`bounded-fused-prefix-v2` obtains all predictions before a context-window shift
in one causal forward pass, using right padding. Subsequent bytes keep the exact
maximal sliding window and reset learned absolute positions. Windows are streamed
in bounded batches; out-of-memory attempts retry smaller batches without counting
partial output twice. FP32 comparisons against the bytewise reference cover
empty prefixes, UTF-8 continuations, padding and context overflow. An optimization
speedup must be measured on an idle GPU before revising the earlier cost estimate.

The public `/benchmark-results` page shows campaign progress, a full-suite
leaderboard, individual measurements and checkpoint evidence. Only finished
evaluations on currently public finished runs are published.

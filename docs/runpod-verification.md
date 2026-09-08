# RunPod integration verification — 2026-09-08

A production integration smoke run completed on RunPod, not the VPS CPU.
This checks orchestration and checkpoint integrity; it is not a model-quality run
or completion of a 20x training budget.

- Run: `9a2c7096-7324-4390-a0d5-74da67d71029` (private owner workspace).
- Container: `dawidmkrk/dmpod-gpt:1.0`.
- GPU: NVIDIA RTX A5000; provider rate reported $0.27/hour.
- Model: 8,160,256 trainable parameters, random initialization.
- Training: 10 updates, batch 2, context 512 bytes, 10,240 byte tokens.
- Runtime: PyTorch 2.8.0+cu128, CUDA 12.8, BF16.
- Best checkpoint: step 10; diagnostic validation loss 3.7974605560.
- Checkpoint: 32,672,767 bytes.
- SHA-256: `b1a01937f7f2befa100810e394c00984a058029754c4633bd201840dc67d65f5`.
- Recipe, metrics JSONL, training log, result JSON and checkpoint were uploaded;
  server-side hashes were checked against the actual stored files.
- Downloaded checkpoint loaded with `weights_only=True` and strict state loading
  into a fresh CPU model. A forward pass returned finite `(1, 4, 256)` logits.
- Job finished with `cleanup_done=true`; both provider pod lookup and the account's
  pod list confirmed the test pod was removed (no remaining pods).

The initial provisioning request failed before a pod existed. A controlled retry
followed an empty provider pod-list check and succeeded. Automatic recovery does
not blindly retry ambiguous creates: it reconciles the deterministic pod name.

Tests cover provider access, parameter counts, job-scoped credentials, source
isolation, upload integrity, sync-before-delete, callback idempotency, cleanup
retries and restart reconciliation. Browser checks verify the actual 128M model
selection, 20x budget, millions input, review and resulting API payload without
launching an additional paid job. Production library/profile checks also passed.

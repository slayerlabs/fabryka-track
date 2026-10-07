# Importing original training logs

SDK runs can backfill metrics using their original steps and deterministic event IDs. Stop at the checkpoint used for continuation: later records from the source run belong to a different branch and must not enter the continued curve. Retain original logs, their revision and SHA-256 hashes as artifacts.

When source timestamps are missing, upload `tracking/history_import` before metrics. Its strict schema contains `repo_id`, a 40-character `revision`, `resume_step`, `training_rows`, `validation_rows`, `excluded_training_rows`, `original_world_size`, `complete`, and `metric_bounds`. Bounds map each imported metric path to its inclusive `[first_step, last_step]`; every bound must precede or equal the resumed checkpoint. Set `complete` after SDK spools drain. The API returns null timestamps only for those metric ranges, preserving real continuation timestamps. Elapsed-time controls remain disabled for a curve with missing dates.

Owners see provenance automatically. Set `visibility/public_history` to true to show its pinned source link and counts publicly. This does not publish metric paths, artifacts or other attributes; metric visibility retains its existing rules.

Step plots mark the resumed checkpoint. EMA restarts after that checkpoint and trend segments are separated so changes in hardware or training phase do not blend across the boundary. Raw measurements remain scatter points.

For Slayer149, original Hugging Face logs contain 1,429 training measurements and 28 validation measurements. Import the 1,425 training measurements through step 28,500. Retain but exclude the four later measurements from this continuation. The original run used eight ranks; White uses two GPUs with the same global token batch.

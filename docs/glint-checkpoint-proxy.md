# GLINT fast proxy for the Slayer149 White run

The run owner can queue a one-off evaluation of the latest saved checkpoint or
choose an automatic cadence in the run's GLINT fast proxy panel. The cadence is
aligned to checkpoint files already written by the trainer. Track stores only
the checkpoint step/hash and the result; the 1.25 GB optimizer checkpoint stays
on White.

The Track SDK observer syncs immutable `checkpoints/<step>` receipts. Its
background proxy worker claims owner-authorized jobs, verifies the local file
against the receipt SHA-256, and invokes the pinned evaluator on CPU with a
low-priority process and three CPU threads. It never allocates a CUDA device or
pauses the trainer. The evaluator's atomic per-item progress file makes a retry
resume at the last completed batch. A heartbeat lease allows stale work to be
reclaimed after a worker restart.

The fixed fast proxy covers 2,620 examples: 2,121 BLiMP pairs, 483 ARC-Easy
questions and 16 WikiText documents. It reports an estimated development score,
task breakdown and scoring time. It is intended for comparing checkpoints on
this same recipe. It is not the full GLINT leaderboard; its historical
held-out-model calibration does not establish sensitivity or exact ranking for
nearby Slayer149 checkpoints. Keep the protocol, checkpoint selection and
scoring implementation fixed when reading the trend.

Automatic evaluation is off until the owner enables it. Available cadences are
500, 1,000, 2,000 or 5,000 steps. Only one proxy job runs for this run at a time.
The public run page remains read-only; the controls, history and score trend are
owner-only.

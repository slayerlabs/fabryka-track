# Training Suit: implementation boundary

Architecture source: user-provided `/Users/kacper/Desktop/training-suit-2/training-suit.md`, copied verbatim to `training-suit-architecture.md` on 2026-09-09. This is the target architecture, not a description of deployed services.

Current Track combines tracker API, studio, SQLite metadata, local artifacts, and an in-process RunPod controller. The September incident fixes retain that deployment. They do not implement RabbitMQ or the separate Training Suit control plane.

Implementation sequence:

1. Define versioned run specification and persisted Project → Experiment → Run → Task relationships, retaining Track run IDs as external references.
2. Add RabbitMQ worker delivery with a transactional outbox, idempotency keys, acknowledgements after persisted state, bounded retry and dead-letter handling. Provision and teardown must only be dispatched through this queue.
3. Extract the RunPod adapter into an infrastructure worker. Reconcile named pods before retrying uncertain allocations. Preserve cost limits and cancellation across restarts.
4. Introduce the separate file-server API with checksummed immutable corpora/checkpoints and scoped worker credentials. Dataset preparation produces a manifest consumed by compute nodes.
5. Split `dataset.upload`, `node.provision`, `train`, `checkpoint.upload`, `eval`, `benchmark`, `publish`, `run.cleanup`, and `node.teardown` into durable tasks. Checkpoint upload retries must not retrain the model. Persist dependencies and cleanup even after failure.
6. Keep quality evaluation in Track; persist execution-performance benchmark results in the relational database. Publish messages contain a result identifier, never embedded results. The publication adapter reads the stored result.
7. Validate crash recovery, duplicate deliveries, cancellation, artifact verification, isolated concurrent experiments and cleanup before moving production submissions to the new queue.

The source deliberately leaves MVP scope, storage API, exact schemas, tracker integration, eval hardware and publication contracts open. These need concrete contracts before production cutover. Existing runs and occupied GPU pods must remain managed by their original controller until completion; do not let two controllers own the same run.

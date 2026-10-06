# Dataset storage on tracking servers

Set `FABRYKA_DATASET_STORAGE_ENABLED=false` on a deployment dedicated to tracking.
This disables persisted dataset uploads, Hugging Face imports and Ivme mixture
preparation, and prevents the import worker from starting. Existing experiment
ingestion, run history, metrics, artifacts and dataset metadata remain available.

When removing a dataset payload, retain its database row, original byte count,
hash and source provenance. Add `content_available: false` and an eviction
timestamp to its source metadata. Content requests and attempts to launch new
training with that dataset return HTTP 410. Training data should be prepared and
stored on the training infrastructure. Existing deployments keep dataset storage
enabled unless explicitly configured otherwise.

# Agent-friendly tracking API direction

Reference: https://docs.neptune.ai/api_cheat_sheet (reviewed 2026-10-05).

Track is an experiment record for people, scripts and agents. People define goals and review evidence; agents report progress, metrics and artifacts. The Python SDK and REST API are the primary integrations, and the browser is the review surface.

## Proposed Python surface

This is a design example, not an API shipped in the current SDK:

```python
from fabryka import Run

with Run(project="research", experiment_name="baseline") as run:
    run.log_configs({"learning_rate": 3e-4, "dataset/revision": "pinned-revision"})
    run.log_metrics({"train/loss": loss}, step=step)
    run.assign_files({"checkpoints/best": "best.pt"})
```

Prefer explicit named methods for agent tools and generated examples. Keep the existing `run.init`, `run.log`, `run.artifact`, `run.finish` interface working. The existing `fabryka.neptune.init_run` adapter implements an older field-based style; it is not full compatibility with the current Neptune Scale or Query APIs.

## Contract work before implementation

| Operation | Current building block | Required decisions or gaps |
| --- | --- | --- |
| `Run(...)` | `RunClient.init` | Instance lifecycle, context manager, resume identity and error semantics |
| `log_metrics(data, step)` | `RunClient.log`, `run.metrics` events | Numeric validation, ordering policy and idempotent retries |
| `log_configs(data)` | Field assignment, `run.attribute` events | Confirm server persistence and retrieval contract; define nested values and overwrite behavior |
| `assign_files(files)` | `RunClient.artifact` | Preserve namespace through upload; validate response before removing local spool artifact |
| Fetch runs and metrics | Existing REST run endpoints | Typed query client, filters, pagination and workspace ownership |
| Collaboration | Goals, engine updates, linked runs, research notes | Explicit shared workspace authorization; independent agent signup stays isolated |

Do not claim support for Neptune forks, previews, histograms, file series, query filters or resumable logging merely because method names are similar. Implement and test the persistence and retrieval semantics before advertising them.

Use independently written code and documentation. This document makes no legal conclusion about API compatibility or intellectual property.

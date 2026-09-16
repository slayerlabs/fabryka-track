# Ivme v3 dataset preset

Training studio (`/new`) offers the six-source **Ivme v3 · English** data mix.
This is a data recipe for Track's existing byte-token trainer, not a reproduction
of Ivme's architecture, tokenizer, optimizer or reported 15B-token run. It does
not change the model size, compute selection or token budget. Existing studio
model options remain unchanged and below 150M parameters.

| Dataset | Starter subset | Text field | Share |
|---|---|---|---:|
| HuggingFaceFW/fineweb-edu | sample-10BT | text | 46.67% |
| mlfoundations/dclm-baseline-1.0 | default | text | 27.78% |
| HuggingFaceFW/finewiki | en | text | 8.89% |
| HuggingFaceTB/finemath | finemath-3plus | text | 7.78% |
| HuggingFaceTB/smollm-corpus | cosmopedia-v2 | text | 5.56% |
| SimpleStories/SimpleStories | default | story | 3.32% |

## User flow

1. Choose **Prepare import** beside a missing source. The existing importer
   opens with the dataset, subset, training split and correct text column.
2. Preview or import a bounded sample; the preset starts at 10 MB per source.
   Users may change this size. Imports run one at a time using the existing
   per-account limit; failures appear in the importer and may be retried.
3. Once all six sources are in the user's library, **Apply Ivme mix** replaces
   the current weights with the exact six percentages. No training starts.
4. Review the model, budget and data reuse before explicitly launching.

FineWeb-Edu's `sample-10BT` is a Track starter choice: the Ivme card does not
specify which FineWeb-Edu subset it used. All imports are pinned by the backend
to their actual resolved Hub revision, saved with filters/provenance and private
text checksums. These are first matching documents, not representative full
corpora. Matching requires repo, subset, split, text column and unfiltered
contains/excludes/column rules; another source is never silently substituted.
When multiple matching imports exist, the first in the current library is used.

## Precision and training semantics

The old 20-point profiles still allocate 5% per point. Applying this preset or
choosing **Edit exact percentages** enables 0.01% inputs. Exact weights survive
local draft restoration, API validation, saved run configuration, checkpoints
and forks. `TrainingInput` accepts finite shares from 0.01 through 100 in 0.01
increments and checks a total of 10,000 hundredths of a percent. Zero-share
library rows are excluded from the request. Duplicate dataset IDs remain invalid.

CPU and GPU trainers already sample fixed-length byte sequences by source weight;
the fractional weights change sampling probabilities without changing the model.
These are expected proportions, not a guarantee that every small batch contains
exactly those percentages. They are not Ivme BPE-token proportions. Imported
sample sizes do not set mixture weights. Samples may be reused many times;
existing training-reuse warnings and CPU size limits still apply.

Source: [pinned Ivme v3 model card](https://huggingface.co/IvmeLabs/Ivme-Conversate-v3-Base/blob/65a61bee44474a6b981d7deb8a40bb8410b5ad08/README.md).
Dataset subset/text-field names were checked against public Hub/Viewer metadata
on 2026-09-16. Model benchmarks remain self-reported, not independently verified.

Implementation: `StudioMixData.ts`, `StudioMixRecipes.tsx`, `StudioHFDatasets.tsx`,
`Studio.tsx`, `StudioFork.ts`, and `training.py`. Tests cover source identity,
missing/substituted datasets, fractional validation and actual CPU checkpoint/fork
round trips. No production training run or GPU allocation is needed to use the
preset or prepare its samples.

Exact-share editing permits an unfinished over-allocated draft and labels the
excess explicitly. Review/start stays disabled until the total is 100%.
**Normalize to 100%** scales selected shares proportionally using largest-remainder
rounding at 0.01% precision, so equal thirds become 33.34/33.33/33.33 without drift.
Unfinished exact-share drafts survive page reloads without being rounded to points.

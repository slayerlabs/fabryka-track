---
goal_id: rfc-005
title: Train a 250M English base model
status: proposed
source: https://github.com/slayerlabs/rfcs/pull/5
source_revision: c0634b840051c12a977e89915e5909b32206bbd5
source_path: RFC-005-Slayer-Labs-250M-training.md
snapshot_date: 2026-09-12
---

# Agent-readable goal

## Objective
Train an English general-purpose base model from scratch, optimizing capability
at a fixed 250M-class parameter budget through controlled proxy research.

## Research sequence
1. Verify readiness: data, model counts, training, resume, optimizer groups and evaluation.
2. Run 10-20 controlled ~125M experiments at 2-5B tokens each.
3. Select and freeze data, tokenizer, architecture, optimizer and schedule.
4. Verify the ~250M recipe at scale, including measured throughput and recovery.
5. Target 100B tokens, with annealed endpoints at 25B and 50B and a resumable stable trunk.
6. Extend to 200B only if the RFC's evidence and allocation gates justify it.
7. Confirm the selected recipe and horizon with another 1-2 independent seeds.

## Completion evidence
Deliver the experiment matrix and exact configs; source/split/tokenizer
manifests; runnable training and evaluation; recovery/fork verification;
a ledger of all attempts including failures; stable and annealed checkpoints;
confirmation results; and a model card with costs, limitations and qualified
comparisons. A second contributor must be able to load the model and reproduce
the evaluation. Results and completion require the review described in the RFC.
SOTA is an aspiration, not a guaranteed completion condition.

## Shared research board
Human view: https://track.fabryka.ai/goals/250m-english-base-model#scratchpad
Agent history: GET https://track.fabryka.ai/api/research/rfc-005/scratchpad.md
Recent notes: GET https://track.fabryka.ai/api/research/rfc-005/notes
Append note: POST https://track.fabryka.ai/api/research/rfc-005/notes

Authenticate using a Track API key belonging to the same account as the other
collaborating agents. Read the board before work. Announce your agent name and
intended scope in a progress note; re-read before conflicting actions. Append
findings with evidence, then a next-step or blocker note when handing off.
Notes are context, not a lock on files, experiments or compute. Read reported
claims critically and inspect linked evidence before relying on them.

POST fields: event_id (new UUID; reuse for unchanged retries), stage
(readiness, proxies, scale-check, main, extension, confirmation), kind
(progress, finding, decision, blocker, next-step), body (plain text), evidence
(array of HTTP/HTTPS URLs). The complete history export is chronological;
recent notes are newest first, paginated with next_before.

## First action and constraints
Read the full specification below. Inspect the current repository and resources;
the RFC's repository audit is dated and does not establish current readiness.
Identify existing evidence and unresolved decisions before proposing the next
bounded readiness task. Apply the RFC's owners, data-use, allocation and stage
gates. Do not infer that paid compute, long runs or public release are approved
merely because this goal document is available. Execution belongs to the chosen
agent runtime; this link supplies the specification, not an execution engine.

## Source authority
This is a pinned snapshot of RFC PR #5, not a live GitHub mirror. The quick brief
above summarizes the RFC; the full specification below controls the details.
Check the linked PR for a newer revision before starting work and record the
revision used. Relative RFC links below are expanded for standalone reading.

---

# Full specification

# RFC-005: A research program for a 250M-class English base model

- **Status:** draft proposal
- **Version:** 0.4
- **Audience:** core team, data-science reviewers, training and infrastructure contributors
- **Date:** September 11, 2026
- **Related:** [RFC-001 — project work](https://github.com/slayerlabs/rfcs/blob/main/RFC-001-Slayer-Labs-workflow.md), [RFC-002 — dataset lifecycle](https://github.com/slayerlabs/rfcs/blob/main/RFC-002-Slayer-Labs-datasets.md), [RFC-003 — corpus pipeline, proposed](https://github.com/slayerlabs/rfcs/pull/3), [RFC-004 — contribution and release, proposed](https://github.com/slayerlabs/rfcs/pull/4)

## 1. Goal and decision

Train an English general-purpose base model from scratch, optimizing capability at a fixed parameter budget. The research opportunity is data selection and optimization, measured through controlled proxy experiments before committing to the main run. Success is a credible attempt at a leading small base model, not a promise that a particular training budget will achieve SOTA.

The recommended proxy program is **10–20 controlled runs at approximately 125M parameters, each reaching 2–5B tokens**, using the available no-rental-cost compute. Test data mixture, tokenizer, Muon versus AdamW, depth/width, GQA, ReLU² versus SwiGLU, LR, and curriculum/annealing. Reserve slots for a combined recipe and independent seeds. A 50M rung is optional debugging work, not the decisive judge of data quality.

**Recommended main-run target: 100B tokens**, with annealed **25B and 50B checkpoints** and an **optional 200B extension**, as confirmed by the proposer. Preserve a stable-LR trunk and separately annealed endpoints. The target is a research allocation, not a minimum needed for a 250M model or a guarantee of SOTA; execution remains subject to the stage gates below.

| Stage | Scale and scope | Result |
| --- | --- | --- |
| Readiness | Bounded tests; optional 50M debugging | Verified data, model counts, training, resume, optimizer groups and evaluation |
| Proxy research | 10–20 × ~125M × 2–5B | Controlled comparisons and a selected architecture/tokenizer/data/optimizer/curriculum recipe |
| Scale check | Bounded ~250M stability and throughput test | Frozen scale-specific LR, memory/cost forecast and branch plan |
| Main | ~250M; 25B → 50B → 100B endpoints | Quality at fixed parameter count and measured training efficiency |
| Optional extension | Same stable trajectory, up to 200B | Evidence that further training remains worthwhile |
| Confirmation | Another 1–2 independent full seeds to the selected horizon | Repeatability, uncertainty and qualified comparative claims |

### Token budget and the Chinchilla comparison

The familiar [Chinchilla-style](https://arxiv.org/abs/2203.15556) planning heuristic is roughly **20 training tokens per parameter**. For a nominal 250M model that is 5B tokens. “20 tokens per parameter” and “20 times that budget” are different quantities:

| Endpoint exposure | Tokens per nominal total parameter | Multiple of the 5B heuristic |
| ---: | ---: | ---: |
| 5B | 20 | 1× |
| 25B | 100 | 5× |
| 50B | 200 | 10× |
| 100B | 400 | 20× |
| 200B | 800 | 40× |

The 100B target is therefore approximately **20× Chinchilla-style exposure**. It is deliberately longer training at a fixed small model size, rather than optimizing the allocation of a fixed pretraining compute budget between model size and data. It is not a statement that every 250M model needs 100B. Use actual implemented parameter counts for reported ratios, and keep the denominator distinct from a source's “scaling parameter” convention.

Free compute changes the financial constraint on proxies, not the need to record GPU-hours, failures and data exposure. Each stage has an owner, a work/allocation budget and an evidence review. Rented stages additionally require a numeric spend cap. Instruction tuning, an assistant deployment and public model publication are separate decisions.

### Research questions

1. Which recipe choices improve held-out English quality at matched size and compute?
2. Which data/tokenizer choices survive longer proxy training and another seed?
3. What marginal BPB/CORE gains do longer, comparably annealed main-run endpoints provide?
4. Does the selected result reproduce across fresh initialization and data-order seeds?

[DataDecide](https://proceedings.mlr.press/v267/magnusson25a.html) reports approximately 80% correct pairwise data-ranking decisions from 150M to its 1B target and useful continuous likelihood proxies at small scales. This motivates intermediate-scale data experiments; it is not an 80% guarantee for our campaign. Its nominal 150M primary runs reach approximately 15B tokens, whereas our proxies reach 2–5B. Validate ranking stability rather than assuming that the result transfers to longer-trained English models.

## 2. Starting point and boundaries

The training audit is based on Fabryka Track commit [`bc90c207`](https://github.com/kwikiel/fabryka-track/tree/bc90c2076af9cc1e11cd2d678f371cef7d0c6dfe), inspected September 11. It establishes source behavior, not current deployed configuration or measured GPU performance.

| Existing component | What it provides | Gap for this experiment |
| --- | --- | --- |
| [Native model](https://github.com/kwikiel/fabryka-track/blob/bc90c2076af9cc1e11cd2d678f371cef7d0c6dfe/src/fabryka_track/native_model.py) | Causal Transformer with 256-byte vocabulary | Proposed subword architecture and checkpoint format are different |
| [Training API](https://github.com/kwikiel/fabryka-track/blob/bc90c2076af9cc1e11cd2d678f371cef7d0c6dfe/src/fabryka_track/training.py) and [GPU presets](https://github.com/kwikiel/fabryka-track/blob/bc90c2076af9cc1e11cd2d678f371cef7d0c6dfe/src/fabryka_track/gpu_training.py) | Presets through `128m`; token-budget scheduling | No `250m` request; API runtime ceiling is 24 hours |
| [GPU worker](https://github.com/kwikiel/fabryka-track/blob/bc90c2076af9cc1e11cd2d678f371cef7d0c6dfe/src/fabryka_track/runpod_worker.py) | Disk-mapped byte data, document holdouts, optional BF16, clipping, final weight export | No gradient accumulation or periodic full-state resume |
| [Track SDK](https://github.com/kwikiel/fabryka-track/blob/bc90c2076af9cc1e11cd2d678f371cef7d0c6dfe/README.md) | External run logging, local event spool, artifact registration | New trainer integration and authenticated delivery need verification |

RFC-001 governs task ownership and review. RFC-002 supplies the current documented manual path for data acceptance. RFC-003 and RFC-004 were open proposals when this draft was prepared; this RFC neither adopts nor supersedes them. If adopted, their versioned outputs and decisions become inputs here. A manual accepted data snapshot can support the first experiment while the automated pipeline is being built.

Corpus build and release policy remains in the data RFCs. This RFC adds experiment-specific splitting, tokenization, sampling, checkpointing, and evaluation. In particular, RFC-003's proposed `cl100k` counts describe the corpus; they are not this model's training-token budget. The experiment records both units separately.

## 3. Target architecture and optimizer hypotheses

The preferred research starting point is deep and narrow, with ReLU² and Muon. They remain hypotheses with controls. [MobileLLM](https://arxiv.org/abs/2402.14905) motivates testing depth, embedding sharing and GQA below 1B; it does not establish this exact configuration.

| Component | 250M-class reference |
| --- | --- |
| Decoder blocks / hidden width | 36 / 768 |
| Attention | GQA, 6 query heads × 128 dimensions, 2 KV heads |
| Feed-forward | ReLU², intermediate width 3,072; two projections |
| Vocabulary | 32,768 byte-BPE IDs including special tokens |
| Embeddings | Tied input/output; no vocabulary-sized value embeddings |
| Normalization / positions | Learned RMSNorm scales / RoPE; parameter-free per-head QK RMS normalization |
| Context | 2,048 tokens in training; explicit prompt-fit audit in evaluation |
| Biases / dropout | None / zero |
| Starting precision | BF16 compute, FP32 master weights and optimizer state |
| Optimizer | Muon on eligible hidden-layer 2-D matrices; AdamW on embeddings and normalization/scalars |
| Effective batch | Initially 262,144 prediction targets per update; calibrate and freeze before comparisons |

Under these definitions the analytic count is **251,714,304** trainable parameters. With FFN width **3,040** it is **249,944,832**, a candidate for a strict ≤250M category. Choose the category before the final recipe is frozen: a 251.7M model must never be labeled a strict ≤250M entry. Count all unique trainable weights, including tied embeddings once, and audit the implemented model. Report non-embedding/scaling counts separately.

For tied embeddings, learned pre-attention/pre-MLP/final RMSNorm and parameter-free QK norm:

`N = V*d + L*(2*d*d + 2*d*k + m*d*f + 2*d) + d`

Here `k = KV_heads * head_dim`; `m=2` for ReLU² and `m=3` for SwiGLU. An untied head adds `V*d`; learned QK gains would add parameters and require another audit.

| Candidate | Dimensions | Analytic total |
| --- | --- | ---: |
| Deep ReLU² reference | 36 × 768; 6Q:2KV × 128; FFN 3,072 | 251,714,304 |
| Deep SwiGLU control | 36 × 768; 12Q:4KV × 64; FFN 2,048 | 251,714,304 |
| Wider SwiGLU candidate | 20 × 1,024; 16Q:4KV × 64; FFN 2,688 | 251,175,936 |
| Initial proxy | 30 × 576; 6Q:2KV × 96; ReLU² FFN 2,304 | 125,077,824 |

The two deep rows have different head dimensions as well as activation. They are candidate bundles, not a clean activation ablation. The controlled proxy activation test keeps attention unchanged and switches FFN width from 4d ReLU² to 8d/3 SwiGLU. Test head layout separately if promoting the 12Q:4KV candidate. Define the shallow/deep width mappings at the proxy scale before execution, including any 24-versus-36-block comparison; no unspecified “depth equivalence” is accepted.

Keep total parameters within a proposed ±2% band around the proxy target. Tying and GQA change parameter allocation: record compensating width changes and describe size-matched recipe comparisons honestly. Preserve a fixed-shape control if isolating the mechanism is important. No value embeddings or recurrent hybrids in this first matrix.

### Optimizer and numerical controls

Use a pinned Muon implementation and explicit matrix partitioning; do not route embeddings to Muon merely because they are 2-D. The tied embedding appears in AdamW exactly once. Maintain an all-AdamW control, and serialize both optimizers' state for resume.

[PyTorch's Muon documentation](https://docs.pytorch.org/docs/main/generated/torch.optim.Muon.html) distinguishes LR adjustment conventions, including `original` and `match_rms_adamw`. Select and record the convention. With matched-RMS adjustment, proposed initial LR candidates are 6e-4, 1e-3 and 1.6e-3, subject to a short stability check. These are not directly interchangeable with a raw Muon LR copied from another implementation. Pin a supported library release rather than relying on moving `main` documentation.

Starting settings: Muon momentum 0.95; AdamW betas 0.9/0.95; hidden-matrix decay 0.1, zero decay on embeddings/norms; gradient norm clipping 1.0 after accumulation. Treat each optimizer's calibrated group LRs as part of the recipe. Give both optimizer families comparable bounded tuning opportunities. Recalibrate at 250M, then freeze the scale-specific LR before comparing data/horizons.

BF16 is the comparison reference. FP8 is a later engineering candidate only on compatible hardware after loss/gradient and recovery checks against BF16; do not assume the reported 4×3090 setup supports an FP8 path. Any accepted numerical change becomes a new recorded recipe rather than an unreported speed optimization.

## 4. Data candidates and research-use boundary

Establish **pure ClimbMix** as the research data baseline before mixture changes. NVIDIA's [dataset card](https://huggingface.co/datasets/nvidia/Nemotron-ClimbMix/blob/main/README.md) describes approximately 400B GPT-2-tokenized tokens and specifies CC BY-NC 4.0 and research/development-only use. This RFC treats ClimbMix runs as research artifacts; commercial deployment is not cleared by this proposal. Non-Climb candidates also need source/use review and are not automatically cleared alternatives.

| Recipe | Proposed consumed-token mixture | Controlled question |
| --- | --- | --- |
| A | 100% ClimbMix | Released research baseline |
| B | 80% ClimbMix + 10% FineMath + 10% eligible educational code | Does a combined specialist intervention help? |
| C | 50% FineWeb-Edu + 50% DCLM-Baseline | Alternative foundation |
| D | 40% FineWeb-Edu + 40% DCLM-Baseline + 10% FineMath + 10% eligible educational code | Does the specialist intervention transfer to the alternative? |

These are interpretable starting experiments, not final optimal weights. B versus A estimates the combined math/code intervention, not the separate contribution of each. If that distinction matters, use an interaction slot to separate them. Scientific/encyclopedic text or ClimbLab semantic-cluster weights are follow-ups competing for the same finite slots; do not build a new clustering/search service before testing broad mixtures.

Sources: [FineWeb-Edu](https://huggingface.co/datasets/HuggingFaceFW/fineweb-edu), [DCLM-Baseline](https://huggingface.co/datasets/mlfoundations/dclm-baseline-1.0), [FineMath](https://huggingface.co/datasets/HuggingFaceTB/finemath), and [Stack-Edu](https://huggingface.co/datasets/HuggingFaceTB/stack-edu). Freeze the FineMath subset, programming languages, quality filters, source-license filters and internal weights. Stack-Edu supplies file identifiers rather than all code contents; actual retrieval, checksums and eligible-source metadata are readiness work.

For NVIDIA's tokenized release, decode GPT-2 sequences with the pinned procedure, preserve document boundaries/special tokens and retokenize. For an already decoded mirror, validate conversion/provenance first and tokenize its text directly. The advertised upstream token count is not the count under our tokenizer.

### Proposed cluster-addressable input: gvlassis/ClimbMix

Use the user-supplied [gvlassis/ClimbMix snapshot](https://huggingface.co/datasets/gvlassis/ClimbMix/tree/15905979e830dc1a9dc91ce2587a9c2b8fa62424) as the preferred input candidate, subject to provenance and coverage verification. Its card/schema expose decoded `text` in Parquet and 20 `cluster_id=N` configurations. GPT-2 decoding is therefore not needed on this ingestion path.

The card's ratios are **document-count shares**, not model-token shares. Topic names come from a model labeling 100 samples per cluster; they are exploratory labels, not validated semantic classes. Do not equate these 20 partitions with NVIDIA's original 1,000 clustering groups.

For baseline A, preserve the verified release distribution: inventory every partition, tokenize and compute each cluster's token mass, then sample token blocks using those measured masses. Uniform cluster weighting or reusing document-share percentages as token weights changes the mixture. Validate sampled text, boundary mapping and counts against upstream before claiming an unchanged ClimbMix baseline. The mirror's missing license metadata is not permission to disregard upstream restrictions.

A cluster-reweighting contrast can occupy P20 instead of a generic interaction. Freeze its weights before execution, recount after deduplication and compare against the same-tokenizer A control. Until equivalence is verified, identify A as the pinned mirror baseline rather than an exact NVIDIA reproduction.

Deduplicate within and across sources, record provenance/tie-breaks, and split by document/related duplicate group before tokenizer fitting and packing. Training data must exclude the union of development and final evaluation material under a recorded decontamination method. Pin source revisions and checksums, preprocessing, split IDs and token counts. Pre-stage local shards; do not make the main loop depend on a live remote stream.

Record actual sampling weights, unique tokens, repeated passes and residual duplicate/contamination limitations. Check whether each component can support the contemplated **200B** extension without excessive unplanned reuse; any later weight/reuse change is a new recipe decision. A proposed general-text → capability-rich curriculum is tested with matched total source exposure before adoption. Horizon experiments otherwise keep the selected data policy fixed.

## 5. Proxy program: 10–20 controlled 125M runs

Use 125M as the principal decision scale and 2B as the first comparable exposure, extending selected runs to 5B. The recommended ceiling is twenty trajectories, including independent seed repeats. Ten runs is a smaller program with explicit deferred axes, not full coverage of every variable. The optional 50M smoke work does not replace these runs.

The default twenty-slot allocation below provides sixteen exploration/control trajectories and four combination/confirmation trajectories. Each row specifies its parent control. A single-factor label permits only the stated intervention, subject to documented parameter matching. The exact execution order is adaptive but each next contrast is registered before its outcome is observed.

| ID | Experiment / control | Main comparison |
| --- | --- | --- |
| P01 | Reference proxy, data A, reference 32K tokenizer, Muon | Anchor |
| P02 | P01 with all-AdamW, calibrated LR | Optimizer |
| P03 | P01 with lower Muon LR | LR |
| P04 | P01 with higher Muon LR | LR |
| P05 | Best bounded AdamW LR alternative versus P02 | Fair optimizer tuning |
| P06 | P01 with data B | Specialist mixture |
| P07 | P01 with data C | Alternative foundation |
| P08 | P01 with data D | Specialist transfer; also compare P07 |
| P09 | P01 with alternate 32K tokenizer | Tokenizer |
| P10 | P01 with declared wider/shallower size-matched model | Depth/width |
| P11 | P01 with GQA 1:1 instead of 3:1 | KV sharing |
| P12 | P01 with GQA 6:1 instead of 3:1 | Stronger KV sharing |
| P13 | P01 with matched-parameter SwiGLU; same head layout | Activation |
| P14 | P01 with untied embeddings and explicit size matching | Parameter allocation |
| P15 | P06 with curriculum, same total source exposure | Data order/curriculum |
| P16 | P01 with alternative cooldown duration/shape | Annealing |
| P17 | Best justified combined recipe, seed 0 | Do selected changes combine? |
| P18 | P17, independent seed 1 | Reproduce combined recipe |
| P19 | Strongest matched control, independent seed 1 | Paired confirmation |
| P20 | Closest unresolved data/recipe contrast, independent seed 1 or predeclared interaction | Resolve the consequential uncertainty |

P01–P16 normally reach 2B; P17–P20 may reach 5B. Any original control compared against a 5B trajectory must also reach 5B, and that extension consumes additional tokens within its trajectory allowance. Save stable checkpoints for valid continuation. Track actual new work when resuming or forking; never charge an already-trained prefix twice as executed compute, and never omit a new tail.

Hold data order, tokenizer, context, batch, token exposure and schedule constant within non-tokenizer comparisons. Use the same initialization/data-order seed labels across candidate/control pairs, while noting that different shapes cannot have identical weight tensors. A curriculum contrast uses the same total source counts and, where practical, the same document multiset in a different order; this isolates order from extra specialist exposure.

For tokenizer P09, use the same tokenizer-training text sample, total vocabulary budget and special-token inventory where possible. Different tokenization changes bytes seen per training token. Report matched-raw-byte/document exposure and matched-compute readouts as well as token-budget curves; compare BPB on identical text rather than cross-tokenizer perplexity. Maintain 2,048-token context but disclose its different text span. Freeze the selected tokenizer before confirmatory data comparisons. A tokenizer change invalidates reuse of old packed shards and weights.

QK norm is enabled in the reference. A disable-QK-norm ablation can replace P14 or P20 if prioritized; it must not be reported as tested unless actually run. Scientific/cluster mixtures and FP8 similarly consume slots instead of silently expanding the matrix. This is a controlled screening program with selected interactions, not a complete factorial experiment.

### Selection and stopping

Use a fixed English development panel. Optimize the **BPB / DCLM CORE plane**, with continuous answer-likelihood diagnostics as the sensitive proxy selector. Freeze practical BPB/CORE regression tolerances, metric weights and a tie rule before the screen. At 2B, reject instability and clearly dominated candidates; do not reject solely on noisy near-chance accuracy. Extend close, consequential contrasts to a matched 5B exposure within the allowance.

A recipe advances when its continuous improvement is consistent with held-out BPB and CORE guardrails and is not a single-task/seed artifact. Report the frontier when metrics conflict instead of inventing a total ordering after seeing results. Prefer a simpler, cheaper and usable recipe under a predeclared tie rule when evidence is indistinguishable. Publish all attempted cells and reasons for stopping internally with the experiment report.

The first main-model research baseline is the selected architecture on pure A. If another data recipe wins, keep its same-architecture A control identifiable at the proxy scale and budget a matched 250M control when claiming a target-scale data gain. A pure-A 250M baseline is a real extra run if it is not the main trajectory; it is not free because a public ClimbMix checkpoint exists.

## 6. Stable main run, endpoints and independent confirmation

Train the locked recipe with warmup in absolute tokens (initial candidate 100–200M, calibrated before launch), then stable LR. This avoids committing the entire trajectory to a cosine endpoint. [WSD research](https://arxiv.org/abs/2410.05192) supports this flexible scheduling pattern; it does not fix our optimal cooldown length.

The source notes proposed both a short 1–3B linear cooldown and a 10%-of-horizon cooldown. Test the scheduling contrast at proxy scale; default for budget illustration is a fixed **2B linear tail to 5% of peak** at each main endpoint. A 10%-tail option remains viable but has different cost. Freeze the selected curve, floor and duration before endpoint comparisons.

| Endpoint | Stable parent with 2B tail | New anneal tokens | Cumulative executed work for endpoints through this row |
| ---: | ---: | ---: | ---: |
| 25B | 23B | 2B | 25B |
| 50B | 48B | 2B | 52B |
| 100B | 98B | 2B | 104B |
| Optional 200B | 198B | 2B | 206B |

Producing 25B/50B/100B costs 98B stable tokens plus three 2B tails, **104B executed tokens**. A 200B extension with all four endpoints costs 206B. With 10%-of-horizon tails the equivalent totals are 107.5B and 217.5B. These calculations stop the trunk at the final fork; running stable training through the endpoint adds further work.

Save unannealed monitoring checkpoints at 10B and 20B and then at least every 5B, plus all exact fork boundaries. They are diagnostics, not directly comparable finished endpoints. Extra annealed 30B/40B or 10B/20B results are optional branch work, recorded and budgeted before execution. At each continuation gate measure marginal BPB/CORE improvement and actual cost. Two successive comparable endpoints with little useful improvement trigger a stop/recipe review, not an automatic extension.

Fork complete model, optimizer, RNG and data cursor from each stable parent. Restore the stable parent to continue the trunk; never continue it from a decayed child. Branches get distinct Track IDs, parent hashes, schedules, actual fork positions and realized exposures. Only the declared annealing policy changes during a horizon contrast. They share ancestry and are not independent seeds.

If curriculum wins, freeze the stable-trunk curriculum and endpoint policy before main training. A horizon-relative late-mixture switch belongs in an explicit child branch; it must not contaminate a trunk intended for later horizons. Compare curriculum and constant-mixture policies on matched exposures rather than attributing a combined data/schedule intervention to extra tokens alone.

### Confirmation and claims

Choose the horizon using development results and a predeclared practical-improvement threshold. Then run another one or two independent seeds from initialization to that selected horizon H, with unchanged data, tokenizer, optimizer and schedule. Confirmation costs H or 2H additional tokens, not another tail. Report discovery and confirmatory seeds separately and retain every seed's result. A changed recipe restarts exploration.

Use a final audit panel only after recipe/horizon selection. Two or three total seeds reduce the risk of a lucky winner but do not guarantee statistical power. Parameter-limited quality and training efficiency are separate claims. To claim SOTA, specify the parameter category, accessible comparison set, evaluation protocol, contamination limitations and uncertainty; reporting the best seed or mixing model-card scores is insufficient.

## 7. Trainer, tracking, and recovery

The first implementation is an on-demand trainer integrated through Track's SDK. Its code and recipes should live in the Track repository unless the team selects another implementation home at kickoff. Reuse an established model library and the existing logging client; implement only the data, training, resume, and evaluation integration needed here.

Record the code commit, image digest, dependency lock, model/tokenizer configuration, corpus and split hashes, evaluation protocol ID, seeds, hardware, precision, batch settings, schedule, and launch command. Log training loss, subword and byte-normalized validation metrics, tokens seen, learning rate, gradient norm, throughput, memory, and cost where available. Tokenizer and metric units must be visible in the run metadata; subword perplexity must not be labeled byte perplexity.

Save full resume state every 30 minutes, at evaluation milestones, and on a graceful stop: model, optimizer, scheduler, RNG states, sampler/shard cursor, counters, and manifest hashes. Save at optimizer boundaries. Write a temporary checkpoint, verify it, then atomically mark it complete; a partial checkpoint must never replace the previous usable one. Keep latest and previous recovery checkpoints plus the selected milestone exports.

Before the main run, compare uninterrupted and interrupted/resumed execution on a bounded fixture. Token order, counters and schedule must match exactly; compare losses/weights within a declared numerical tolerance for the selected kernels. Bitwise equality across different GPU/software stacks is not promised. Also load the exported model and tokenizer in a clean inference process.

Tracking outages should spool events locally and leave a recoverable run. Check storage headroom before continuing; pause if checkpoints or local logs cannot be written. Verify copied artifact hashes before releasing the training device. The studio controller's 24-hour limit is not bypassed silently: use a separately supervised external job for this first version, with its own deadline, spend cap and tested recovery.

Record experiment lineage in a versioned run manifest: stage, cell, seed, architecture/data/optimizer IDs, parent checkpoint and branch schedule. Retain full stable fork checkpoints until all planned endpoints and verification are complete. Retention of only the best development checkpoint would destroy the planned branching experiment.

## 8. Evaluation and comparison baselines

Pin the [DCLM evaluation implementation](https://github.com/mlfoundations/dclm), its full CORE task configuration, normalization, prompts and revisions. Full CORE is a defined aggregate; a cheap subset or continuous proxy is labeled separately and never called the official full score. Maintain a fixed multi-domain English held-out BPB panel independently of mixture weights. Target at least 5M text tokens each for development LM and final LM panels, with document-level split isolation.

For cheap comparisons retain per-answer conditional log-likelihoods for HellaSwag, ARC-Easy/Challenge, PIQA, BoolQ, WinoGrande and MMLU. Add reference-solution likelihood for MBPP/HumanEval as code diagnostics; it is not execution-based pass@k. A DataDecide-style score is `mean(exp(log P(correct continuation | prompt) / answer character count))`. It is character-normalized likelihood, not probability normalized over choices. Freeze formatting, Unicode character definition and special-token handling. Report raw likelihood, normalized-choice probability/margins and ordinary accuracy separately.

For text, `BPB = total text NLL / (original UTF-8 byte count × ln(2))`. Score every text token once with a fixed context/window policy, reset document context, exclude artificial special-token loss from text BPB and report EOS separately. Across tokenizers use the same raw documents, not per-token perplexity or equal-token validation samples with different text.

Use a small fixed loss panel every 0.5B training tokens, cheap task panels at 2B increments, and full development CORE/BPB at completed proxy readouts and annealed main endpoints. Final checkpoints additionally get ordinary task scores, BLiMP/LAMBADA where included in the pinned audit, fixed generation probes and a contamination report. These are proposed frequencies; measure their overhead before freezing them.

Keep context at 2,048 during core comparisons. Record per-task prompt-length distributions, lost demonstrations, truncated/dropped examples and exact truncation policy. Even 2,048 does not guarantee a prompt fits. A shortened-shot/context variant is a separate protocol and must be rerun for every baseline.

[Little-LM](https://hugovergnes.github.io/little-lm-3-8b/) reports a ReLU² throughput benefit, Muon/AdamW engineering and substantial CORE changes caused by prompt truncation. Its later recipe still used a long cooldown, so the write-up does not validate a universal 1–3B anneal. Its single-project results motivate ablations rather than establish the best ≤250M model. We do not transfer its GPU throughput, cost or score to this campaign.

Use paired bootstrap over shared evaluation examples/documents, with between-seed variation reported separately. Item bootstrap cannot estimate training-seed uncertainty. Missing required components mean an incomplete result; no silent weight redistribution. Screening is adaptive, and only frozen final comparisons are confirmatory.

CLIMB used development-task signals in mixture optimization; record the overlap between its selection tasks and ours and require evidence outside that set before claiming broad generalization. Reserve a disjoint final panel from all local tuning and record known public-benchmark exposure limitations.

### Baseline register

| Baseline | Role | Verification before comparison |
| --- | --- | --- |
| [Plain ClimbMix 268M](https://huggingface.co/jkminder/d16_268m_seed1/tree/9359cd86f732242e706bfd357da2cf6e603598d3) | Closest public research reference; 16 layers, width 1,024 | Same pinned harness, actual checkpoint exposure, tokenizer and full parameter count |
| [Plain ClimbMix 135M](https://huggingface.co/jkminder/d12_135m_seed6) | Proxy-scale external reference and seed evidence | Exact revisions and seed list; not the controlled baseline for a new architecture |
| [Optimized ClimbMix 286M](https://huggingface.co/jkminder/d12_optimized_286m_seed2/tree/d85520a0d2e2c00c7be1e14273a0d2e99067290f) | Architecture/parameter-allocation reference | Distinguish total weights from scaling parameters and count value embeddings |
| [SmolLM2-135M](https://huggingface.co/HuggingFaceTB/SmolLM2-135M) | Smaller general base model | Re-evaluate pinned weights; different training data/budget |
| [Gemma 3 270M](https://huggingface.co/google/gemma-3-270m), [MobileLLM-350M](https://huggingface.co/facebook/MobileLLM-350M), [SmolLM2-360M](https://huggingface.co/HuggingFaceTB/SmolLM2-360M) | Larger stretch comparisons | Not members of a strict ≤250M category; matched protocol with native tokenizers |

The inspected plain ladder card lists **268,435,514 total** and **234,881,024 scaling** parameters. Nominal 200 scaling-TPP is about **46.98B tokens**, with realized exposure from the saved-step record. The optimized 286M card lists **286,261,730 total** and **110,100,912 scaling** parameters; 200 scaling-TPP is about 22.02B tokens. This is why TPP must always carry its denominator. Cards were inspected, not independently benchmarked here; weight-count and checkpoint audits remain execution work.

Ask two distinct questions: can the candidate improve parameter-limited quality, and can an early endpoint improve quality at comparable measured exposure/cost? A 100B winner against the ~47B baseline does not establish better training efficiency. A 30–40B win would be more informative for that claim, but still needs tokenizer/compute and protocol accounting.

## 9. Compute envelope and gates

The user identifies no-rental-cost proxy compute and a 4×3090 setup. Verify current access, GPU inventory, competing jobs, usable memory and disk before scheduling; this draft has not measured that host. Independent proxy runs may use separate idle GPUs when fit/throughput permits. Do not reserve devices merely because they appear in an earlier configuration. Rental H100/B200 or other hardware is selected only after measuring the locked 250M recipe.

| Work | Executed exposure / accounting |
| --- | --- |
| Proxy envelope | 10–20 trajectories × 2–5B = 20–100B at ~125M |
| Default allocation | 16 × 2B + 4 × 5B = 52B at ~125M, before additional control extensions |
| Main through 100B | 104B at ~250M with the illustrative 2B-tail policy |
| Main through optional 200B | 206B cumulative at ~250M with that policy |
| Final confirmation | Another H–2H at ~250M for selected horizon H |
| Additional work | Control extensions, optimizer calibration, optional 250M pure-A comparison, smoke tests, failed attempts, extra branch tails and evaluation |

A nominal parameter-times-token proxy makes the default 52B-at-125M program about **26%** of a 250M × 100B trunk, with the 20–100B envelope spanning roughly **10–50%**. Thus the expanded free-compute program is not automatically within the earlier 15–20% exploration allowance. Report the expanded allocation honestly. Parameter-times-token is a rough accounting aid, not measured FLOPs or runtime across architectures/tokenizers.

Benchmark each materially different recipe at final batch/context/optimizer settings, including at least 30 minutes and a checkpoint/evaluation cycle. Record steady and end-to-end aggregate tokens/s, memory, utilization, storage stalls and optimizer time. Use whole-cluster rate with aggregate throughput, never per-device price with cluster-wide speed.

| Aggregate steady throughput, hypothetical | 100B trunk | 200B trunk |
| ---: | ---: | ---: |
| 50,000 tokens/s | 23.1 days | 46.3 days |
| 150,000 tokens/s | 7.7 days | 15.4 days |
| 300,000 tokens/s | 3.9 days | 7.7 days |

These scenarios exclude branch/evaluation/setup overhead and are not hardware predictions. Cost is the sum over executed runs of `tokens / measured aggregate tokens_per_second / 3600 × whole-cluster hourly rate`, with overhead and storage/transfer charges added once. Confirmatory full runs are outside a small generic contingency. No provider quote, booked device or completed performance measurement is claimed.

A materialized 100B-token uint16 stream is about 200 GB; 200B is 400 GB, before raw/decoded data, alternative tokenizations, indexes, checkpoints and backups. Size storage for unique inputs and planned repetitions, not just the final model file. Muon/AdamW state depends on matrix partitioning, so measure actual checkpoint size and total VRAM rather than treating an all-AdamW rule of thumb as a fit guarantee.

| Gate | Required evidence |
| --- | --- |
| Proxy start | Owners, allocation cap, accepted source/use scope, matrix and controls, exact model counts, fixed initial tokenizer/evaluation, resume/optimizer/export verification |
| Proxy extension/combination | All attempted results, matched controls, proposed 5B reads and remaining trajectory/token budget |
| Main start | Frozen complete recipe/category, horizon decision, scale-specific LR/throughput test, lineage and storage plan, allocated first endpoint budget |
| Longer endpoint | Comparable development trend, marginal cost, valid stable parent, data-reuse review and incremental allocation |
| Confirmation | Frozen recipe/horizon, independent seeds, untouched final panel and full-seed budget |
| Completion | Verified delivered artifacts, full ledger including failures, reviewed conclusions and qualified claims |

Stop for nonfinite training, artifact corruption, inability to save state or projected allocation/spend breach. Checkpoint early enough to transfer before a deadline. Negative or inconclusive results can satisfy RFC-001 when their evidence and conclusion are reviewed.

## 10. Ownership, delivery and remaining decisions

Name an experiment owner, independent technical reviewer, data owner with the required data reviewers, evaluation owner and infrastructure/budget owner. Roles may overlap but nobody accepts their own result. Agree a readiness work budget and review date; no calendar promise for the whole program is implied.

Deliver a versioned matrix and exact configs; accepted source/split/tokenizer manifests; runnable training and evaluation; recovery/fork tests; complete comparison ledger; stable parents and annealed exports; independent confirmation; and a model card with scope, failures, costs and limitations. A second contributor must be able to load the model and reproduce the evaluation from the record.

Use the existing Track SDK first. Studio support is separate work across model schemas, manifests, optimizer state, tokenizer-aware generation/evaluation, artifact handling, runtime and labels. Preserve explicit byte-model checkpoint compatibility. No new always-on service, clustering platform or synthetic-data generation pipeline is required for this campaign.

Public release requires the agreed destination, access scope, applicable data/use decisions and hash verification. ClimbMix-derived research artifacts are not silently promoted into a commercial release. Any later data issue must be traceable to the affected runs and branches through their manifests.

Before execution, settle: strict ≤250M versus 250M-class; concrete proxy depth mappings; tokenizer alternative; optimizer conventions/LRs; specialist-source inventory; practical evaluation tolerances; cooldown policy; named owners; hardware/storage; and each stage's allocation. These are explicit decisions at the relevant gates, not fabricated measured outcomes.

The alternatives are a direct fixed-recipe run (less research overhead), a reduced ten-run proxy matrix (deferred axes), a full factorial design (much larger), or continued pretraining of an existing model (different research question). The selected program earns its cost only if its controlled comparisons help choose the main recipe. Free compute is a reason to investigate more carefully, not to treat every added experiment as informative.

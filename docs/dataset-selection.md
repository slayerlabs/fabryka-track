# Polish TinyLM data: a 20-point starting recipe

Reviewed 2026-09-08. These are proposed starting weights, not a measured winning
mixture. One point is 5% of training tokens. Recount with the actual model tokenizer;
the byte trainer and the corpus card's token estimates use different units.

| Source | Points | Why start here |
|---|---:|---|
| FinetextPL-Edu, prediction >= 2.5 | 6 | Contemporary explanatory Polish; test the classifier threshold |
| SlayerLab HPLT v3 cleaned | 4 | Broader contemporary language and domains |
| Polish Wikipedia | 4 | Expository language and factual coverage |
| Wolne Lektury / Wikisource | 2 | Narrative and syntax, with overlap deduplication |
| Biblioteka Nauki | 2 | Scientific prose; retain per-record attribution and license |
| Wikibooks / Wikivoyage | 1 | Instructional and practical prose |
| EUR-Lex / Dziennik Ustaw / parliament | 1 | Legal coverage without dominating a general model |
| **Total** | **20** | **100%** |

The source list and counts in the supplied screenshot match
[SlayerLab/polish-dynaword](https://huggingface.co/datasets/SlayerLab/polish-dynaword/tree/02bcb0b5f991a30f8454c6444f701633b71f69d4).
Use its separate source files for profiles. Its published quality-mix configuration
caps legal sources at 15% and uses square-root sampling rather than raw corpus size.
The 5% legal share above is a proposed general-model starting point; a lawyer profile
should intentionally increase it. Keep public-domain work provenance, Wikimedia
attribution and Biblioteka Nauki's per-record license/attribution columns.

[FinetextPL-Edu](https://huggingface.co/datasets/FinetextPL/FinetextPL-Edu) provides
quality scores for Polish FineWeb2/FinePDFs documents. Its authors recommend
`prediction >= 2.5`; their reported experiments are at 561M and 1.8B parameters,
so those results do not establish superiority at 20–200M. The educational scorer
also downweights fiction: do not use that filter indiscriminately for a literary
profile. Verify source field casing from actual records before filtering.

[FineWeb2](https://huggingface.co/datasets/HuggingFaceFW/fineweb-2) is the reproducible
broader-web comparison. Do not combine its Polish slice with a derivative such as
FinetextPL-Edu without cross-source deduplication. Dataset packaging licenses do
not replace the underlying documents' rights metadata.

[SlayerLab/hplt-v3-pl-cleaned](https://huggingface.co/datasets/SlayerLab/hplt-v3-pl-cleaned)
is a separate cleaned web release. Check overlap with the HPLT source already in
DynaWord before combining them. Avoid treating both as independent fresh data.

## How to choose the winner

Compare this recipe against the same recipe with the six Finetext points replaced
by a high-quality HPLT/FineWeb2 slice. Hold architecture, tokenizer, token budget,
optimizer, document splits and seeds fixed. Use held-out Polish per-source
bits-per-byte and separate English TinyLM tasks. The English suite alone cannot
rank Polish corpus quality. Keep benchmark text out of training and remove
near-duplicate documents across train and evaluation. Split entire documents,
books and related sources together; a last-10%-of-text split is only a studio smoke
diagnostic.

The current web studio's three short built-in examples are workflow fixtures,
not any of the corpora above. The source recommendation does not mean that the
full datasets have been downloaded or connected to the CPU trainer.

# Leaderboard BPB - statystyka (paired bootstrap, seed=7, 5000 iter)

n_docs = 300, metryka: BPB = -sum(doc_nats)/ln2/sum(doc_bytes). Nizszy = lepszy.

## Modele (paired-bootstrap 95% CI)

| model | vocab | BPB | 95% CI |
|---|---|---|---|
| GoLLeM-45M | 32568 | 1.1591 | [1.1332, 1.1860] |
| GoLLeM-110M-v2 | 32000 | 1.0200 | [0.9897, 1.0511] |
| GoLLeM-110M-v3 | 32000 | 0.9876 | [0.9570, 1.0188] |
| Slayer-110M | 32000 | 1.0023 | [0.9701, 1.0348] |
| Polock-125M | 12285 | 2.2792 | [2.2499, 2.3094] |

## Pary w komorce (110M, vocab=32000)

| para (A vs B) | deltaBPB (A-B) | 95% CI | werdykt |
|---|---|---|---|
| GoLLeM-110M-v2 vs GoLLeM-110M-v3 | 0.032 | [0.030, 0.035] | istotna (GoLLeM-110M-v3<GoLLeM-110M-v2) |
| GoLLeM-110M-v2 vs Slayer-110M | 0.018 | [0.014, 0.022] | istotna (Slayer-110M<GoLLeM-110M-v2) |
| GoLLeM-110M-v3 vs Slayer-110M | -0.015 | [-0.019, -0.011] | istotna (GoLLeM-110M-v3<Slayer-110M) |

## MDE / power (komorka 110M)

- Obecna wykrywalna roznica przy n=300 (srednia polowa szerokosci CI paired-delta): 0.0034 BPB
- Docs potrzebne, by wykryc luke 0.02 BPB (skalowanie ~1/sqrt(n)): 9

## Wniosek

Przy n=300 istotne rozlaczne-CI sa pary: GoLLeM-110M-v2 vs GoLLeM-110M-v3, GoLLeM-110M-v2 vs Slayer-110M, GoLLeM-110M-v3 vs Slayer-110M. Pozostale nieodroznialne.

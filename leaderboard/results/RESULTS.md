# Wyniki — artefakty trwałe (leaderboard d3-składnia + BPB)

Wszystko potrzebne do reprodukcji leaderboardu. Zapisane na stałe (nie efemeryczne).

## Zawartość

| plik | co to |
|---|---|
| `wyniki-<model>.json` | pełne wyniki d3-składnia-v2 forced-choice per-item (472 par) dla 5 modeli (z `run_forced_choice.py --scorer logprob`) |
| `bpb_perdoc.json` | per-dokument log-prob (nats) każdego modelu na held-oucie BPB + `doc_bytes` — wejście do paired-bootstrap |
| `bpb_stats_report.md` | paired-bootstrap CI (5000×, seed 7): BPB per model + pary w komórce (110M,32000) + MDE |
| `heldout_bpb_sample.jsonl` | **held-out BPB (eval) — 300 docs / 153 583 bajty. NIE TRENOWAĆ NA TYM.** Zdekontaminowany PL (HPLT clean), deterministyczna próbka |
| `bpb_perdoc.py` | skrypt liczący per-doc BPB (provenance) |

## Modele (Hugging Face, org SlayerLab)

- GoLLeM-45M-PL (vocab 32568), GoLLeM-110M-PL-v2 (32000), GoLLeM-110M-PL-v3 (32000), Slayer-110M-PL (32000), pollock-mini-lm-125m (12285, model angielski).

## Narzędzia (Probierz)

- `tools/scorer_hf.py` — LL dowolnego modelu HF → plik (branch: pushnięty na Probierz).
- `tools/run_forced_choice.py` — d3-składnia forced-choice, byte-normalizowany.
- `tools/bpb_scorer.py` — BPB na held-oucie (Probierz branch `bpb-scorer`).

## Wyniki (podsumowanie)

| model | params | vocab | BPB | BPB 95%CI | d3 acc (rdzeń 148) | acc 95%CI |
|---|---|---|---|---|---|---|
| GoLLeM-110M-v3 | 110M | 32000 | 0.988 | [0.957, 1.019] | 0.574 | [0.493, 0.655] |
| Slayer-110M | 110M | 32000 | 1.002 | [0.970, 1.035] | 0.527 | [0.446, 0.608] |
| GoLLeM-110M-v2 | 110M | 32000 | 1.020 | [0.990, 1.051] | 0.507 | [0.426, 0.588] |
| GoLLeM-45M | 45M | 32568 | 1.159 | [1.133, 1.186] | 0.689 | [0.615, 0.764] |
| Polock-125M | 125M | 12285 | 2.279 | [2.250, 2.309] | 0.365 | [0.291, 0.439] |

BPB: niżej=lepiej (kompresja PL, tokenizer-fair). d3 acc: rdzeń 148 par, chance=0.50. Interpretacja + bramki: patrz `../LEADERBOARD.md`.

## Reprodukcja

1. BPB: `python tools/bpb_scorer.py --model <id> --heldout leaderboard/results/heldout_bpb_sample.jsonl` (offline: `HF_HUB_OFFLINE=1`).
2. Paired-bootstrap CI: z `bpb_perdoc.json` (resample indeksów docs, seed 7, 5000×).
3. d3 acc: `scorer_hf.py` → `run_forced_choice.py --scorer logprob` → filtr `headline_core` (148).

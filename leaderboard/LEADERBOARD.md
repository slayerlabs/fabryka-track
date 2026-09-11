# Leaderboard — d3-składnia + BPB (benchmark eksperymentalny)

> ⚠️ **Wewnętrzny, eksperymentalny.** Testowanie metryk i modeli, NIE oficjalny/produktowy ranking (ten żyje osobno na track.fabryka.ai). Benchmark d3-składnia publiczny → spala się po ujawnieniu.

## Dwie osie (dwa różne pytania)

1. **BPB (bits-per-byte) — PRIMARY, ranking dowolnego modelu.** Ile bitów model potrzebuje na TEN SAM surowy bajt TEGO SAMEGO tekstu → tokenizer skraca się w mianowniku (mianownik = BAJTY, nie tokeny). Jedna skala dla każdego vocab (32000/32768/12288/bajty). **To odblokowuje porównanie losowych modeli.** Niżej = lepiej. Standard (Paloma/BLT).
2. **d3-składnia forced-choice acc — CONFIRMING.** Celowany sygnał morfoskładni na rdzeniu 148 par. Dyskretny i szumny na małych modelach (Signal&Noise 2508.13144: BPB/perplexity biją accuracy na sygnał/szum dla małych) → oś potwierdzająca, nie primary.

**BPB rankuje „kto najlepiej MODELUJE polski". Przyczynę (trening A > B) rozstrzyga tylko komórka kontrolowana (same-tok + same-size). Między tokenizerami: badge:confound, nie atrybucja.**

## Held-out BPB (wspólny, zdekontaminowany)

- Źródło: zdekontaminowany held-out PL (HPLT clean), deterministyczna próbka **300 dokumentów / 153 583 bajty**, ten sam surowy zestaw dla WSZYSTKICH modeli.
- BPB = −Σ log₂ P(token | prefiks) / (bajty UTF-8 tekstu). Model losowy bajtowy = 8.0.
- Bramka wejścia: pokrycie tokenizera (round-trip polskich diakrytyków) — dziurawy vocab = gorszy BPB, i słusznie.

## INDISTINGUISHABLE-GATE (obowiązkowa)

1. Komórka kontrolowana = wiersze o tym samym `(tokenizer_vocab, params)`.
2. Wewnątrz komórki A > B TYLKO gdy CI(A) i CI(B) ROZŁĄCZNE. Inaczej „nieodróżnialne przy tej mocy (n=X)".
3. vs chance (dla acc): `>chance`/`~chance`/`<chance` wg położenia całego CI względem 0.50.
4. Między komórkami (inny tokenizer LUB rozmiar): dozwolone, ale badge `confound:tokenizer`/`confound:size` — nigdy czysta atrybucja przyczyny.

## Ranking BPB (primary — dowolne modele, jedna skala)

| # | model | params | tokenizer_vocab | **BPB** ↓ | d3 acc (148) | 95%CI (acc) | controlled | provenance |
|---|---|---|---|---|---|---|---|---|
| 1 | GoLLeM-110M-v3 | 110M | 32000 | **0.988** | 0.574 | [0.493, 0.655] | — | bpb_scorer + rfc @ Probierz |
| 2 | Slayer-110M-PL | 110M | 32000 | **1.002** | 0.527 | [0.446, 0.608] | — | bpb_scorer + rfc @ Probierz |
| 3 | GoLLeM-110M-v2 | 110M | 32000 | **1.020** | 0.507 | [0.426, 0.588] | — | bpb_scorer + rfc @ Probierz |
| 4 | GoLLeM-45M-PL | 45M | 32768 | **1.159** | 0.689 | [0.615, 0.764] | `confound:tokenizer` `confound:size` | bpb_scorer + rfc @ Probierz |
| 5 | Polock (pollock-mini-lm-125m) | 125M | 12288 | **2.279** | 0.365 | [0.291, 0.439] | `confound:tokenizer` (model angielski) | bpb_scorer + rfc @ Probierz |

## Odczyt (ważne — dwie osie się ROZJEŻDŻAJĄ)

- **BPB (kto lepiej modeluje polski):** trzy 110M < 45M < Polock. Większy model = niższy BPB = lepiej modeluje polski. **To potwierdza intuicję „większy lepszy"** i odpowiada na „czy da się porównać losowe modele" — TAK, BPB to jedna skala.
- **d3 grammar acc:** tu 45M wypadł najwyżej (0.689), a 110M w paśmie zgadywania. To NIE zaprzecza BPB — to inny sygnał: 45M gorzej modeluje polski OGÓLNIE (wyższy BPB), ale na tych konkretnych kontrastach gramatycznych trafia lepiej (możliwy efekt jego tokenizera 32768 albo szum przy n=148).
- **Wniosek:** wcześniejsze „45M lepszy" opierało się na szumnej osi acc. BPB (właściwa metryka LM) mówi: **110M > 45M**. Intuicja Arka trafna.
- Komórka `(110M, 32000)` = {v3, Slayer, v2}: różnice BPB małe (0.988–1.020), CI na BPB do policzenia (paired-bootstrap per-item) — do rozstrzygnięcia czy istotne.

## TODO

- [ ] Loader modeli byte-fabryki (arch. BDH, vocab 256) — żeby ranking BPB objął realne modele fabryki (ta sama skala z definicji).
- [ ] **CI na BPB = paired-bootstrap per-item** (BPB ciągłe, nie McNemar) — oś metodologiczna.
- [ ] **MDE-power per komórka** — ile bajtów/par na wykrycie luki X (żeby „nieodróżnialne" = „za mało mocy").
- [ ] Zwiększyć rdzeń d3 do ~400–600 par (moc dla osi confirming).
- [ ] Niezależny byte-verify liczb.

## Jak dodać wpis

1. BPB: `python tools/bpb_scorer.py --model <id> --heldout <held-out.jsonl>` (Probierz).
2. d3 acc: `python tools/scorer_hf.py --model <id> --eval benchmarks/d3-skladnia-v2/eval.jsonl --out ll.jsonl` → `run_forced_choice.py --scorer logprob` → rdzeń (Krok 5).
3. Dopisz wiersz z KOMPLETEM kolumn i zastosuj INDISTINGUISHABLE-GATE. BPB ranking dozwolony między tokenizerami; atrybucja przyczyny tylko w komórce kontrolowanej.

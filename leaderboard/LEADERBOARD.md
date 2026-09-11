# Leaderboard — d3-składnia (benchmark eksperymentalny)

> ⚠️ **Wewnętrzny, eksperymentalny.** Zestawiamy tu wyniki modeli fabryki na eksperymentalnym benchmarku gramatyki polskiej **d3-składnia-v2** — do testowania samego benchmarku, nie jako oficjalny ranking. Benchmark jest publiczny → spala się po ujawnieniu.

## Benchmark (kanoniczny w repo Probierz)

- Pary + flagi: https://github.com/slayerlabs/Probierz/blob/main/benchmarks/d3-skladnia-v2/eval.jsonl
- Instrukcja: https://github.com/slayerlabs/Probierz/blob/main/benchmarks/d3-skladnia-v2/JAK-URUCHOMIC.md
- Narzędzia: `tools/scorer_hf.py`, `tools/run_forced_choice.py` (w Probierz)

## Metryka

- **Wynik = accuracy na rdzeniu (`headline_core`, 148 par)**, byte-normalizowany (BPB-style), forced-choice. Chance = 0.50.
- **95% CI** = bootstrap (2000×). „istotnie > 0.50" = całe CI powyżej zgadywania.

## Zasada porównywalności (twarda)

Wynik zależy od modelu **i** tokenizera. Porównywać wprost można **tylko modele z tym samym tokenizerem**.

- **Modele byte-fabryki (UTF-8 bajty, vocab 256)** mają WSZYSTKIE ten sam tokenizer z definicji → w pełni porównywalne. To sekcja czysta — właściwy leaderboard fabryki.
- **Modele subword (różne vocab)** = referencja; ich różnic NIE wolno przypisywać treningowi/rozmiarowi (confound tokenizera).
- Przy n=148 rozróżniamy tylko różnice > ~0.11; bliżej = „remis".

## Sekcja czysta — modele byte-fabryki (vocab 256, porównywalne)

| model | rozmiar | rdzeń acc (148) | 95% CI | uwagi |
|---|---|---|---|---|
| _(pending)_ | | | | wymaga loadera byte-modeli fabryki (arch. BDH) — patrz „TODO" |

## Sekcja referencyjna — modele subword (tokenizer różny, NIE porównywać wprost)

| model | tokenizer (vocab) | rozmiar | rdzeń acc (148) | 95% CI | werdykt vs chance |
|---|---|---|---|---|---|
| GoLLeM-45M-PL | 32768 | 45M | 0.689 | [0.615, 0.764] | istotnie > 0.50 |
| GoLLeM-110M-v3 | 32000 | 110M | 0.574 | [0.493, 0.655] | w zakresie chance |
| Slayer-110M-PL | 32000 | 110M | 0.527 | [0.446, 0.608] | w zakresie chance |
| GoLLeM-110M-v2 | 32000 | 110M | 0.507 | [0.426, 0.588] | w zakresie chance |
| Polock (pollock-mini-lm-125m) | 12288 | 125M | 0.365 | [0.291, 0.439] | istotnie < 0.50 (model angielski) |

Uwagi:
- GoLLeM-45M ma INNY tokenizer (32768) niż modele 110M (32000) — jego przewagi nie da się czysto przypisać treningowi (confound).
- Trzy modele 110M z tym samym tokenizerem (v2/v3/Slayer) są statystycznie NIEODRÓŻNIALNE przy n=148.
- Polock to model angielski (stąd poniżej zgadywania na polskiej gramatyce).

## TODO

- [ ] Loader modeli byte-fabryki (arch. BDH, vocab 256) — kod inferencji, żeby zapełnić sekcję czystą realnymi modelami fabryki.
- [ ] Zwiększyć rdzeń do ~400–600 par (moc statystyczna: rozróżnianie różnic ~0.05).
- [ ] Niezależna weryfikacja liczb i metodologii.

## Jak dodać wpis

1. Sklonuj Probierz, policz oceny modelu: `python tools/scorer_hf.py --model <id> --eval benchmarks/d3-skladnia-v2/eval.jsonl --out ll.jsonl`
2. `python tools/run_forced_choice.py --eval benchmarks/d3-skladnia-v2/eval.jsonl --scorer logprob --ll-file ll.jsonl --model <nazwa> --outdir wynik/`
3. Policz rdzeń (jednolinijkowiec z `JAK-URUCHOMIC.md` „Krok 5") + CI, dopisz wiersz do właściwej sekcji (czysta = byte-fabryka; referencyjna = subword).

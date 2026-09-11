# Leaderboard — d3-składnia (benchmark eksperymentalny)

> ⚠️ **Wewnętrzny, eksperymentalny.** Wyniki modeli na eksperymentalnym benchmarku gramatyki polskiej **d3-składnia-v2** — do testowania samego benchmarku, NIE oficjalny/produktowy ranking (ten żyje na track.fabryka.ai osobno). Benchmark publiczny → spala się po ujawnieniu.

## Benchmark (kanoniczny w repo Probierz)

- Pary + flagi: https://github.com/slayerlabs/Probierz/blob/main/benchmarks/d3-skladnia-v2/eval.jsonl
- Instrukcja: https://github.com/slayerlabs/Probierz/blob/main/benchmarks/d3-skladnia-v2/JAK-URUCHOMIC.md
- Narzędzia (provenance wyników): `tools/scorer_hf.py` + `tools/run_forced_choice.py` (Probierz@main)

## Metryka

- **Wynik = accuracy na rdzeniu (`headline_core`, n=148)**, byte-normalizowany (BPB-style), forced-choice. Chance = 0.50.
- **95% CI** = bootstrap (2000×).

## INDISTINGUISHABLE-GATE (reguła tablicy — obowiązkowa)

Wejście per wiersz: `acc`, `95%CI`, `n`, `tokenizer_vocab`, `params`.

1. **Komórka kontrolowana** = wiersze o tym samym `(tokenizer_vocab, params)`.
2. Wewnątrz komórki **A > B TYLKO gdy CI(A) i CI(B) są ROZŁĄCZNE.** Inaczej oba wiersze: „nieodróżnialne przy tej mocy (n=X)". Żadnego gołego rankingu.
3. **vs chance:** `>chance` gdy całe CI > 0.50; `<chance` gdy całe < 0.50; inaczej `~chance`.
4. **Między komórkami** (inny tokenizer LUB rozmiar): wynik dozwolony, ale z badge `confound:tokenizer` / `confound:size` — nigdy czysta pozycja. (Dokładnie kejs 45M/32768 vs 110M/32000.)

Byte-norm/BPB domyka parytet METRYKI, ale parytet porównania trzyma tylko WEWNĄTRZ komórki same-tok; między tokenizerami byte-norm jest fair jako liczba, lecz confound danych/treningu zostaje → badge, nie ranking.

## Sekcja czysta — modele byte-fabryki (vocab 256)

Docelowy leaderboard fabryki: wszystkie modele ten sam tokenizer bajtowy → komórki kontrolowane po samym rozmiarze.

| model | params | tokenizer_vocab | byte-norm acc | n | 95%CI | verdict | controlled | provenance |
|---|---|---|---|---|---|---|---|---|
| _(pending)_ | | 256 | | | | | | wymaga loadera byte-modeli (arch. BDH) — patrz TODO |

## Sekcja referencyjna — modele subword

| model | params | tokenizer_vocab | byte-norm acc | n | 95%CI | verdict | controlled | provenance |
|---|---|---|---|---|---|---|---|---|
| GoLLeM-45M-PL | 45M | 32768 | 0.689 | 148 | [0.615, 0.764] | >chance | free · `confound:tokenizer` `confound:size` | scorer_hf+rfc @ Probierz main |
| GoLLeM-110M-v3 | 110M | 32000 | 0.574 | 148 | [0.493, 0.655] | ~chance | same-tok cell (110M/32000) | scorer_hf+rfc @ Probierz main |
| Slayer-110M-PL | 110M | 32000 | 0.527 | 148 | [0.446, 0.608] | ~chance | same-tok cell (110M/32000) | scorer_hf+rfc @ Probierz main |
| GoLLeM-110M-v2 | 110M | 32000 | 0.507 | 148 | [0.426, 0.588] | ~chance | same-tok cell (110M/32000) | scorer_hf+rfc @ Probierz main |
| Polock (pollock-mini-lm-125m) | 125M | 12288 | 0.365 | 148 | [0.291, 0.439] | <chance | free · `confound:tokenizer` (model angielski) | scorer_hf+rfc @ Probierz main |

**Zastosowanie gate:**
- Komórka `(110M, 32000)` = {GoLLeM-110M-v3, Slayer-110M, GoLLeM-110M-v2}: wszystkie CI się NAKŁADAJĄ → **nieodróżnialne przy n=148**. Żadnego rankingu w tej komórce.
- GoLLeM-45M i Polock: inne tokenizery/rozmiar → tylko z badge confound, nie porównywać wprost.
- Werdykty vs chance są ważne niezależnie od komórki: 45M `>chance`, Polock `<chance`, trzy 110M `~chance`.

## TODO

- [ ] Loader modeli byte-fabryki (arch. BDH, vocab 256) — kod inferencji, żeby zapełnić sekcję czystą.
- [ ] **MDE-power per komórka** — ile par w rdzeniu na wykrycie luki X pp (żeby „nieodróżnialne" = „za mało mocy", nie „brak różnicy"). Wejście od osi metodologicznej.
- [ ] Zwiększyć rdzeń do ~400–600 par (moc: rozróżnianie ~0.05).
- [ ] Niezależny byte-verify liczb + potwierdzenie, że gate siedzi w treści (nie tylko intencji).

## Jak dodać wpis

1. Sklonuj Probierz: `python tools/scorer_hf.py --model <id> --eval benchmarks/d3-skladnia-v2/eval.jsonl --out ll.jsonl`
2. `python tools/run_forced_choice.py --eval benchmarks/d3-skladnia-v2/eval.jsonl --scorer logprob --ll-file ll.jsonl --model <nazwa> --outdir wynik/`
3. Policz rdzeń (Krok 5 z `JAK-URUCHOMIC.md`) + bootstrap CI. Dopisz wiersz z KOMPLETEM kolumn (params, tokenizer_vocab, n, CI, controlled, provenance) i zastosuj INDISTINGUISHABLE-GATE. Bez gołego rankingu.

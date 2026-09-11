# Leaderboard — d3-składnia + BPB (benchmark eksperymentalny)

> ⚠️ **Wewnętrzny, eksperymentalny.** Testowanie metryk i modeli, NIE oficjalny/produktowy ranking (ten żyje osobno na track.fabryka.ai). Benchmark d3-składnia publiczny → spala się po ujawnieniu.

> 📦 **Artefakty trwałe:** wszystkie wyniki, dane held-out, statystyki i skrypty w `results/` (patrz `results/RESULTS.md`). Reprodukowalne z bajtów.

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
| 1 | GoLLeM-110M-v3 | 110M | 32000 | **0.988** [0.957, 1.019] | 0.574 | [0.493, 0.655] | cell(110M,32000) | bpb_scorer + rfc @ Probierz |
| 2 | Slayer-110M-PL | 110M | 32000 | **1.002** [0.970, 1.035] | 0.527 | [0.446, 0.608] | cell(110M,32000) | bpb_scorer + rfc @ Probierz |
| 3 | GoLLeM-110M-v2 | 110M | 32000 | **1.020** [0.990, 1.051] | 0.507 | [0.426, 0.588] | cell(110M,32000) | bpb_scorer + rfc @ Probierz |
| 4 | GoLLeM-45M-PL | 45M | 32568 | **1.159** [1.133, 1.186] | 0.689 | [0.615, 0.764] | `confound:tokenizer` `confound:size` | bpb_scorer + rfc @ Probierz |
| 5 | Polock (pollock-mini-lm-125m) | 125M | 12285 | **2.279** [2.250, 2.309] | 0.365 | [0.291, 0.439] | `confound:tokenizer` (model angielski) | bpb_scorer + rfc @ Probierz |

## Odczyt (ważne — dwie osie się ROZJEŻDŻAJĄ)

- BPB: trzy 110M (0.988–1.020) < 45M (1.159) < Polock (2.279). Skala sensowna (Polock=angielski → najgorszy).
- **KOREKTA (dzięki uwadze o cross-cell): ranking BPB między modelami o RÓŻNYCH tokenizerach jest wciąż CROSS-CELL.** 45M (32568) vs 110M (32000) różnią się tokenizer+dane+trening naraz. Więc BPB „110M < 45M" NIE znaczy „110M lepszy rozmiarem/treningiem" — to `badge:confound`, tak samo jak wcześniej „45M best", tylko druga metryka. Nie zamieniamy jednego cross-cell claimu na drugi.
- **Co przeżywa uczciwie:** dwie tok-fair metryki (acc, BPB) rozjeżdżają się KIERUNKIEM → żaden czysty ranking cross-cell nie przeżywa; „45M najlepszy" był nierobustny (szum, Signal&Noise). Twardy A>B TYLKO w komórce kontrolowanej.
- **Jedyna czysta komórka — ROZSTRZYGNIĘTA (na poziomie checkpointów):** (110M, 32000) = {v3, Slayer, v2}. Marginalne CI BPB się nakładają, ALE poprawny test to **paired-bootstrap delta** (patrz niżej): wszystkie 3 pary istotne → **v3 < Slayer < v2**. To uporządkowanie TYCH checkpointów, `caveat:single-seed` — NIE jeszcze wyrok o recepcie (patrz niżej).
- BPB odblokowuje jedno: porównanie DOWOLNYCH modeli na jednej skali „kto modeluje polski" (liczba fair) — ale to ranking modelowania języka, NIE atrybucja przyczyny.

## Komórka kontrolowana (110M, 32000) — paired-bootstrap (5000×, seed 7)

| para | ΔBPB | 95% CI | werdykt |
|---|---|---|---|
| v3 vs Slayer | −0.015 | [−0.019, −0.011] | istotna: v3 < Slayer |
| Slayer vs v2 | −0.018 | [−0.022, −0.014] | istotna: Slayer < v2 |
| v3 vs v2 | −0.032 | [−0.035, −0.030] | istotna: v3 < v2 |

**Ranking CHECKPOINTÓW (stały 110M + tokenizer 32000): v3 < Slayer < v2 — wszystkie pary istotne.** `caveat:single-seed`.

**GRANICA (czego ten CI NIE obejmuje):** paired-bootstrap resampluje DOKUMENTY → łapie niepewność PRÓBKI held-out, NIE niepewność TRENINGU. v2/v3/Slayer to po JEDNYM runie (n=1 seed treningowy). Więc „v3 < Slayer < v2" jest prawdziwe o TYCH checkpointach na TYM held-oucie, ale luka 0.015–0.032 BPB między pojedynczymi runami może być szumem seeda treningowego, nie różnicą recepty. **„Trening/receptura X lepsza" dopiero po ≥3 seedach treningowych** (Gate: ≥3 seedy — tu OTWARTY). Istotne ≠ recepta-lepsza; istotne ≠ duże (0.015 BPB ≈ 1.5%, realny porządek, ale mały — nie „nasz najlepszy trening").

**Uwaga metodologiczna (ważna):** test = paired-delta, NIE nakładanie się marginalnych słupków CI. Marginalne CI modeli się nakładają (stąd wcześniejsze „nieodróżnialne"), ale różnice per-doc są silnie skorelowane (te same dokumenty) → CI różnicy jest wąskie i rozłączne z 0. **MDE** przy n=300: wykrywalna różnica ~0.003 BPB; luka 0.02 BPB wymaga tylko ~9 dokumentów. BPB jest wysoko-mocowa — acc przy n=148 tej komórki NIE rozróżniała.

## Dodatkowa metryka — acc per rodzina zjawiska (d3 rdzeń v2, diagnostyczne)

Profil kompetencji: gdzie model łapie gramatykę. **Diagnostyczne, NIE testowane istotnościowo** — n per rodzina małe (15–42), przedziały szerokie. Cross-tokenizer = confound (jak wyżej); w komórce (110M,32000) porównanie profili jest uczciwsze.

| model | case-prep (21) | case-verb (42) | case-inne (22) | agr-adj (30) | past-rodzaj (18) | aspekt (15) |
|---|---|---|---|---|---|---|
| GoLLeM-45M-PL | 0.52 | 0.83 | 0.59 | 0.87 | 0.61 | 0.40 |
| GoLLeM-110M-v3 | 0.57 | 0.86 | 0.32 | 0.63 | 0.44 | 0.20 |
| GoLLeM-110M-v2 | 0.38 | 0.81 | 0.41 | 0.53 | 0.22 | 0.27 |
| Slayer-110M | 0.33 | 0.76 | 0.41 | 0.67 | 0.22 | 0.40 |
| Polock-125M | 0.43 | 0.38 | 0.55 | 0.43 | 0.22 | 0.00 |

Odczyt (opisowo): **rząd przypadka po czasownikach (case-verb) opanowany przez wszystkie modele PL** (0.76–0.86), Polock (angielski) tam pada (0.38). **Aspekt najtrudniejszy dla wszystkich** (0.0–0.40) — nikt go realnie nie ma. Polock (angielski) słaby wszędzie, aspekt 0.00. To profil „co model umie", nie ranking.

## Kontrole metryki BPB

- **Round-trip/coverage tokenizera (SPRAWDZONE ✓):** dla każdego z 5 modeli encode→decode == oryginał na 100% docs, 0 UNK/1000 tok. Cross-tokenizer BPB nie ma ślepego pola z UNK → **Polock 2.279 to prawdziwe słabe modelowanie PL, nie kara-UNK z vocab 12285.**
- **Dekontaminacja PER MODEL (GRANICA):** BPB mierzy generalizację tylko jeśli held-out NIE był w treningu DANEGO modelu. Nasze (GoLLeM/Slayer) — held-out zdekontaminowany wzgl. NASZYCH danych. **Modele zewnętrzne/losowe: nie znamy ich treningu → BPB może być zawyżone-dobre przez wyciek.** Wpis zewnętrzny MUSI deklarować dekontaminację, inaczej badge `unverified:leak`.

## Bramki statystyczne (numeracja jak w nitce metodologicznej)

- **Gate 1 — ≥3 seedy treningowe (OTWARTY):** wyrok o RECEPCIE wymaga ≥3 seedów treningowych na wariant. paired-bootstrap łapie niepewność próbki held-out, NIE seeda treningowego → do czasu seedów cell-ordering pozostaje na poziomie checkpointów (`caveat:single-seed`), nie recept.
- **Gate 3 — istotność item-level, paired-bootstrap (ZAMKNIĘTY ✓):** komórka (110M,32000) rozstrzygnięta v3<Slayer<v2 (per-doc paired-delta rozłączne z 0). MDE ~0.003 przy n=300; luka 0.02 = ~9 docs.

## TODO

- [ ] Loader modeli byte-fabryki (arch. BDH, vocab 256) — żeby ranking BPB objął realne modele fabryki (ta sama skala z definicji).
- [x] **CI na BPB = paired-bootstrap per-doc — ZROBIONE.** Komórka (110M,32000) rozstrzygnięta: v3<Slayer<v2, wszystkie istotne. MDE: ~0.003 wykrywalne przy n=300; luka 0.02 = ~9 docs.
- [ ] **MDE-power per komórka** — ile bajtów/par na wykrycie luki X (żeby „nieodróżnialne" = „za mało mocy").
- [ ] Zwiększyć rdzeń d3 do ~400–600 par (moc dla osi confirming).
- [ ] Niezależny byte-verify liczb.
- [ ] **Gate 1: ≥3 seedy treningowe** na wariant — żeby cell-ordering podnieść z poziomu checkpointu do poziomu recepty.

## Jak dodać wpis

1. BPB: `python tools/bpb_scorer.py --model <id> --heldout <held-out.jsonl>` (Probierz).
2. d3 acc: `python tools/scorer_hf.py --model <id> --eval benchmarks/d3-skladnia-v2/eval.jsonl --out ll.jsonl` → `run_forced_choice.py --scorer logprob` → rdzeń (Krok 5).
3. Dopisz wiersz z KOMPLETEM kolumn i zastosuj INDISTINGUISHABLE-GATE. BPB ranking dozwolony między tokenizerami; atrybucja przyczyny tylko w komórce kontrolowanej.

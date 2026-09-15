# Mapa task -> jezyk (pl/en/neutral) — FINAL dla #3 "benche podpisane" (Arek)
# Wartownik (mapa) + Hart (taksonomia 3-tag). eval-metadata = wspolna lane.
# 3 tagi bo binarne PL/EN mislabeluje math/meta jako "EN" -> karze PL-model za nie-swoja os (Hart, construct-validity).

## PL (4) — polska kompetencja jezykowa
multiblimp_polish, pl_lm, pl_multiblimp, pl_induction

## EN (15) — angielska kompetencja jezykowa
sciq, arc_easy, arc_challenge, piqa, hellaswag, blimp, lambada_openai, winogrande, boolq,
fast_lm, fast_blimp, fast_supplement, fast_arc, fast_ewok,
bananamind_base_1_1   (zweryfikowane: HF card = "English text-completion benchmark", language:en)

## NEUTRAL (3) — jezyko-agnostyczne (math/meta), NIE tagowac "EN"
arithmark2, arithmark3   (arytmetyka)
int_index                (meta-index Open_SLM_Leaderboard, agregat)

## Suma: 4 + 15 + 3 = 22 (zgodne z live-katalogiem)
## Zasada: badge pl/en/neutral przy kazdym benchu. leaderboard_pl=same pl, leaderboard(EN)=en. math/meta osobno, poza jezykowym rankingiem.

## Zrodlo prawdy w kodzie: src/fabryka_track/task_lang.py (TASK_LANG). Frontend czyta z katalogu, nie hardcoduje.

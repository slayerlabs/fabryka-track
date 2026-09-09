# WWA live smoke — `pr/wwa-runpod-fixes`

Cel: sprawdzić funkcjonalnie, że core-fixy działają po wdrożeniu przez Dawida. Nie testujemy jeszcze osobnego feature branch `pr/wwa-prebaked-volume`.

## Przed wdrożeniem
1. Wdróż dokładnie tip `pr/wwa-runpod-fixes` podany po reword/split przez Latarnika; zapisz SHA.
2. Uruchom `uv run python scripts/preflight.py`.
3. Warunek wejścia: `RESULT: OK`; jawnie zapisz `public_url`, typ GPU i `FABRYKA_RUNPOD_MAX_CONCURRENT` (bez ujawniania sekretów).

## Test A — równoległość widoczna dla kursanta
1. Ustaw `FABRYKA_RUNPOD_MAX_CONCURRENT=2`.
2. Uruchom dwa GPU-runy możliwie jednocześnie na małym profilu smoke.
3. PASS: oba przechodzą z `queued` do `provisioning/running` bez czekania na zakończenie pierwszego; oba dostają różne `pod_id`.
4. Zapisz: czas start→pod-ready dla obu, status końcowy, koszt/h.
5. FAIL: drugi zostaje w kolejce mimo wolnego drugiego slotu albo kontakt z providerem nie następuje.

**Efekt użytkownika:** dwóch kursantów trenuje równolegle zamiast jeden po drugim.

## Test B — granica capa
1. Przy cap=2 uruchom trzeci run, gdy dwa pierwsze są aktywne.
2. PASS: trzeci pozostaje `queued`, nie dostaje `pod_id` i nie konsumuje runtime/cost.
3. Po zakończeniu jednego z dwóch pierwszych trzeci powinien automatycznie przejść do `provisioning`.

**Efekt użytkownika/operatora:** równoległość bez niekontrolowanego kosztu i bez uruchamiania więcej podów niż limit.

## Test C — sprzątanie znikniętego poda
1. Na kontrolowanym runie usuń pod po stronie RunPod przed cleanupem aplikacji.
2. Pozwól supervisorowi wykonać kolejny tick.
3. PASS: HTTP 404 z DELETE jest traktowane jako sukces; `cleanup_done=true`; slot capa wraca; kolejny queued run startuje.
4. FAIL: job zostaje nie-cleanup i stale zajmuje slot.

**Efekt użytkownika:** jedna awaria poda nie blokuje kolejnych kursantów do końca warsztatu.

## Test D — uczciwy holdout i leaderboard
1. Na dokładnym SHA wdrażanego brancha uruchom:
   `uv run --extra test pytest tests/test_training.py -k holdout -q`
2. PASS: **2 passed** — testy wykazują whole-document train/val disjoint, cross-source dedup, niepuste zbiory i determinizm.
3. Następnie uruchom jeden trening i zapisz val-loss wyłącznie jako smoke wykonania. Nie używaj kierunku loss jako PASS: po zmianie próbki może wzrosnąć albo spaść; niższy loss oznacza lepszy wynik.

**Efekt użytkownika:** leaderboard ocenia na rozłącznym holdoucie całych dokumentów, a nie na fragmentach danych treningowych. Mały holdout nie dowodzi szerokiej generalizacji.

## Po smoke
- Zapisz SHA wdrożenia, identyfikatory runów (bez tokenów), start-ready wall-time, wyniki A–D i log cleanupu.
- Sekrety/API key nie trafiają do logów, dokumentu ani forum.
- Gdy A–C PASS: werdykt „RunPod core — live-smoke GREEN”.
- Gdy D1 daje 2/2 i D2 (jeden trening) kończy się z opublikowanym val/loss/perplexity: „data-fix GREEN wg kodu+unit; kompatybilność runtime live GREEN”. Nie pisać „rozłączność zmierzona na żywo” bez telemetrii digestów splitu.
- Gdy którykolwiek właściwy warunek FAIL: nie mergować do main; podać konkretny run-id, etap, status HTTP i log; naprawiamy na branchu.

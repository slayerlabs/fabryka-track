# Zmiany: branch `pr/wwa-runpod-fixes` (fixy pod szkolenie WWA)

Branch zbudowany od `main` (`e279b06`); **main Kacpra nietknięty**. Cel: usunąć realne blockery
uruchomienia równoległych treningów na warsztacie oraz uczciwość metryk. Treść kodu i autorstwo
zweryfikowane z bajtów; wszystkie commity pod kontem właściciela repo. Do przetestowania/mergu przez Kacpra.

## Podsumowanie (dla użytkownika-kursanta)
- **Równoległe treningi** zamiast kolejki jeden-za-drugim.
- **Sprzątanie padniętych podów** nie blokuje już miejsc w limicie.
- **Sprawdzarka (preflight)** mówi PRZED startem, czy GPU w ogóle ruszy.
- **Uczciwy leaderboard** — koniec zawyżania wyników przeciekiem train/val.

## Zmiany szczegółowe

### 1. Równoległość treningów GPU — cap zamiast „jeden pod naraz"
- **Problem:** `gpu_training.py::advance()` puszczał nowego poda tylko gdy żaden inny nie był aktywny →
  przy N kursantach naraz wszyscy serializowali się w kolejce („runpody średnio działają").
- **Zmiana:** twarda bramka single-pod zastąpiona licznikiem z limitem:
  `active = count(inne joby nie-cleanup, nie-queued); if active >= settings.runpod_max_concurrent: return`.
  Nowa opcja `runpod_max_concurrent` (env `FABRYKA_RUNPOD_MAX_CONCURRENT`, domyślnie 4).
- **Efekt:** kursanci trenują równolegle grupami do N; krótsze czekanie.
- **Pliki:** `src/fabryka_track/gpu_training.py`, `src/fabryka_track/settings.py`.

### 2. Guard sprzątania poda przy HTTP 404 (slot-leak)
- **Problem:** gdy pod zniknął po stronie RunPoda, `provider('DELETE', ...)` rzucał 404 → `cleanup_done`
  nigdy nie ustawiane → „martwy" job trzymał slot limitu na stałe → równoległość degradowała do kolejki.
- **Zmiana:** `DELETE` owinięty tym samym guardem co `GET` (404 = sukces sprzątania), `cleanup_done`
  ustawiane bezwarunkowo po bloku.
- **Efekt:** slot zawsze się zwalnia; równoległość trzyma się przez cały warsztat.
- **Pliki:** `src/fabryka_track/gpu_training.py`.

### 3. Preflight konfiguracji RunPod
- **Problem:** kursant klikał „trenuj na GPU" i dostawał cichą porażkę (403 / „Callback unavailable").
- **Zmiana:** `scripts/preflight.py` — sprawdza przed warsztatem i zwraca OK/WARN/FAIL:
  klucz API, dostęp (pusta allow-lista = tylko konta połączone z Hugging Face; ustaw `*` lub listę),
  osiągalność `public_url` (rozróżnia „nieosiągalny" od „widoczny"). Uruchomienie: `uv run python scripts/preflight.py`.
- **Efekt:** operator widzi PRZED szkoleniem, czy GPU ruszy, zamiast odkrywać problem przy kursancie.
- **Uwaga:** probe jest host→URL; wiążący warunek to RunPod-cloud→URL (publiczny/tunelowany URL nadal wymagany).
- **Pliki:** `scripts/preflight.py`.

### 4. Uczciwy split i deduplikacja danych (leaderboard)
- **Problem:** ocena na ostatnich 10% bajtów konkatenacji (przecinała dokumenty w środku) i brak dedup →
  przeciek train/val → zawyżone wyniki i leaderboard.
- **Zmiana:** globalny holdout po content-hashu CAŁYCH dokumentów (granica pustej linii); ranking po
  seeded-hash z `n_val = max(1, docs//10)` → gwarancja niepustego train i val przy ≥2 dokumentach;
  duplikaty treści między źródłami usuwane (wspólny seen-set); fallback 90/10 gdy <2 dokumentów.
- **Efekt:** liczby na leaderboardzie są prawdziwe (będą **niższe** niż wcześniej — bo uczciwe).
- **Pliki:** `src/fabryka_track/training.py`, `src/fabryka_track/runpod_worker.py`.

### 5. Guard throughput przy zerowym czasie (utwardzenie)
- **Problem:** `throughput = seen_tokens / (elapsed)` mógł rzadko trafić `elapsed == 0` na szybkim CPU (flaky).
- **Zmiana:** `seen_tokens / max(elapsed, 1e-3)` — spójne z `runpod_worker.py`. Low-pri hardening, nie blocker.
- **Pliki:** `src/fabryka_track/training.py`.

## Status testów
- **Cała suita `pytest tests/`: 57 przechodzi** (poza 2 pre-existing niżej), odpalone niezależnie na izolowanym klonie (system-torch, CPU).
- `tests/test_gpu_training.py`: **13/13** — w tym nowe testy capa `test_parallel_dispatch_up_to_cap` i `test_capacity_blocks_beyond_cap`; DELETE-guard nie zregresował sprzątania.
- Holdout/dedup: **2/2** (whole-doc disjoint train/val, cross-source dedup, determinizm).
- Guard throughput potwierdzony **N=15 powtórzeń bez flaka** (wcześniejszy „regres" okazał się flaky one-off, nie regresją — potwierdzone bisekcją).
- **NIE zmierzone na żywym RunPod** (wall-time N-parallel vs serial, start-success %, brak pod-leak przy realnym
  crashu) — wymaga klucza RunPod + publicznego `public_url`.
- **Znane, nie nasze:** `test_api` (1.9 vs 1.8 — różnica numeryczna platformy) i `test_benchmark_remote`
  (`KeyError 'id'`) padają również na czystym `main` Kacpra — do zgłoszenia osobno.

## Konfiguracja pod warsztat (przed startem)
- `FABRYKA_RUNPOD_API_KEY` — klucz RunPod.
- `FABRYKA_RUNPOD_ALLOWED_USERS` — `*` lub lista uczestników (inaczej tylko konta HF).
- `FABRYKA_PUBLIC_URL` — publicznie osiągalny adres control-plane (pody raportują tu przez HTTPS).
- `FABRYKA_RUNPOD_MAX_CONCURRENT` — liczba równoległych podów (dobierz pod liczbę kursantów i limit konta RunPod).
- Uruchom `scripts/preflight.py` — powinno dać RESULT: OK.

## Bezpieczeństwo i prowieniencja
- **Skan sekretów całej delty brancha (`e279b06..`): GREEN** — zero kluczy/credów/PII w tym, co trafia do Kacpra (gate bezpieczeństwa).
- **Autorstwo czyste:** wszystkie commity pod kontem właściciela repo; codename agenta usunięty; treść bit-identyczna (tree `df72a811` zgodny hub↔GitHub), potwierdzone niezależnie.
- **Baza nietknięta:** branch zbudowany od `e279b06`; `main` Kacpra bez zmian.
- **Zero-external:** nic z naszej infrastruktury nie zostało wystawione (decyzja właściciela).
- **Pomiar na żywo:** możliwy po wdrożeniu brancha na serwer docelowy (`public_url`, np. `track.fabryka.ai`); pody RunPod raportują do tego serwera, nie wymaga wystawiania niczego naszego.

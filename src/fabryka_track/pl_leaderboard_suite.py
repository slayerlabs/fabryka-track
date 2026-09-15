"""Polish leaderboard suite — a construct-valid ranking separate from the English board.

English and Polish are different competencies. A Polish-first model must not be ranked
against English continuation tasks: it would look weak merely for not being English, which
is a construct-validity error (the metric would stop measuring model quality). This suite
runs the Polish tasks; ranking and diagnostics are split for validity:

- ``multiblimp_polish`` Polish agreement minimal pairs (lm-eval) — RANKING PRIMARY,
  scored as margin over the 50% chance baseline (contamination-resistant, no clamp:
  below-chance stays negative).
- ``pl_induction``      synthetic in-context copy probe — diagnostic (contamination-resistant;
  candidate for a v2 composite once its cross-model behaviour is validated).
- ``pl_multiblimp``     fast agreement pairs — diagnostic.
- ``pl_lm``             out-of-sample Polish bits-per-byte — diagnostic only, shown with a
  "public-Wikipedia, contamination-uncontrolled" label (never a ranking axis).

The task evaluators live in ``fast_pl_ladder`` (the ``pl_*`` tasks) and the lm-eval harness
(``multiblimp_polish``). The public board ranks on ``pl_rank`` (multiblimp margin), NOT on
``fast_pl_ladder.pl_score`` (which stays an internal fast_pl diagnostic). This module holds
only the pinned task set and protocol id, so it imports with no heavy dependencies
(mirrors ``leaderboard_suite`` for the English board).
"""

PROTOCOL = 'track-leaderboard-pl-v1'
TASKS = ['pl_lm', 'pl_multiblimp', 'pl_induction', 'multiblimp_polish']

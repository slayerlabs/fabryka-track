from fabryka_track import benchmarks, task_lang


def test_every_task_reachable_in_a_suite_has_a_language_tag():
    # Drift guard: any task wired into a board must carry a language, else the UI
    # renders a benchmark with no/blank badge (Arek's "podpisane PL/EN" broken).
    reachable = {t for tasks in benchmarks.SUITES.values() for t in tasks}
    untagged = sorted(t for t in reachable if t not in task_lang.TASK_LANG)
    assert untagged == [], f'tasks in SUITES without a language tag: {untagged}'


def test_polish_board_tasks_are_all_tagged_pl():
    # Construct validity: the Polish board must be 100% Polish-language tasks.
    assert all(task_lang.lang_of(t) == 'pl' for t in benchmarks.SUITES['leaderboard_pl'])


def test_tags_are_only_pl_en_or_neutral():
    assert set(task_lang.TASK_LANG.values()) <= {'pl', 'en', 'neutral'}


def test_unknown_task_defaults_to_neutral_never_a_language():
    # Fail-safe: an unknown id is never mislabelled as pl/en (which would judge a
    # model on an axis it was not tested on).
    assert task_lang.lang_of('some_task_not_in_map') == 'neutral'

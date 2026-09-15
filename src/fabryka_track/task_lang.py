"""Task language tags for construct-valid leaderboard display.

Each benchmark task carries the language of its CONTENT, so a Polish-first model
is never shown as weak on an axis that is not its language, and vice versa. Tags:
  'pl'      Polish-language tasks
  'en'      English-language tasks
  'neutral' language-agnostic (arithmetic / symbolic / meta-index)

Single source of truth: the catalog exposes this and the frontend READS it — the
task->language mapping lives here (DATA, owned by eval), never hardcoded in the UI.
Provenance: docs/TASK-LANG-MAP-pl-en.md (Wartownik map + Hart 3-tag taxonomy,
byte-verified; bananamind_base_1_1 = en per HF card "English text-completion
benchmark"; arithmark/int_index = neutral so math/meta is not mislabelled 'en').
"""

TASK_LANG = {
    # PL (4) — Polish language competence
    'multiblimp_polish': 'pl',
    'pl_lm': 'pl',
    'pl_multiblimp': 'pl',
    'pl_induction': 'pl',
    # EN (15) — English language competence
    'sciq': 'en',
    'arc_easy': 'en',
    'arc_challenge': 'en',
    'piqa': 'en',
    'hellaswag': 'en',
    'blimp': 'en',
    'lambada_openai': 'en',
    'winogrande': 'en',
    'boolq': 'en',
    'fast_lm': 'en',
    'fast_blimp': 'en',
    'fast_supplement': 'en',
    'fast_arc': 'en',
    'fast_ewok': 'en',
    'bananamind_base_1_1': 'en',
    # NEUTRAL (3) — language-agnostic (math / meta-index); never tag as a language
    'arithmark2': 'neutral',
    'arithmark3': 'neutral',
    'int_index': 'neutral',
}


def lang_of(task_id):
    """Language tag for a task id.

    Unknown ids default to 'neutral' — fail-safe: an untagged task is never
    mislabelled as a specific language, which would credit/penalise a model on an
    axis it was not tested on.
    """
    return TASK_LANG.get(task_id, 'neutral')

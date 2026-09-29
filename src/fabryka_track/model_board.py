"""Public model leaderboard: one result per model, EN and PL categories (docs/model-board.md)."""
import math

from fastapi import APIRouter, Depends
from sqlalchemy import select

from .database import session_scope
from .leaderboard_result import RESULT_ATTRIBUTE, hf_tree_url, result_from_leaves, validate_result
from .models import Account, BenchmarkEvaluation, Metric, Run, RunAttribute
from .namespaces import PUBLIC_BOARD_ATTRIBUTE, PUBLIC_NOTE_ATTRIBUTE
from .settings import settings
from .tiny_ml_suite import PROTOCOL as TINY_ML_PROTOCOL, REFERENCE as TINY_ML_REFERENCE, finite, scores as tiny_ml_scores

router = APIRouter(prefix='/api/leaderboard')

EN_METRICS = {'eff': 'board/eff', 'arc_easy': 'board/arc_easy', 'blimp': 'board/blimp',
              'wiki_byte_ppl': 'board/wiki_byte_ppl'}
PL_METRICS = {'multiblimp': 'board_pl/multiblimp', 'eff': 'board_pl/eff'}
# Rows the server measured itself ("measured by track"); owners cannot claim this trust level.
TRACK_TRUST = 'track'
TRACK_LABEL = 'latest server evaluation'
TINY_ML_SCALE = (f"tiny_ml {TINY_ML_REFERENCE['revision'][:8]} "
                 f"({TINY_ML_REFERENCE['parameters_min']}–{TINY_ML_REFERENCE['parameters_max'] / 1e6:g}M)")
# Synthetic runs that carry other boards' reference results; they are not track participants.
REFERENCE_ENGINE = 'benchmark-reference'


def _listed(raw):
    return {item.strip() for item in raw.split(',') if item.strip()}


def displayed_trust(claimed, owner, harness_sha, trusted_owners, known_harnesses):
    """The badge the board shows. Owners only declare a claim; the server grants it.

    Rows from accounts outside the trusted list (exact, case-sensitive account names) are always
    self-reported. A trusted row is verified only with a known harness revision (7+ hex prefixes match
    either way), otherwise measured unless it declared itself reported.
    """
    if not owner or owner not in trusted_owners:
        return 'reported'
    if claimed == 'reported':
        return 'reported'
    if claimed == 'verified' and harness_sha and any(
            len(known) >= 7 and (known.startswith(harness_sha) or harness_sha.startswith(known)) for known in known_harnesses):
        return 'verified'
    return 'measured'


def _result(session, run_id):
    rows = session.execute(select(RunAttribute.path, RunAttribute.value).where(
        RunAttribute.run_id == run_id,
        (RunAttribute.path == RESULT_ATTRIBUTE) | RunAttribute.path.startswith(RESULT_ATTRIBUTE + '/', autoescape=True))).all()
    try:
        value = result_from_leaves(rows) if rows else None
        return validate_result(value) if value is not None else None
    except ValueError:
        return None


def _count(value, minimum):
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= minimum else None


def _evaluated_at(evaluation):
    return evaluation.ended_at or evaluation.created_at


def _tiny_ml_values(evaluation, parameters):
    """EN values from the server's Tiny-ML aggregate, on the board scale (accuracies in %), or None."""
    results = evaluation.results or {}
    scored = tiny_ml_scores(results, parameters)
    if scored is None:
        return None
    return {'eff': scored['efficiency'], 'arc_easy': 100 * results['arc_easy']['accuracy'],
            'blimp': 100 * results['blimp']['accuracy'], 'wiki_byte_ppl': results['wikitext']['byte_perplexity']}


def _multiblimp_value(evaluation):
    """MultiBLiMP-pl accuracy in % from a server evaluation that ran it, or None."""
    cell = (evaluation.results or {}).get('multiblimp_polish')
    if 'multiblimp_polish' not in (evaluation.tasks or []) or not isinstance(cell, dict) or cell.get('error'):
        return None
    accuracy = cell.get('accuracy')
    return 100 * accuracy if finite(accuracy) and 0 <= accuracy <= 1 else None


def _track_rows(session, publish_tiny_ml):
    """One row per public finished run from its latest finished full server evaluation.

    EN comes from the Tiny-ML suite (only when the deployment publishes its aggregates), PL from any
    non-private evaluation that ran MultiBLiMP-pl. Only evaluations that counted the checkpoint's weights
    (`parameters_counted`, set by the server) qualify: size and the eff size bonus never come from the run's
    declared config. The latest evaluation fixes the row's checkpoint; the other category is added only when
    its latest evaluation measured the same checkpoint sha.
    """
    evaluations = session.execute(
        select(BenchmarkEvaluation, Run).join(Run, BenchmarkEvaluation.run_id == Run.id).where(
            Run.is_public.is_(True), Run.state == 'finished',
            BenchmarkEvaluation.status == 'finished', BenchmarkEvaluation.mode == 'full')).all()
    evaluations.sort(key=lambda item: (_evaluated_at(item[0]), item[0].created_at, item[0].id))
    latest = {}
    for evaluation, run in evaluations:
        if (run.metadata_ or {}).get('engine') == REFERENCE_ENGINE:
            continue
        provenance = evaluation.provenance or {}
        counted = _count(provenance.get('parameters_counted'), 1)
        if counted is None:
            continue
        if provenance.get('protocol') == TINY_ML_PROTOCOL:
            # The suite is owner-only by default (its evaluations are always marked private).
            if not publish_tiny_ml:
                continue
            category, values = 'en', _tiny_ml_values(evaluation, counted)
        elif provenance.get('visibility') == 'private':
            continue
        else:
            category, values = 'pl', _multiblimp_value(evaluation)
        if values is not None:
            latest.setdefault(run.id, (run, {}))[1][category] = (evaluation, values)
    rows = []
    for run, found in latest.values():
        primary = max(found.values(), key=lambda item: (_evaluated_at(item[0]), item[0].created_at, item[0].id))[0]
        provenance = primary.provenance or {}
        sha = provenance.get('checkpoint_sha256') if isinstance(provenance.get('checkpoint_sha256'), str) else None
        used = {category: item for category, item in found.items()
                if item[0] is primary or (sha and item[0].provenance.get('checkpoint_sha256') == sha)}
        measured = [used[c][0].provenance or {} for c in ('en', 'pl') if c in used]

        def fact(key, minimum):
            # The used evaluations measured one checkpoint; take the first that recorded this fact.
            return next((value for value in (_count(p.get(key), minimum) for p in measured) if value is not None), None)

        n_params = fact('parameters_counted', 1)
        en = {name: None for name in EN_METRICS}
        pl = {name: None for name in PL_METRICS}
        if 'en' in used:
            en.update(used['en'][1])
        if 'pl' in used:
            pl['multiblimp'] = used['pl'][1]
        owner = session.get(Account, run.owner_id) if run.owner_id else None
        opted_in = session.get(RunAttribute, (run.id, PUBLIC_BOARD_ATTRIBUTE))
        note = session.get(RunAttribute, (run.id, PUBLIC_NOTE_ATTRIBUTE))
        rows.append({
            'run_id': run.id, 'name': run.name, 'owner': owner.username if owner else 'Legacy',
            'kind': 'track', 'trust': TRACK_TRUST, 'author': None, 'hf_repo': None, 'revision': None, 'hf_url': None,
            'n_params': n_params, 'tokens_seen': fact('training_tokens', 0), 'checkpoint_sha256': sha,
            'harness': ' + '.join(p['protocol'] for p in measured if isinstance(p.get('protocol'), str)) or None,
            'harness_sha': None, 'scale_rev': TINY_ML_SCALE if 'en' in used else None,
            'step': fact('checkpoint_step', 0), 'label': TRACK_LABEL,
            'evaluated_at': _evaluated_at(primary), 'started_at': run.started_at, 'finished_at': run.ended_at,
            # Same rule as owner rows: the note is public only while the owner opts in to public board metrics.
            'public_note': note.value if (opted_in and opted_in.value is True and note and isinstance(note.value, str)
                                          and note.value) else None,
            'categories': [c for c in ('en', 'pl') if c in used], 'en': en, 'pl': pl,
        })
    return rows


def _values_at(session, run_id, step):
    keys = [*EN_METRICS.values(), *PL_METRICS.values()]
    values = {}
    # Exactly the marked step; a later append at that step supersedes an earlier one.
    for key, value in session.execute(select(Metric.key, Metric.value).where(
            Metric.run_id == run_id, Metric.step == step, Metric.key.in_(keys)).order_by(Metric.id)):
        values[key] = value if math.isfinite(value) else None
    return values


@router.get('/models')
def model_board(session=Depends(session_scope)):
    """Owner-marked results of opted-in runs, then the server's own measurements of every other public run."""
    trusted_owners = _listed(settings.model_board_trusted_owners)
    known_harnesses = {sha.lower() for sha in _listed(settings.model_board_harness_shas)}
    candidates = session.execute(
        select(Run, RunAttribute.value)
        .join(RunAttribute, (RunAttribute.run_id == Run.id) & (RunAttribute.path == PUBLIC_BOARD_ATTRIBUTE))
        .where(Run.state == 'finished', Run.is_public.is_(True))).all()
    rows = []
    for run, opted_in in candidates:
        if opted_in is not True:
            continue
        result = _result(session, run.id)
        if result is None:
            continue
        values = _values_at(session, run.id, result['step'])
        en = {name: values.get(key) for name, key in EN_METRICS.items()}
        pl = {name: values.get(key) for name, key in PL_METRICS.items()}
        categories = [name for name, present in (('en', all(v is not None for v in en.values())),
                                                 ('pl', pl['multiblimp'] is not None)) if present]
        if not categories:
            continue
        external = result['kind'] == 'external'
        owner = session.get(Account, run.owner_id) if run.owner_id else None
        owner_name = owner.username if owner else None
        note = session.get(RunAttribute, (run.id, PUBLIC_NOTE_ATTRIBUTE))
        trusted = bool(owner_name) and owner_name in trusted_owners
        rows.append((trusted, {
            'run_id': run.id, 'name': result['model_name'] if external else run.name,
            'owner': owner_name or 'Legacy', 'kind': result['kind'],
            'trust': displayed_trust(result['trust'], owner_name, result['harness_sha'], trusted_owners, known_harnesses),
            'author': result['author'],
            'hf_repo': result['hf_repo'] if external else None,
            'revision': result['revision'] if external else None,
            'hf_url': hf_tree_url(result['hf_repo'], result['revision']) if external else None,
            'n_params': result['n_params'], 'tokens_seen': result['tokens_seen'],
            'checkpoint_sha256': result['checkpoint_sha256'], 'harness': result['harness'],
            'harness_sha': result['harness_sha'], 'scale_rev': result['scale_rev'], 'step': result['step'],
            'label': result['label'], 'evaluated_at': None, 'started_at': run.started_at, 'finished_at': run.ended_at,
            'public_note': note.value if note and isinstance(note.value, str) and note.value else None,
            'categories': categories, 'en': en, 'pl': pl,
        }))
    # One row per checkpoint. A trusted owner's row wins over anyone else's, then the earliest claim, so a
    # later run that copies a checkpoint sha cannot replace the original row.
    rows.sort(key=lambda item: (not item[0], item[1]['finished_at'] or item[1]['started_at'],
                                item[1]['started_at'], item[1]['run_id']))
    seen, board = set(), []
    for _trusted, row in rows:
        if row['checkpoint_sha256'] not in seen:
            seen.add(row['checkpoint_sha256'])
            board.append(row)
    # A run with its own marked result is never replaced by the server's row, nor is a checkpoint already
    # on the board; among server rows sharing a checkpoint the earliest finished run is kept.
    marked_runs = {row['run_id'] for _trusted, row in rows}
    track = sorted(_track_rows(session, settings.model_board_publish_tiny_ml),
                   key=lambda row: (row['finished_at'] or row['started_at'], row['started_at'], row['run_id']))
    for row in track:
        if row['run_id'] in marked_runs or (row['checkpoint_sha256'] and row['checkpoint_sha256'] in seen):
            continue
        if row['checkpoint_sha256']:
            seen.add(row['checkpoint_sha256'])
        board.append(row)
    board.sort(key=lambda row: (row['finished_at'] or row['started_at'], row['started_at'], row['run_id']), reverse=True)
    return {'models': board}

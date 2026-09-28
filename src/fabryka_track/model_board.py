"""Public model leaderboard: one marked result per model, EN and PL categories (docs/model-board.md)."""
import math

from fastapi import APIRouter, Depends
from sqlalchemy import select

from .database import session_scope
from .leaderboard_result import RESULT_ATTRIBUTE, hf_tree_url, result_from_leaves, validate_result
from .models import Account, Metric, Run, RunAttribute
from .namespaces import PUBLIC_BOARD_ATTRIBUTE, PUBLIC_NOTE_ATTRIBUTE
from .settings import settings

router = APIRouter(prefix='/api/leaderboard')

EN_METRICS = {'eff': 'board/eff', 'arc_easy': 'board/arc_easy', 'blimp': 'board/blimp',
              'wiki_byte_ppl': 'board/wiki_byte_ppl'}
PL_METRICS = {'multiblimp': 'board_pl/multiblimp', 'eff': 'board_pl/eff'}


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
    """Finished public runs whose owner opted into public board metrics and marked a valid result."""
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
            'author': result['author'] if external else None,
            'hf_repo': result['hf_repo'] if external else None,
            'revision': result['revision'] if external else None,
            'hf_url': hf_tree_url(result['hf_repo'], result['revision']) if external else None,
            'n_params': result['n_params'], 'tokens_seen': result['tokens_seen'],
            'checkpoint_sha256': result['checkpoint_sha256'], 'harness': result['harness'],
            'harness_sha': result['harness_sha'], 'scale_rev': result['scale_rev'], 'step': result['step'],
            'label': result['label'], 'started_at': run.started_at, 'finished_at': run.ended_at,
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
    board.sort(key=lambda row: (row['finished_at'] or row['started_at'], row['started_at'], row['run_id']), reverse=True)
    return {'models': board}

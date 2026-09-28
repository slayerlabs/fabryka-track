"""Validation of the `leaderboard/result` run attribute (no server imports).

The owner marks the final checkpoint of a run as its model-board result:
PUT /api/runs/{id}/attributes/leaderboard/result {"value": {...}}. See docs/model-board.md.
The value is validated on write and again whenever the public model board reads it.
"""
import re
import unicodedata

RESULT_ATTRIBUTE = 'leaderboard/result'
RESULT_LABEL = 'final checkpoint (result)'
TRUST_LEVELS = ('verified', 'measured', 'reported')

_SHA256 = re.compile(r'[0-9a-f]{64}')
_HARNESS_SHA = re.compile(r'[0-9a-f]{7,64}')
_REVISION = re.compile(r'[0-9a-f]{7,40}')
_HF_REPO = re.compile(r'(?!\.+/)[A-Za-z0-9._-]{1,96}/(?!\.+$)[A-Za-z0-9._-]{1,96}')
_MAX_STEP = 2**63 - 1  # same bound as series steps
_MAX_COUNT = 2**53 - 1  # exact in JSON/JavaScript numbers

_COMMON = {'step', 'checkpoint_sha256', 'n_params', 'label', 'tokens_seen', 'harness_sha', 'harness',
           'scale_rev', 'kind', 'trust'}
_EXTERNAL = {'model_name', 'author', 'hf_repo', 'revision'}


def _integer(result, key, minimum, maximum, required=True):
    value = result.get(key)
    if value is None and not required:
        return None
    if type(value) is not int or not minimum <= value <= maximum:
        raise ValueError(f'{RESULT_ATTRIBUTE}.{key} must be an integer ≥ {minimum}.')
    return value


def _text(result, key, limit, required=False):
    value = result.get(key)
    if value is None and not required:
        return None
    if not isinstance(value, str) or not value.strip() or len(value) > limit or any(
            ch in '<>' or unicodedata.category(ch)[0] == 'C' or unicodedata.category(ch) in ('Zl', 'Zp')
            for ch in value):
        raise ValueError(f'{RESULT_ATTRIBUTE}.{key} must be plain text of at most {limit} characters '
                         '(no markup or control characters).')
    return value


def _pattern(result, key, pattern, description, required=False):
    value = result.get(key)
    if value is None and not required:
        return None
    if not isinstance(value, str) or not pattern.fullmatch(value):
        raise ValueError(f'{RESULT_ATTRIBUTE}.{key} must be {description}.')
    return value


def hf_tree_url(repo, revision):
    """The only link the board emits for external models; built from validated parts."""
    return f'https://huggingface.co/{repo}/tree/{revision}'


def validate_result(value):
    """Return the normalized result object or raise ValueError describing the violation."""
    if not isinstance(value, dict):
        raise ValueError(f'{RESULT_ATTRIBUTE} must be an object; see docs/model-board.md.')
    kind = value.get('kind', 'track')
    if kind not in ('track', 'external'):
        raise ValueError(f'{RESULT_ATTRIBUTE}.kind must be "track" or "external".')
    allowed = _COMMON | (_EXTERNAL if kind == 'external' else set())
    unknown = sorted(set(value) - allowed)
    if unknown:
        raise ValueError(f'{RESULT_ATTRIBUTE} does not accept {", ".join(unknown)} for kind "{kind}".')
    if value.get('label') != RESULT_LABEL:
        raise ValueError(f'{RESULT_ATTRIBUTE}.label must be "{RESULT_LABEL}".')
    result = {
        'kind': kind,
        'label': RESULT_LABEL,
        'step': _integer(value, 'step', 0, _MAX_STEP),
        'checkpoint_sha256': _pattern(value, 'checkpoint_sha256', _SHA256, '64 lowercase hex characters', True),
        'n_params': _integer(value, 'n_params', 1, _MAX_COUNT),
        'tokens_seen': _integer(value, 'tokens_seen', 0, _MAX_COUNT, required=False),
        'harness_sha': _pattern(value, 'harness_sha', _HARNESS_SHA, '7–64 lowercase hex characters'),
        'harness': _text(value, 'harness', 80),
        'scale_rev': _text(value, 'scale_rev', 40),
    }
    if kind == 'external':
        result.update(model_name=_text(value, 'model_name', 80, required=True),
                      author=_text(value, 'author', 80, required=True),
                      hf_repo=_pattern(value, 'hf_repo', _HF_REPO, 'a Hugging Face repository id "org/name"', True),
                      revision=_pattern(value, 'revision', _REVISION, '7–40 lowercase hex characters', True))
    trust = value.get('trust')
    if trust is None:
        if kind == 'external':
            raise ValueError(f'{RESULT_ATTRIBUTE}.trust is required for external models: "measured" or "reported".')
        trust = 'measured'
    if trust not in TRUST_LEVELS:
        raise ValueError(f'{RESULT_ATTRIBUTE}.trust must be one of {", ".join(TRUST_LEVELS)}.')
    if trust == 'verified' and kind == 'external':
        raise ValueError('External models can be "measured" or "reported", not "verified".')
    if trust == 'verified' and not result['harness_sha']:
        raise ValueError(f'A verified {RESULT_ATTRIBUTE} requires harness_sha.')
    if trust == 'reported' and not result['harness']:
        raise ValueError(f'A reported {RESULT_ATTRIBUTE} must name its harness.')
    result['trust'] = trust
    return result


def result_from_leaves(leaves):
    """Rebuild the stored attribute value from flattened (path, value) leaves at or below RESULT_ATTRIBUTE."""
    exact = [leaf for path, leaf in leaves if path == RESULT_ATTRIBUTE]
    children = [(path[len(RESULT_ATTRIBUTE) + 1:].split('/'), leaf) for path, leaf in leaves
                if path.startswith(RESULT_ATTRIBUTE + '/')]
    if exact and not children:
        return exact[0]
    if exact:
        raise ValueError(f'{RESULT_ATTRIBUTE} is stored inconsistently.')
    tree = {}
    for parts, leaf in children:
        node = tree
        for part in parts[:-1]:
            node = node.setdefault(part, {})
            if not isinstance(node, dict):
                raise ValueError(f'{RESULT_ATTRIBUTE} is stored inconsistently.')
        if parts[-1] in node:
            raise ValueError(f'{RESULT_ATTRIBUTE} is stored inconsistently.')
        node[parts[-1]] = leaf
    return tree


def check_result_write(path, leaves):
    """Validate an attribute write whose flattened leaves may create or replace the result marker."""
    if path.startswith(RESULT_ATTRIBUTE + '/'):
        raise ValueError(f'Assign {RESULT_ATTRIBUTE} as one object; its fields cannot be set separately.')
    touched = [(key, leaf) for key, leaf in leaves
               if key == RESULT_ATTRIBUTE or key.startswith(RESULT_ATTRIBUTE + '/')]
    if not touched:
        return
    value = result_from_leaves(touched)
    if value is not None:  # null withdraws the marker
        validate_result(value)

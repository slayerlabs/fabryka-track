"""Fabryka private Tiny-ML task suite with frozen board normalization."""
import math
import hashlib

from .aci_suite import REPO as ACI_REPO, REVISION as ACI_REVISION

PROTOCOL = 'tiny-ml-en-v2-byte-sliding-aci'
TASKS = ['wikitext', 'blimp', 'arc_easy', 'aci']
REFERENCE_REVISION = '3fce6037267585847b2a1d9f5556c8fd82f7c4ca'
REVISIONS = {
    'nyu-mll/blimp': '877fba0801ffb7cbd8c39c1ff314a46f053f6036',
    'allenai/ai2_arc': '210d026faf9955653af8916fad021475a3f00453',
    'EleutherAI/wikitext_document_level': '647234772b9554e208af6c826f23b99e3cac88c8',
    ACI_REPO: ACI_REVISION,
}
REFERENCE = {'revision': REFERENCE_REVISION, 'wiki_min': 1.86, 'wiki_max': 500,
             'parameters_min': 1000, 'parameters_max': 150_000_000, 'max_size_bonus': .5}


def finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def scores(results, parameters):
    """Keep the original three-component aggregate; require valid ACI eligibility."""
    if any(results.get(task, {}).get('error') for task in TASKS):
        return None
    blimp = results.get('blimp', {}).get('accuracy')
    arc = results.get('arc_easy', {}).get('accuracy')
    wiki = results.get('wikitext', {}).get('byte_perplexity')
    aci = results.get('aci', {}).get('aci_score')
    samples = results.get('aci', {}).get('samples')
    if not finite(aci) or not 0 <= aci <= 100 or not finite(samples) or samples <= 0:
        return None
    if not all(finite(x) for x in (blimp, arc, wiki, parameters)):
        return None
    if not (0 <= blimp <= 1 and 0 <= arc <= 1 and wiki > 0 and parameters > 0):
        return None
    wiki_score = 100 * max(0, min(1, 1 - math.log(min(wiki, 500) / 1.86) / math.log(500 / 1.86)))
    overall = (100 * blimp + 100 * arc + wiki_score) / 3
    size_position = math.log(150_000_000 / parameters) / math.log(150_000_000 / 1000)
    multiplier = 1 + .5 * max(0, min(1, size_position))
    return {'overall': overall, 'efficiency': overall * multiplier,
            'wiki_score': wiki_score, 'size_multiplier': multiplier}


def summarize_wikitext(output):
    metrics = output['results']['wikitext']
    samples = output.get('samples', {}).get('wikitext', [])
    return {'byte_perplexity': metrics['byte_perplexity,none'],
            'bpb': metrics['bits_per_byte,none'],
            'word_perplexity': metrics['word_perplexity,none'],
            'samples': len(samples), 'unit': 'documents',
            'sample_digest': hashlib.sha256('\n'.join(str((x.get('doc_id'), x.get('doc_hash'), x.get('target_hash'))) for x in samples).encode()).hexdigest()}

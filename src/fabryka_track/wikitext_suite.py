"""Document-level WikiText-2 byte metrics; not an external leaderboard attestation."""
import hashlib
import math
from importlib.metadata import version
from itertools import islice

DATASET = 'EleutherAI/wikitext_document_level'
DATASET_CONFIG = 'wikitext-2-raw-v1'
DATASET_REVISION = '647234772b9554e208af6c826f23b99e3cac88c8'
HARNESS_VERSION = '0.4.13'
PROTOCOL = 'wikitext2-v1-lmeval0413-byte-rolling'
SMOKE_DOCUMENTS = 10
CONTEXT_POLICY = 'lm_eval get_rolling_token_windows(context_len=1); model context length; each UTF-8 target byte once; reset at each document; space-byte prefix (32), no EOS'


def provenance(split, mode):
    return {'protocol': PROTOCOL, 'dataset': DATASET, 'dataset_config': DATASET_CONFIG,
            'dataset_split': split, 'dataset_revisions': {DATASET: DATASET_REVISION},
            'evaluator_version': HARNESS_VERSION, 'wikitext_task_version': '2.0',
            'detokenizer': 'lm_eval.tasks.wikitext.preprocess_wikitext.wikitext_detokenizer',
            'context_policy': CONTEXT_POLICY, 'byte_denominator': 'original page UTF-8 bytes before detokenization',
            'limit_per_subtask': SMOKE_DOCUMENTS if mode == 'smoke' else None,
            'external_comparability': 'Not verified: leaderboard entries are self-reported; tokenizer, prefix and context policy can differ.'}


def evaluate(model, mode, split='validation'):
    from datasets import load_dataset
    if mode not in ('smoke', 'full') or split not in ('validation', 'test'):
        raise ValueError('Invalid WikiText evaluation mode or split')
    if version('lm-eval') != HARNESS_VERSION:
        raise RuntimeError('WikiText protocol requires lm-eval==' + HARNESS_VERSION)
    rows = load_dataset(DATASET, DATASET_CONFIG, revision=DATASET_REVISION, split=split, streaming=True)
    if mode == 'smoke':
        rows = islice(rows, SMOKE_DOCUMENTS)
    return score_documents(model, rows) | provenance(split, mode) | {'mode': mode}


def score_documents(model, rows):
    from lm_eval.api.instance import Instance
    from lm_eval.tasks.wikitext.preprocess_wikitext import wikitext_detokenizer
    total_loglikelihood = 0.0
    num_bytes = num_documents = 0
    digest = hashlib.sha256()
    for doc in rows:
        original = doc['page'].encode('utf-8')
        # Length framing preserves document boundaries in the corpus digest.
        digest.update(len(original).to_bytes(8, 'big'))
        digest.update(original)
        request = Instance(request_type='loglikelihood_rolling', doc=doc,
                           arguments=(wikitext_detokenizer(doc),), idx=0)
        value = model.loglikelihood_rolling([request])[0]
        if not math.isfinite(value) or value > 0:
            raise ValueError('Invalid document loglikelihood')
        total_loglikelihood += value
        num_bytes += len(original)
        num_documents += 1
    if not num_bytes or not num_documents:
        raise ValueError('WikiText split has no scoreable bytes')
    nll_per_byte = -total_loglikelihood / num_bytes
    return {'byte_perplexity': math.exp(nll_per_byte), 'bits_per_byte': nll_per_byte / math.log(2),
            'num_bytes': num_bytes, 'num_documents': num_documents,
            'loglikelihood': total_loglikelihood, 'sample_digest': digest.hexdigest()}

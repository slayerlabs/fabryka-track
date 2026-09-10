"""Build an immutable Polish diagnostic pack for small byte-level models; text stays outside Git.

Produces ``fast-pl-v1``: held-out Polish LM text (byte BPB), short-span MultiBLiMP-PL
agreement pairs, and a deterministic synthetic in-context copy probe. Each component is
pinned by dataset revision and content SHA-256 so evaluations stay reproducible.

Usage: python -m scripts.build_fast_pl_ladder [OUTPUT_DIR]
"""
import hashlib
import json
import random
import sys
from pathlib import Path

from datasets import load_dataset
from huggingface_hub import HfApi

SEED = 42
# Keep minimal-pair members short enough to sit inside a tiny byte context. Polish
# diacritics are two UTF-8 bytes, so ~48 bytes is roughly 6-9 words; longer pairs would
# measure truncation, not grammar.
MAX_PAIR_BYTES = 48
INDUCTION_ITEMS = 200


def induction_pairs(n=INDUCTION_ITEMS):
    """Synthetic in-context copy: a symbol A is shown followed by B, then A recurs; the
    model should prefer B (seen continuation) over an unseen distractor. Language-agnostic,
    fully deterministic, no external data."""
    rng = random.Random(SEED)
    alphabet = [chr(c) for c in range(ord('a'), ord('z') + 1)]
    out = []
    for _ in range(n):
        a, b, distract, *fill = rng.sample(alphabet, 6)
        filler = ''.join(rng.choice(fill) for _ in range(rng.randint(2, 5)))
        out.append({'context': f'{a}{b}{filler}{a}', 'good': b, 'bad': distract, 'group': 'induction'})
    return out


def build(folder, held_out_repo='wikimedia/wikipedia', held_out_config='20231101.pl', held_out_split='train'):
    folder.mkdir(parents=True, exist_ok=True)
    manifest = {'protocol': 'fast-pl-v1', 'seed': SEED, 'sources': {}, 'components': {}}
    api = HfApi()

    def save(key, rows, source):
        raw = ('\n'.join(json.dumps(x, ensure_ascii=False) for x in rows) + '\n').encode()
        (folder / (key + '.jsonl')).write_bytes(raw)
        manifest['components'][key] = {'sha256': hashlib.sha256(raw).hexdigest(), 'items': len(rows)}
        manifest['sources'][key] = source
        print(key, len(rows), len(raw), flush=True)

    # pl_lm: held-out Polish text -> byte bits-per-byte.
    rev = api.dataset_info(held_out_repo).sha
    stream = load_dataset(held_out_repo, held_out_config, split=held_out_split, revision=rev, streaming=True)
    chunks = []
    size = 0
    for row in stream:
        text = (row.get('text') or '').strip()
        if not text:
            continue
        chunks.append(text)
        size += len(text.encode()) + 1
        if size >= 1_000_000:
            break
    text = '\n'.join(chunks).encode()[:1_000_000].decode('utf-8', errors='ignore')
    if len(text.encode()) < 500_000:
        raise RuntimeError('Insufficient held-out Polish text')
    save('pl_lm', [{'text': text}], {
        'repo': held_out_repo, 'config': held_out_config, 'split': held_out_split, 'revision': rev,
        'bytes': len(text.encode()),
        'contamination': 'external sample; decontaminate against your own training mix before trusting BPB'})

    # pl_multiblimp: Polish subject-verb agreement minimal pairs, short-span only.
    rev = api.dataset_info('jumelet/multiblimp').sha
    pairs = []
    for row in load_dataset('jumelet/multiblimp', 'pol', split='train', revision=rev):
        good, bad = row['sen'], row['wrong_sen']
        if max(len(good.encode()), len(bad.encode())) <= MAX_PAIR_BYTES:
            pairs.append({'context': '', 'good': good, 'bad': bad, 'group': str(row.get('phenomenon') or 'agreement')})
    random.Random(SEED).shuffle(pairs)
    if not pairs:
        raise RuntimeError('No short-span MultiBLiMP-PL pairs found')
    save('pl_multiblimp', pairs, {
        'repo': 'jumelet/multiblimp', 'config': 'pol', 'split': 'train', 'revision': rev,
        'selection': f'both members <= {MAX_PAIR_BYTES} UTF-8 bytes', 'phenomena': 'subject-verb agreement'})

    # pl_induction: synthetic, deterministic; no external data.
    save('pl_induction', induction_pairs(), {
        'synthetic': True, 'seed': SEED,
        'description': 'in-context copy: after A is shown followed by B, predict B when A recurs'})

    (folder / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2))
    print('manifest', folder / 'manifest.json', flush=True)


if __name__ == '__main__':
    build(Path(sys.argv[1]) if len(sys.argv) > 1 else Path('fast-pl-ladder-v1'))

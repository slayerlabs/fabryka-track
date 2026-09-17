import test from 'node:test';
import assert from 'node:assert/strict';
import { ivmeSources, ivmeWeights, findRecipeDataset, totalShares, validShare, normalizeShares } from '../frontend/src/pages/StudioMixData.ts';

const library = () => ivmeSources.map((s, i) => ({
  id: `source-${i}`, name: s.name, bytes: 10000000,
  source: { kind: 'huggingface', repo: s.repo, config: s.config,
    split: s.split, text_column: s.text_column, revision: 'abc', rules: [] },
}));

test('Ivme source identities preserve exact shares and the story column', () => {
  assert.equal(totalShares(ivmeSources.map(s => s.weight)), 100);
  assert.deepEqual(Object.values(ivmeWeights(library())), [46.67, 27.78, 8.89, 7.78, 5.56, 3.32]);
  assert.equal(ivmeSources[5].text_column, 'story');
  assert.equal(ivmeSources[2].config, 'en');
  assert.equal(ivmeSources[3].config, 'finemath-3plus');
});

test('a recipe cannot silently substitute missing, filtered or wrong-subset text', () => {
  assert.equal(ivmeWeights(library().slice(1)), null);
  for (const patch of [{ config: 'finemath-4plus' }, { split: 'test' }, { text_column: 'prompt' }, { kind: 'upload' }, { contains: 'narrow slice' }, { rules: [{ column: 'score' }] }]) {
    const datasets = library();
    datasets[3].source = { ...datasets[3].source, ...patch };
    assert.equal(ivmeWeights(datasets), null);
  }
  const datasets = library();
  datasets[0].bytes = 100;
  assert.equal(findRecipeDataset(ivmeSources[0], datasets), undefined);
});

test('the recipe chooses the largest eligible import instead of an older starter sample', () => {
  const datasets = library();
  const larger = { ...datasets[0], id: 'larger-source', bytes: 94000000 };
  const filtered = { ...larger, id: 'filtered-source', bytes: 1000000000,
    source: { ...larger.source, contains: 'narrow slice' } };
  const available = [...datasets, larger, filtered];
  const weights = ivmeWeights(available);
  assert.equal(weights['larger-source'], 46.67);
  assert.equal(weights['source-0'], undefined);
  assert.equal(weights['filtered-source'], undefined);
  assert.equal(findRecipeDataset(ivmeSources[0], available.toReversed()).id, 'larger-source');
});

test('centi-percent sums tolerate floating-point noise but reject malformed shares', () => {
  assert.equal(totalShares([46.67, 27.78, 8.89, 7.78, 5.56, 3.32]), 100);
  assert.equal(validShare(46.67), true);
  for (const value of [0, -1, 100.01, 0.001, 46.671, NaN, Infinity]) assert.equal(validShare(value), false);
});

test('normalization fixes over/under allocation without losing hundredths', () => {
  assert.deepEqual(normalizeShares({a: 50, b: 50, c: 50, disabled: 0}), {a: 33.34, b: 33.33, c: 33.33});
  assert.deepEqual(normalizeShares({a: 1, b: 3}), {a: 25, b: 75});
  assert.deepEqual(normalizeShares({a: 0}), {});
  assert.equal(totalShares(Object.values(normalizeShares(ivmeWeights(library())))), 100);
});

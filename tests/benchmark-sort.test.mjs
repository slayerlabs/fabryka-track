import assert from 'node:assert/strict';
import test from 'node:test';
import { compareBenchmarkValues } from '../frontend/src/pages/BenchmarkSort.ts';

test('unavailable scores stay last in both directions without treating zero as missing', () => {
  const rows = [null, 0.8, undefined, 0, NaN, Infinity].map((value, id) => ({ value, id }));
  const sorted = direction => [...rows].sort((a, b) => compareBenchmarkValues(a.value, b.value, direction)).map(row => row.id);
  assert.deepEqual(sorted('asc'), [3, 1, 0, 2, 4, 5]);
  assert.deepEqual(sorted('desc'), [1, 3, 0, 2, 4, 5]);
});

test('model names use natural numeric ordering rather than lexical digit ordering', () => {
  const names = ['Model 10', 'Model 2', 'model 1'];
  assert.deepEqual([...names].sort((a, b) => compareBenchmarkValues(a, b, 'asc')), ['model 1', 'Model 2', 'Model 10']);
  assert.deepEqual([...names].sort((a, b) => compareBenchmarkValues(a, b, 'desc')), ['Model 10', 'Model 2', 'model 1']);
});

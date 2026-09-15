const test = require('node:test');
const assert = require('node:assert/strict');
const { comparisonGroups, plMargin, plDiverges, langBadge, TASK_LANG } = require('../src/fabryka_track/static/published-benchmarks.js');

function plReport(name, acc) {
  return {
    run_id: name, run_name: name, model_size: '250M', owner: 'o', mode: 'full',
    created_at: '2026-09-15T00:00:00Z',
    checkpoint: { checkpoint_sha256: (name + 'x').padEnd(64, '0') },
    evidence: { protocol: 'track-leaderboard-pl-v1', harness_version: 'h', scoring_implementation: 's', fewshot: 0, seed: 42 },
    measurements: [{
      task: 'multiblimp_polish', metric: 'accuracy', value: acc, higher_is_better: true,
      samples: 100, sample_unit: 'examples', sample_digest: 'a'.repeat(64),
      dataset_revisions: { 'jumelet/multiblimp': 'rev' }, task_versions: {}, splits: {},
    }],
  };
}

test('PL board ranks by MultiBLiMP-PL accuracy (= margin order); below-chance sinks to the bottom', () => {
  const groups = comparisonGroups([plReport('mid', 0.60), plReport('top', 0.72), plReport('below', 0.45)], 'multiblimp_polish', 'accuracy');
  assert.equal(groups.length, 1); // one cohort (shared protocol/revisions)
  assert.deepEqual(groups[0][1].map(r => r.report.run_name), ['top', 'mid', 'below']);
});

test('margin over the 50% baseline is (acc-0.5)*2 and is NOT clamped (below-chance stays negative)', () => {
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ~ ${b}`);
  near(plMargin({ value: 0.72 }), 0.44);
  near(plMargin({ value: 0.50 }), 0);
  near(plMargin({ value: 0.45 }), -0.1); // no clamp — honest below-chance signal
  assert.equal(plMargin({}), null);
});

test('language map tags the catalog as 4 PL / 15 EN / 3 neutral (Wartownik FINAL map)', () => {
  const vals = Object.values(TASK_LANG);
  assert.equal(vals.filter(v => v === 'pl').length, 4);
  assert.equal(vals.filter(v => v === 'en').length, 15);
  assert.equal(vals.filter(v => v === 'neutral').length, 3);
  assert.equal(TASK_LANG.multiblimp_polish, 'pl');
  assert.equal(TASK_LANG.bananamind_base_1_1, 'en');   // English continuation, not neutral
  assert.equal(TASK_LANG.arithmark3, 'neutral');       // math is language-neutral
});

test('langBadge renders a labelled badge for known tasks and nothing for unknown', () => {
  assert.match(langBadge('pl_lm'), /PL/);
  assert.match(langBadge('piqa'), /EN/);
  assert.match(langBadge('int_index'), /NEU/);
  assert.equal(langBadge('mystery_task'), '');
});

test('plDiverges enforces the cross-check: flags only when rank margin and pl_induction disagree in direction', () => {
  const acc = v => ({ value: v });
  assert.equal(plDiverges(acc(0.72), acc(0.40)), true);   // rank above chance, cross-check below -> flag
  assert.equal(plDiverges(acc(0.45), acc(0.60)), true);   // rank below chance, cross-check above -> flag
  assert.equal(plDiverges(acc(0.72), acc(0.63)), false);  // both above chance -> no flag
  assert.equal(plDiverges(acc(0.40), acc(0.45)), false);  // both below chance -> no flag
  assert.equal(plDiverges(acc(0.72), {}), false);         // missing cross-check -> no flag (not decoration, but no false alarm)
});

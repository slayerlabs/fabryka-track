import test from 'node:test';
import assert from 'node:assert/strict';
import * as published from '../frontend/src/pages/PublicBenchmarkModel.ts';

const benchmarkFixture = (id, value, overrides={}) => ({id,run_id:id,run_name:id,created_at:'2026-09-15',mode:'full',
  checkpoint:{checkpoint_sha256:id.repeat(64).slice(0,64)},
  evidence:{protocol:'v1',harness_version:'0.4.13',scoring_implementation:'causal',fewshot:0,seed:42},
  measurements:[{task:'piqa',metric:'acc_norm',value,unit:'percent',higher_is_better:true,samples:1838,
    sample_digest:'f'.repeat(64),dataset_revisions:{piqa:'rev'},task_versions:{piqa:1},splits:{piqa:'validation'}}],...overrides});

test('published comparisons keep protocols, metrics, datasets and modes separate',()=>{
  const a=benchmarkFixture('a',.5), b=benchmarkFixture('b',.6), c=benchmarkFixture('c',.9,{mode:'smoke'});
  const d=benchmarkFixture('d',.8);d.measurements[0].dataset_revisions.piqa='other-revision';
  const e=benchmarkFixture('e',.7);e.measurements[0].metric='accuracy';
  const groups=published.comparisonGroups([a,b,c,d,e],'piqa','acc_norm');
  assert.equal(groups.length,3);assert.deepEqual(groups[0][1].map(x=>x.report.id),['b','a']);
  assert.equal(published.comparisonGroups([a,b,c,d,e],'piqa','accuracy')[0][1][0].report.id,'e');
});

test('published comparisons select latest checkpoint result, not the best score',()=>{
  const old=benchmarkFixture('a',.9,{created_at:'2026-09-10'});
  const recent=benchmarkFixture('a',.5,{id:'new',created_at:'2026-09-15'});
  const groups=published.comparisonGroups([old,recent],'piqa','acc_norm');
  assert.equal(groups[0][1].length,1);assert.equal(groups[0][1][0].measurement.value,.5);
});

test('published charts require comparison evidence and order BPB ascending',()=>{
  const missing=benchmarkFixture('a',.5);missing.measurements[0].sample_digest=null;
  assert.equal(published.comparisonGroups([missing],'piqa','acc_norm').length,0);
  const a=benchmarkFixture('a',4),b=benchmarkFixture('b',3);
  for(const r of [a,b])Object.assign(r.measurements[0],{task:'pl_lm',metric:'bpb',unit:'number',higher_is_better:false});
  assert.deepEqual(published.comparisonGroups([a,b],'pl_lm','bpb')[0][1].map(x=>x.report.id),['b','a']);
  assert.equal(published.format({value:0,unit:'percent'}),'0.00%');
  assert.equal(published.format({value:null,unit:'percent'}),'—');
});

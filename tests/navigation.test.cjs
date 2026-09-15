const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync(process.env.TRACK_HTML || 'src/fabryka_track/static/index.html', 'utf8');
const between = (start, end) => html.slice(html.indexOf(start), html.indexOf(end, html.indexOf(start)));
const deferred = () => {let resolve;const promise = new Promise(r => resolve=r);return {promise,resolve};};

test('navigation discards a GET whose JSON arrives after leaving the page', async () => {
  const body = deferred();
  const context = vm.createContext({AbortController, DOMException, fetch: async()=>({ok:true,json:()=>body.promise})});
  vm.runInContext(between('      let navigationController', '      const post')+'\nglobalThis.call=api;globalThis.leave=()=>navigationController.abort();',context);
  const result=context.call('/leaderboard');
  await Promise.resolve();context.leave();body.resolve({models:[]});
  await assert.rejects(result,e=>e.name==='AbortError');
});

test('navigation does not abort a submitted mutation', async () => {
  const body=deferred();let request;
  const context=vm.createContext({AbortController,DOMException,fetch:async(url,opt)=>{request=opt;return {ok:true,json:()=>body.promise};}});
  vm.runInContext(between('      let navigationController', '      const post')+'\nglobalThis.call=api;globalThis.leave=()=>navigationController.abort();',context);
  const result=context.call('/training',{method:'POST'});context.leave();body.resolve({id:'accepted'});
  assert.equal((await result).id,'accepted');assert.equal(request.signal,undefined);
});

for (const change of ['generation++','leaderboardRevision++']) {
  test('late leaderboard response cannot overwrite a newer view: '+change, async()=>{
    const data=deferred();let writes=0;
    const context=vm.createContext({generation:1,api:()=>data.promise,document:{querySelector:()=>null},app:{set innerHTML(value){writes++;}}});
    vm.runInContext(between('      let leaderboardRevision', '      async function route()')+'\nglobalThis.load=leaderboard;',context);
    const result=context.load();vm.runInContext(change,context);data.resolve({models:[]});await result;
    assert.equal(writes,0);
  });
}

test('guide renders six labeled illustrative examples and both loss curves',async()=>{
  let content='';let renders=0;
  const context=vm.createContext({esc:String,chart:series=>{assert.equal(series.length,2);return '<div class="test-chart"></div>';},app:{set innerHTML(v){content=v;}},TrackCharts:{render:async()=>renders++},document:{querySelectorAll:()=>[]}});
  vm.runInContext(between('      const learningExamples', '      function chart(series,key)')+'\nglobalThis.show=trainingGuide;',context);
  await context.show();assert.equal((content.match(/data-guide-group=/g)||[]).length,6);assert.match(content,/All charts below are illustrative/);assert.match(content,/Overfitting/);assert.equal(renders,1);
});


test('all navigation uses document paths with no SPA click or hash listeners',()=>{
  assert.match(html, /href="\/leaderboard" id="nav-leaderboard"/);
  assert.doesNotMatch(html, /href=["']#(?:new|run|leaderboard|guide|account|login)/);
  assert.doesNotMatch(html, /addEventListener\(["'](?:click|hashchange)["']/);
  assert.doesNotMatch(html, /location\.hash\s*=/);
});

test('old run and comparison bookmarks redirect to full pages',()=>{
  for (const legacy of ['run/abc-123','compare/abc,def?metric=val%2Floss','leaderboard']) {
    let target;
    const context=vm.createContext({location:{hash:'#'+legacy,replace:v=>target=v}});
    vm.runInContext(between('      function redirectLegacyBookmark()', '      (async () => {')+'\nglobalThis.redirect=redirectLegacyBookmark;',context);
    assert.equal(context.redirect(),true);assert.equal(target,'/'+legacy);
  }
});

test('cost summary distinguishes estimates, pending billing and reported zero',()=>{
  const context=vm.createContext({esc:String,duration:s=>s+'s'});
  vm.runInContext(between('      function trainingCost(g)', '      function operationalStatus(r)')+'\nglobalThis.render=trainingCost;',context);
  const cost={estimated_usd:0.01234,seconds:120,hourly_usd:0.37,complete:true};
  const pending=context.render({cost});
  assert.match(pending,/\$0.0123 total/);assert.match(pending,/billed: pending/);
  const billed=context.render({cost:{...cost,billed_usd:0,billed_seconds:0,billing_checked_at:'2026-09-09T20:00:00Z'}});
  assert.match(billed,/billed \$0.0000/);
});

test('benchmark panel selectors remain IDs after document navigation migration',()=>{
  assert.doesNotMatch(html, /\$\(['"]\/(?:benchmarks|runs|account)['"]\)/);
  assert.match(html,/\$\('#benchmarks'\)/);
});

test('finished run actions expose the Hugging Face upload control',()=>{
  assert.match(html,/id="hf-upload-trigger"/);
  assert.match(html,/Upload to Hugging Face/);
  assert.match(html,/panel\?\.scrollIntoView/);
});

test('fast ladder shows unavailable EWoK without presenting a combined score',()=>{
  const context=vm.createContext({esc:String,fmt:v=>v==null?'—':String(v)});
  vm.runInContext(between('      function metricHelp(', '      async function trainingGuide()')+between('      function fastLadderResults(e)', '      async function benchmarkDashboard')+'\nglobalThis.render=fastLadderResults;',context);
  const output=context.render({protocol:'fast-en-v1',mode:'full',fast_score:null,results:{fast_lm:{bpb:7,nll:4.85,samples:1000000},fast_blimp:{accuracy:.6,mean_margin_nats:.2,samples:10}}});
  assert.match(output,/FastScore EN: —/);assert.match(output,/HF access required/);assert.match(output,/BPB 7/);assert.match(output,/Accuracy 60\.0%/);
});

test('benchmark dashboard renders history with Fast Ladder in its real lexical scope',async()=>{
  const elements=new Map();
  const $=selector=>{if(!elements.has(selector))elements.set(selector,{innerHTML:''});return elements.get(selector);};
  const evaluation={protocol:'fast-en-v1',mode:'smoke',status:'finished',run_id:'run-1',run_name:'Basic Test',tiny_score:null,fast_score:null,created_at:'2026-09-09T19:00:00Z',results:{fast_blimp:{accuracy:.6,mean_margin_nats:.2,samples:10}}};
  const responses={'/benchmarks/catalog':{core:[],tasks:[],available:true},'/projects':[],
    '/benchmarks/queue':{running:0,waiting:0,items:[]},'/benchmarks/evaluations?limit=20&offset=0':{items:[evaluation],total:1}};
  const context=vm.createContext({$,generation:1,benchmarkTimer:null,app:{innerHTML:''},esc:String,fmt:v=>v??'—',
    api:async path=>{assert.ok(path in responses,path);return responses[path];},clearTimeout:()=>{},setTimeout:()=>1,
    document:{querySelectorAll:()=>[]}});
  vm.runInContext(between('      function metricHelp(', '      async function trainingGuide()')+between('      function fastLadderResults(e)', '      let leaderboardRevision')+'\nglobalThis.render=benchmarkDashboard;',context);
  await context.render();
  assert.match($('#benchmark-history').innerHTML,/Accuracy 60\.0%/);
  assert.match($('#benchmark-history').innerHTML,/FastScore EN: —/);
});

const published = require('../src/fabryka_track/static/published-benchmarks.js');
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
  assert.equal(published.esc('<img src=x onerror=alert(1)>'),'&lt;img src=x onerror=alert(1)&gt;');
});

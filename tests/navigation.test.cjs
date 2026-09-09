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
  await context.show();assert.equal((content.match(/data-guide-group=/g)||[]).length,6);assert.match(content,/Wszystkie wykresy poniżej są ilustracyjne/);assert.match(content,/Przeuczenie/);assert.equal(renders,1);
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
  assert.match(pending,/\$0.0123 USD/);assert.match(pending,/szacowany koszt/);
  assert.match(pending,/Oczekiwanie na rozliczenie/);
  const billed=context.render({cost:{...cost,billed_usd:0,billed_seconds:0,billing_checked_at:'2026-09-09T20:00:00Z'}});
  assert.match(billed,/RunPod naliczył dotąd: <b>\$0.0000 USD/);
});

test('benchmark panel selectors remain IDs after document navigation migration',()=>{
  assert.doesNotMatch(html, /\$\(['"]\/(?:benchmarks|runs|account)['"]\)/);
  assert.match(html,/\$\('#benchmarks'\)/);
});

test('fast ladder shows unavailable EWoK without presenting a combined score',()=>{
  const context=vm.createContext({esc:String,pct:v=>v==null?'—':String(v),fmt:v=>v==null?'—':String(v)});
  vm.runInContext(between('      function fastLadderResults(e)', '      async function benchmarkDashboard')+'\nglobalThis.render=fastLadderResults;',context);
  const output=context.render({protocol:'fast-en-v1',mode:'full',fast_score:null,results:{fast_lm:{bpb:7,nll:4.85,samples:1000000}}});
  assert.match(output,/FastScore EN: —/);assert.match(output,/HF access required/);assert.match(output,/BPB 7/);
});

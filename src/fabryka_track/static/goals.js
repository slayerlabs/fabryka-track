/* Goals and status use the same authenticated, durable Track API. */
(() => {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const stamp = (v) => v ? new Date(v).toLocaleString() : 'Not yet';
  let selected = new URLSearchParams(location.search).get('goal') || '', after = 0, current = null, generation = 0;
  let createKey = '';
  const statusPage = location.pathname === '/status';
  $('#nav-' + (statusPage ? 'status' : 'goal')).setAttribute('aria-current','page');
  document.title = (statusPage ? 'Agent status' : 'Goal') + ' · Fabryka Track';
  if(statusPage){$('#heading').textContent='See what is happening.';$('#intro').textContent='The current goal, the agent’s latest update, and the evidence behind its progress.';}
  async function api(path, body) {
    const r = await fetch('/api' + path, {headers:{'X-Track-Request':'1','Content-Type':'application/json'}, ...(body === undefined ? {} : {method:'POST',body:JSON.stringify(body)})});
    const data = await r.json();
    if(!r.ok){const e=new Error(typeof data.detail==='string'?data.detail:'Request failed. Please check the fields and try again.');e.status=r.status;throw e;}
    return data;
  }
  function error(e){$('#error').textContent=e.message;$('#error').hidden=false;}
  function choose(id){selected=id;after=0;generation++;$('#events').replaceChildren();const u=new URL(location);u.searchParams.set('goal',id);history.replaceState(null,'',u);refresh().catch(error);}
  function renderGoal(g) {
    current = g;
    if(!g){$('#current-panel').innerHTML='<h2>No goal yet</h2><p class="muted">Submit a goal to begin. A connected engine will claim it automatically.</p>';return;}
    const controls = !['completed','failed','cancelled'].includes(g.state);
    const detail = `<div class="row"><h2>Current goal</h2><span class="badge ${g.state==='blocked'?'warning':''}">${esc(g.state)}</span></div><p class="objective">${esc(g.objective)}</p><p class="summary">${esc(g.summary)}</p><p class="muted"><small>Updated ${esc(stamp(g.updated_at))}</small></p>${g.state==='blocked'?'<form id="resume-form"><label for="resume-message">Answer the blocker or describe what changed</label><textarea id="resume-message" maxlength="5000" style="min-height:90px"></textarea><button style="margin-top:12px">Resume goal</button></form>':''}${controls?`<button class="secondary" id="stop-goal" style="margin-top:14px" ${g.state==='stopping'?'disabled':''}>${g.state==='stopping'?'Stopping…':'Stop goal'}</button>`:''}`;
    // Do not destroy a partially written blocker response during polling.
    const key = JSON.stringify([g.id,g.state,g.objective,g.summary]);
    if($('#current-panel').dataset.key!==key){
      const response=$('#resume-message')?.value;
      $('#current-panel').innerHTML=detail;$('#current-panel').dataset.key=key;
      if(response && $('#resume-message'))$('#resume-message').value=response;
      $('#stop-goal')?.addEventListener('click', async e=>{e.target.disabled=true;try{await api('/goals/'+g.id+'/control',{action:'stop'});await refresh();}catch(err){error(err);e.target.disabled=false;}});
      $('#resume-form')?.addEventListener('submit',async e=>{e.preventDefault();const button=e.target.querySelector('button');button.disabled=true;try{await api('/goals/'+g.id+'/control',{action:'resume',message:$('#resume-message').value});await refresh();}catch(err){error(err);button.disabled=false;}});
    }
    $('#run-links').innerHTML=`<a href="/run/${esc(g.run_id)}">Open goal’s Track run →</a>`+(g.linked_runs||[]).map(id=>`<br><a href="/run/${esc(id)}">Training run ${esc(id.slice(0,8))} →</a>`).join('');
  }
  async function refresh() {
    const epoch=generation;
    const data=await api('/goals');if(epoch!==generation)return;
    if(!selected || !data.goals.some(g=>g.id===selected))selected=data.active_id || data.goals[0]?.id || '';
    const engine=data.engine;
    $('#engine-status').innerHTML=engine?`<span class="badge ${engine.online?'':'warning'}">${engine.online?'Connected':'Offline'}</span><p>${esc(engine.name)}</p><small>${esc(engine.runtime||'No runtime connected')}<br>Last heartbeat: ${esc(stamp(engine.heartbeat_at))}</small>`:'<span class="badge warning">Not connected</span><p class="muted">Connect a remote engine to execute goals.</p>';
    $('#connect-engine').disabled=data.goals.some(g=>['running','stopping'].includes(g.state));
    $('#create-panel').hidden=Boolean(data.active_id) || (statusPage && Boolean(data.goals.length));
    if(statusPage && !data.active_id && data.goals.length)$('#intro').innerHTML='Review the latest result, or <a href="/goal">set a new goal</a>.';
    const hist=data.goals.map(g=>`<option value="${esc(g.id)}" ${g.id===selected?'selected':''}>${esc(g.state)} · ${esc(g.objective.slice(0,65))}</option>`).join('');
    if(createKey!==hist){$('#history').innerHTML=hist||'<option>No goals yet</option>';createKey=hist;}
    if(selected){
      const page=await api('/goals/'+selected+'?after='+after);if(epoch!==generation)return;
      renderGoal(page.goal);
      for(const ev of page.events){if(ev.id<=after)continue;const li=document.createElement('li');li.innerHTML=`<small>${esc(stamp(ev.created_at))} · ${esc(ev.kind)}</small><p>${esc(ev.message)}</p>`;$('#events').append(li);after=ev.id;}
      $('#empty-events').hidden=after>0;
      if(page.has_more)setTimeout(()=>refresh().catch(error),0);
    }else renderGoal(null);
    $('#connection').textContent='Live · refreshed '+new Date().toLocaleTimeString();
    $('#error').hidden=true;
  }
  $('#goal-form').addEventListener('submit',async e=>{e.preventDefault();$('#submit-goal').disabled=true;try{const goal=await api('/goals',{objective:$('#objective').value});location.assign('/status?goal='+encodeURIComponent(goal.id));}catch(err){error(err);$('#submit-goal').disabled=false;}});
  $('#history').addEventListener('change',e=>choose(e.target.value));
  $('#connect-engine').addEventListener('click',async e=>{e.target.disabled=true;try{const result=await api('/goal-engine/connect',{name:'Remote goal engine'});$('#credential').value=result.token;$('#credential-panel').hidden=false;}catch(err){error(err);}finally{e.target.disabled=false;}});
  $('#copy-credential').addEventListener('click',async()=>{try{await navigator.clipboard.writeText($('#credential').value);$('#copy-credential').textContent='Copied';}catch(e){$('#credential').select();}});
  (async()=>{
    try{const auth=await api('/auth/me');if(!auth.user){$('#login').hidden=false;$('#account').href='/login';$('#account').textContent='Sign in';return;}$('#account').textContent=auth.user.username;$('#workspace').hidden=false;await refresh();}
    catch(e){error(e);}
    setInterval(()=>refresh().catch(e=>{$('#connection').textContent='Connection interrupted · retrying';error(e);}),3000);
  })();
})();

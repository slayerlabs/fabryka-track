/* Public dataset import UI. No Hugging Face credentials enter this flow. */
window.mountHFDatasets = async function(host, {api, post, esc, onImported, signal}) {
  host.innerHTML = `<details class="panel hf-import" id="hf-import-panel"><summary><b>Import from Hugging Face</b></summary><p class="muted">Paste a public dataset link. No HF connection needed.</p><form id="hf-source-form" class="hf-source"><label class="field"><input name="repo" required aria-label="Dataset URL or owner/name" placeholder="huggingface.co/datasets/owner/dataset"></label><button class="secondary">Continue →</button></form><button class="preview-link" type="button" id="hf-climbmix">Try NVIDIA ClimbMix</button><div id="hf-options"></div><div id="hf-preview" aria-live="polite"></div><p id="hf-message" role="status" aria-live="polite"></p><div id="hf-import-jobs" aria-live="polite"></div></details>`;
  const $ = s => host.querySelector(s), message = s => { $('#hf-message').textContent=s; };
  let info=null, busy=false, pollTimer=null;
  const setBusy = value => {busy=value; host.querySelectorAll('form button, form input, form select, #hf-config, #hf-split').forEach(b=>b.disabled=value);};
  function source() {
    return {repo:$('#hf-source-form').elements.repo.value.trim(),config:$('#hf-config')?.value||null,split:$('#hf-split')?.value||'train'};
  }
  function spec() {
    const f=$('#hf-filter-form');
    return {repo:info.repo,revision:info.revision,config:info.config,split:info.split,
      text_column:f.elements.text_column.value,max_mb:+f.elements.max_mb.value,
      min_chars:+f.elements.min_chars.value,max_chars:+f.elements.max_chars.value,
      contains:f.elements.contains.value,excludes:f.elements.excludes.value,deduplicate:f.elements.deduplicate.checked,
      rules:[...f.querySelectorAll('[data-hf-rule]')].filter(r=>r.querySelector('[name=column]').value).map(r=>({column:r.querySelector('[name=column]').value,operator:r.querySelector('[name=operator]').value,value:r.querySelector('[name=value]').value}))};
  }
  const options = (items,selected) => items.map(x=>`<option value="${esc(x)}" ${x===selected?'selected':''}>${esc(x)}</option>`).join('');
  async function inspect(request) {
    if(busy)return;
    setBusy(true);message('Inspecting public dataset…');$('#hf-options').innerHTML='';$('#hf-preview').innerHTML='';info=null;
    try {
      const data=await post('/hf-datasets/inspect',request);
      if(!host.isConnected)return;
      info=data;
      const texts=data.columns.filter(c=>c.text).map(c=>c.name);
      $('#hf-options').innerHTML=`${data.repo==='nvidia/Nemotron-ClimbMix'?'<p class="muted">English · CC BY-NC 4.0 · non-commercial use</p>':''}${texts.length?`<form id="hf-filter-form"><div class="hf-main-options"><label class="field"><span>Sample size (MB)</span><input name="max_mb" type="number" min="1" max="5000" required value="3000"></label><span class="muted">Up to 5,000 MB · 3,000 MB ≈ 3 GB</span></div><details class="hf-advanced"><summary>Filters & source options</summary><div class="hf-grid"><label class="field"><span>Subset</span><select id="hf-config">${options(data.configs,data.config)}</select></label><label class="field"><span>Split</span><select id="hf-split">${options(data.splits,data.split)}</select></label><label class="field"><span>Text column</span><select name="text_column">${options(texts,texts.includes('text')?'text':texts[0])}</select></label><label class="field"><span>Minimum characters</span><input name="min_chars" type="number" min="1" max="100000" required value="100"></label><label class="field"><span>Maximum characters</span><input name="max_chars" type="number" min="100" max="250000" required value="100000"></label><label class="field"><span>Must contain</span><input name="contains" maxlength="300" placeholder="Optional keyword"></label><label class="field"><span>Must not contain</span><input name="excludes" maxlength="300" placeholder="Optional keyword"></label></div><label><input type="checkbox" name="deduplicate" checked> Remove exact duplicates</label><div id="hf-rules"></div><button type="button" class="preview-link" id="hf-add-filter">+ Add column filter</button><small class="muted" style="display:block">All filters must match. Text matching ignores case.</small><small class="muted" style="display:block;margin-top:8px">Revision ${esc(data.revision.slice(0,12))} · ${esc(data.notice||'Use a training split to keep evaluation data held out.')}</small></details><p class="muted">First matching documents; not a representative sample.</p><div class="hf-actions"><button class="primary">Import dataset</button><button type="button" class="secondary" id="hf-preview-button">Preview</button></div></form>`:'<p>No supported text column found.</p>'}`;
      if($('#hf-config'))$('#hf-config').onchange=()=>inspect(source());
      if($('#hf-split'))$('#hf-split').onchange=()=>inspect(source());
      if(texts.length){
        $('#hf-add-filter').onclick=()=>{
          const rules=$('#hf-rules');if(rules.children.length>=5)return;
          const row=document.createElement('div');row.className='hf-rule';row.setAttribute('data-hf-rule','');
          row.innerHTML=`<select name="column" aria-label="Filter column"><option value="">Column</option>${options(data.columns.map(c=>c.name),'')}</select><select name="operator" aria-label="Filter condition"><option value="equals">Equals</option><option value="contains">Contains</option><option value="gte">At least</option><option value="lte">At most</option></select><input name="value" maxlength="300" aria-label="Filter value" placeholder="Value"><button class="secondary" type="button" aria-label="Remove filter">×</button>`;
          row.querySelector('button').onclick=()=>{row.remove();$('#hf-add-filter').disabled=false;};rules.append(row);$('#hf-add-filter').disabled=rules.children.length>=5;
        };
        $('#hf-preview-button').onclick=async()=>{
          if(!$('#hf-filter-form').reportValidity()||busy)return;
          const selected=spec();setBusy(true);message('Checking the first 200 rows…');
          try {const result=await post('/hf-datasets/preview',selected);if(!host.isConnected)return;
            const s=result.stats;$('#hf-preview').innerHTML=`<p><b>${s.accepted} matches / ${s.scanned} preview rows</b></p>${result.samples.map(t=>`<pre style="white-space:pre-wrap;overflow-wrap:anywhere;max-height:180px;overflow:auto;padding:12px;background:var(--bg)">${esc(t)}</pre>`).join('')}`;message(s.accepted?'Preview ready.':'No matches in the preview. Try less restrictive filters.');
          }catch(e){message(e.message);}finally{setBusy(false);}
        };
        $('#hf-filter-form').onsubmit=async e=>{
          e.preventDefault();if(busy)return;setBusy(true);message('Starting import…');
          try {const job=await post('/hf-datasets/imports',spec());seenActive.add(job.id);message('Importing… You can leave this page.');await refreshJobs();}
          catch(e){message(e.message);}finally{setBusy(false);}
        };
      }
      message('');
    }catch(e){message(e.message);}finally{setBusy(false);}
  }
  $('#hf-source-form').elements.repo.oninput=()=>{info=null;$('#hf-options').innerHTML='';$('#hf-preview').innerHTML='';};
  $('#hf-source-form').onsubmit=e=>{e.preventDefault();inspect({repo:$('#hf-source-form').elements.repo.value.trim()});};
  $('#hf-climbmix').onclick=()=>{$('#hf-source-form').elements.repo.value='nvidia/Nemotron-ClimbMix';inspect({repo:'nvidia/Nemotron-ClimbMix'});};
  let seenActive=new Set();
  async function refreshJobs(){
    clearTimeout(pollTimer);if(!host.isConnected||signal?.aborted)return;
    try {
      const jobs=await api('/hf-datasets/imports');if(!host.isConnected)return;
      const historyOpen=$('#hf-import-history')?.open;
      const renderJob=j=>{const active=['queued','running'].includes(j.state),p=j.progress;return `<div class="hf-job"><div class="hf-job-heading"><b title="${esc(j.config.repo)}">${esc(j.config.repo.split('/').pop())}</b><span>${j.state==='finished'?'Ready':esc(j.state)}</span><small>${((p.bytes||0)/1e6).toFixed(1)} MB · ${(p.accepted||0).toLocaleString()} docs</small></div>${active?`<progress max="${j.config.max_mb||100}" value="${(p.bytes||0)/1e6}" aria-label="Imported megabytes"></progress>`:''}${j.error?`<small role="alert">${esc(j.error)}</small>`:''}</div>`;};
      const activeJobs=jobs.filter(j=>['queued','running'].includes(j.state)),history=jobs.filter(j=>!['queued','running'].includes(j.state));
      $('#hf-import-jobs').innerHTML=activeJobs.map(renderJob).join('')+(history.length?`<details id="hf-import-history" ${historyOpen?'open':''}><summary>Recent imports · ${history.length}</summary>${history.slice(0,5).map(renderJob).join('')}</details>`:'');
      if(jobs.some(j=>j.state==='finished'&&seenActive.has(j.id))){onImported();return;}
      seenActive=new Set(jobs.filter(j=>['queued','running'].includes(j.state)).map(j=>j.id));
      if(seenActive.size){$('#hf-import-panel').open=true;pollTimer=setTimeout(refreshJobs,2000);}
    }catch(e){if(e.name!=='AbortError')message(e.message);}
  }
  signal?.addEventListener('abort',()=>clearTimeout(pollTimer),{once:true});
  await refreshJobs();
};

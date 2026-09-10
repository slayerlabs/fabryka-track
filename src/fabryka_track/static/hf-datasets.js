/* Public dataset import UI. No Hugging Face credentials enter this flow. */
window.mountHFDatasets = async function(host, {api, post, esc, onImported, signal}) {
  host.innerHTML = `<details class="panel" style="margin-top:16px;padding:18px" id="hf-import-panel"><summary><b>Import from Hugging Face</b></summary><p class="muted">Public datasets · no Hugging Face connection needed. Prepare up to 100 MB before starting a GPU run.</p><form id="hf-source-form"><label class="field"><span>Dataset URL or owner/name</span><input name="repo" required placeholder="owner/dataset" value=""></label><div class="actions"><button class="secondary" type="button" id="hf-climbmix">Use NVIDIA ClimbMix</button><button class="primary">Inspect dataset</button></div></form><div id="hf-options"></div><div id="hf-preview" aria-live="polite"></div><p id="hf-message" role="status" aria-live="polite"></p><div id="hf-import-jobs" aria-live="polite"></div></details>`;
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
      $('#hf-options').innerHTML=`<p class="muted">Revision ${esc(data.revision.slice(0,12))} · ${esc(data.notice||'Choose the text column and filter the rows you want to import.')}</p><div class="fields"><label class="field"><span>Subset</span><select id="hf-config">${options(data.configs,data.config)}</select></label><label class="field"><span>Split</span><select id="hf-split">${options(data.splits,data.split)}</select></label></div>${texts.length?`<form id="hf-filter-form"><div class="fields"><label class="field"><span>Text column</span><select name="text_column">${options(texts,texts.includes('text')?'text':texts[0])}</select></label><label class="field"><span>Maximum import size (MB)</span><input name="max_mb" type="number" min="1" max="100" required value="100"></label><label class="field"><span>Minimum characters per document</span><input name="min_chars" type="number" min="1" max="100000" required value="100"></label><label class="field"><span>Maximum characters per document</span><input name="max_chars" type="number" min="100" max="250000" required value="100000"></label><label class="field"><span>Text must contain (optional)</span><input name="contains" maxlength="300"></label><label class="field"><span>Exclude text containing (optional)</span><input name="excludes" maxlength="300"></label></div><label><input type="checkbox" name="deduplicate" checked> Remove exact duplicate documents</label><p class="muted">Optional column filters: all conditions must match. Text matching ignores case.</p>${[0,1].map(i=>`<div class="fields" data-hf-rule><label class="field"><span>Filter ${i+1}: column</span><select name="column"><option value="">No filter</option>${options(data.columns.map(c=>c.name),'')}</select></label><label class="field"><span>Condition</span><select name="operator"><option value="equals">Equals</option><option value="contains">Contains</option><option value="gte">At least (number)</option><option value="lte">At most (number)</option></select></label><label class="field"><span>Value</span><input name="value" maxlength="300" placeholder="e.g. pl or 3"></label></div>`).join('')}<p class="muted">Imports take the first matching whole documents, up to the size, scan or time limit. This is a bounded sample, not a representative sample of the entire dataset. Use training splits to keep evaluation data held out.</p><div class="actions"><button type="button" class="secondary" id="hf-preview-button">Preview filters</button><button class="primary">Import matching documents</button></div></form>`:'<p>No plain-text column found. This importer supports string columns and the official ClimbMix GPT-2 token format.</p>'}`;
      $('#hf-config').onchange=()=>inspect(source());$('#hf-split').onchange=()=>inspect(source());
      if(texts.length){
        $('#hf-preview-button').onclick=async()=>{
          if(!$('#hf-filter-form').reportValidity()||busy)return;
          const selected=spec();setBusy(true);message('Checking the first 200 rows…');
          try {const result=await post('/hf-datasets/preview',selected);if(!host.isConnected)return;
            const s=result.stats;$('#hf-preview').innerHTML=`<p><b>${s.accepted} matching documents / ${s.scanned} scanned rows</b> · ${s.duplicates} duplicates removed</p><small>Preview only; the full import may have a different acceptance rate.</small>${result.samples.map(t=>`<pre style="white-space:pre-wrap;overflow-wrap:anywhere;max-height:180px;overflow:auto;padding:12px;background:var(--bg)">${esc(t)}</pre>`).join('')}`;message(s.accepted?'Preview ready.':'No matches in the preview. Try less restrictive filters.');
          }catch(e){message(e.message);}finally{setBusy(false);}
        };
        $('#hf-filter-form').onsubmit=async e=>{
          e.preventDefault();if(busy)return;setBusy(true);message('Starting import…');
          try {const job=await post('/hf-datasets/imports',spec());seenActive.add(job.id);message('Import started. You can leave this page and return to check progress.');await refreshJobs();}
          catch(e){message(e.message);}finally{setBusy(false);}
        };
      }
      message('Dataset ready. Choose filters, preview, then import.');
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
      $('#hf-import-jobs').innerHTML=jobs.slice(0,5).map(j=>`<div style="border-top:1px solid var(--line);padding:12px 0"><b>${esc(j.config.repo)}</b> · ${esc(j.state)}<p class="muted">${j.progress.scanned||0} rows scanned · ${j.progress.accepted||0} documents · ${((j.progress.bytes||0)/1e6).toFixed(2)} MB${j.progress.stop_reason?' · '+esc(j.progress.stop_reason.replaceAll('_',' ')):''}</p>${j.error?`<p role="alert">${esc(j.error)}</p>`:''}${j.state==='finished'?'<small>Available in your library. Assign mix points to train on it.</small>':''}</div>`).join('');
      if(jobs.some(j=>j.state==='finished'&&seenActive.has(j.id))){onImported();return;}
      seenActive=new Set(jobs.filter(j=>['queued','running'].includes(j.state)).map(j=>j.id));
      if(seenActive.size){$('#hf-import-panel').open=true;pollTimer=setTimeout(refreshJobs,2000);}
    }catch(e){if(e.name!=='AbortError')message(e.message);}
  }
  signal?.addEventListener('abort',()=>clearTimeout(pollTimer),{once:true});
  await refreshJobs();
};

/* Public reports use only the curated, read-only benchmark-results API. */
(function () {
  'use strict';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const format = measurement => finite(measurement.value)
    ? (measurement.unit === 'percent' ? (measurement.value * 100).toFixed(2) + '%' : measurement.unit === 'elo' ? Math.round(measurement.value)+' Elo' : measurement.unit === 'index' ? measurement.value.toFixed(2) : measurement.value.toFixed(3)) : '—';
  const plMargin = measurement => finite(measurement && measurement.value) ? (measurement.value - 0.5) * 2 : null;
  const plMarginText = measurement => { const v = plMargin(measurement); return v === null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(3); };
  const plDiverges = (marginMeas, crosscheckMeas) => { const m = plMargin(marginMeas), c = plMargin(crosscheckMeas); return m !== null && c !== null && ((m > 0 && c < 0) || (m < 0 && c > 0)); };
  const TASK_LANG = {multiblimp_polish:'pl',pl_lm:'pl',pl_multiblimp:'pl',pl_induction:'pl',sciq:'en',arc_easy:'en',arc_challenge:'en',piqa:'en',hellaswag:'en',blimp:'en',lambada_openai:'en',winogrande:'en',boolq:'en',fast_lm:'en',fast_blimp:'en',fast_supplement:'en',fast_arc:'en',fast_ewok:'en',bananamind_base_1_1:'en',arithmark2:'neutral',arithmark3:'neutral',int_index:'neutral'};
  const LANG_META = {pl:['PL','Polish','#1d4ed8'],en:['EN','English','#6b7280'],neutral:['NEU','Language-neutral (math / index)','#0f766e']};
  const langBadge = task => { const l = TASK_LANG[task]; if (!l) return ''; const [label,title,bg] = LANG_META[l]; return `<span class="lang-badge" title="${title}" style="background:${bg};color:#fff;font-size:11px;padding:1px 6px;border-radius:10px;margin-left:6px;vertical-align:middle">${label}</span>`; };
  const announce = message => { const el = typeof document !== 'undefined' && document.querySelector('#control-status'); if (el) el.textContent = message; };
  const canonical = value => JSON.stringify(value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, JSON.parse(canonical(value[key]))])) : value);
  function cohortKey(report, measurement) {
    const p = report.evidence;
    if (!/^[a-f0-9]{64}$/.test(measurement.sample_digest || '') || !finite(measurement.samples) || measurement.samples <= 0 ||
        !p.protocol || !p.harness_version || !p.scoring_implementation || !finite(p.fewshot) || !finite(p.seed) ||
        !Object.keys(measurement.dataset_revisions).length) return null;
    return canonical({mode: report.mode, task: measurement.task, metric: measurement.metric,
      protocol: p.protocol, harness: p.harness_version, scoring: p.scoring_implementation,
      fewshot: p.fewshot, seed: p.seed, samples: measurement.samples, sample_unit: measurement.sample_unit || 'examples', digest: measurement.sample_digest,
      revisions: measurement.dataset_revisions, versions: measurement.task_versions, splits: measurement.splits});
  }
  function comparisonGroups(reports, task, metric) {
    const groups = new Map();
    // Keep the latest measurement for a checkpoint within one recorded setup.
    const latest = [...reports].sort((a,b) => String(b.created_at).localeCompare(String(a.created_at)));
    for (const report of latest) for (const measurement of report.measurements) {
      if (measurement.task !== task || measurement.metric !== metric || !finite(measurement.value)) continue;
      const key = cohortKey(report, measurement);
      if (!key) continue;
      if (!groups.has(key)) groups.set(key, []);
      const rows = groups.get(key), checkpoint = report.checkpoint.checkpoint_sha256 || report.run_id;
      if (!rows.some(row => (row.report.checkpoint.checkpoint_sha256 || row.report.run_id) === checkpoint)) rows.push({report, measurement});
    }
    for (const rows of groups.values()) rows.sort((a,b) => (a.measurement.higher_is_better ? -1 : 1) *
      (a.measurement.value - b.measurement.value) || a.report.run_name.localeCompare(b.report.run_name));
    return [...groups.entries()].sort((a,b) => b[1].length - a[1].length);
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = {format, cohortKey, comparisonGroups, esc, plMargin, plDiverges, langBadge, TASK_LANG};
  if (typeof document === 'undefined') return;
  const $ = selector => document.querySelector(selector);
  let reports = [], page = 0, revision = 0;
  const perPage = 6;
  const date = value => value ? new Date(value + (/Z|[+-]\d\d:\d\d$/.test(value) ? '' : 'Z')).toLocaleDateString(undefined, {year:'numeric',month:'short',day:'numeric'}) : 'Not recorded';
  const number = value => finite(value) ? value.toLocaleString() : 'Not recorded';
  function filtered() {
    const query = $('#model-search').value.toLowerCase().trim(), size = $('#size-filter').value;
    return reports.filter(r => (!size || r.model_size === size) && (!query || (r.run_name+' '+r.owner).toLowerCase().includes(query)));
  }
  function reportHTML(r) {
    const cp = r.checkpoint, p = r.evidence;
    const evidence = {...p, datasets:r.measurements.map(m => ({benchmark:m.benchmark,metric:m.metric,
      sample_digest:m.sample_digest,dataset_revisions:m.dataset_revisions,task_versions:m.task_versions,splits:m.splits}))};
    return `<article class="panel report" id="evaluation-${esc(r.id)}"><div class="report-heading"><div>
      <div class="eyebrow">${esc(r.owner)} · ${esc(r.model_size || 'Size not recorded')} · ${number(cp.parameters)} parameters</div>
      <h3><a href="${esc(r.run_url)}">${esc(r.run_name)}</a></h3>
      <small>Checkpoint step ${number(cp.checkpoint_step)} · evaluated ${date(r.ended_at || r.created_at)}</small>
      </div><span class="report-tag">${r.mode === 'full' ? 'Full evaluation' : 'Smoke test · diagnostic'}</span></div>
      <div class="table-scroll"><table><caption class="muted" style="text-align:left;padding-bottom:10px">Recorded checkpoint results</caption><thead><tr><th>Benchmark</th><th>Result</th><th>Metric</th><th>Samples</th></tr></thead><tbody>
      ${r.measurements.map(m => `<tr><td>${esc(m.benchmark)}${langBadge(m.task)}</td><td>${format(m)}</td><td class="metric-label">${esc(m.metric_label)}</td><td>${number(m.samples)}${m.sample_unit !== 'examples' ? ' '+esc(m.sample_unit) : ''}</td></tr>`).join('') || '<tr><td colspan="4">No supported numeric metrics were recorded.</td></tr>'}
      </tbody></table></div><details class="evidence"><summary>Checkpoint & evaluation evidence</summary>
      <dl><dt>Checkpoint SHA-256</dt><dd>${esc(cp.checkpoint_sha256 || 'Not recorded')}</dd><dt>Training tokens</dt><dd>${number(cp.training_tokens)} ${esc(cp.token_unit || '')}</dd><dt>Context length</dt><dd>${number(cp.context_length)} ${esc(cp.token_unit || 'tokens')}</dd><dt>Harness</dt><dd>${esc(p.harness_version || 'Not recorded')}</dd><dt>Few-shot / seed</dt><dd>${number(p.fewshot)} / ${number(p.seed)}</dd><dt>Scoring</dt><dd>${esc(p.scoring || 'Not recorded')}</dd></dl>
      <pre>${esc(JSON.stringify(evidence,null,2))}</pre></details>
      <div class="report-links"><a href="${esc(r.run_url)}">Open model & try inference →</a><a href="${esc(r.source_url)}" download="benchmark-${esc(r.id)}.json">Download result JSON ↓</a></div></article>`;
  }
  function chooseMetric() {
    const task = $('#benchmark-filter').value;
    const available = new Set(filtered().flatMap(r => r.measurements.filter(m => m.task === task).map(m => m.metric)));
    for (const option of $('#metric-filter').options) option.disabled = !available.has(option.value);
    if (!available.has($('#metric-filter').value)) $('#metric-filter').value = [...$('#metric-filter').options].find(option => !option.disabled)?.value || '';
  }
  function renderChart() {
    const matching = filtered(), task = $('#benchmark-filter').value, metric = $('#metric-filter').value;
    if ($('#mode-filter').value === 'smoke') {
      $('#cohort-label').hidden = true;
      $('#comparison-chart').innerHTML = '<p class="muted">Smoke measurements are available in the checkpoint tables below. Use full evaluations for model comparisons.</p>';
      return;
    }
    const groups = comparisonGroups(matching, task, metric), previous = $('#cohort-filter').value;
    $('#cohort-label').hidden = groups.length < 2;
    $('#cohort-filter').innerHTML = groups.map(([key,rows], i) => `<option value="${esc(key)}">Setup ${i+1} · ${rows.length} checkpoints · ${number(rows[0].measurement.samples)} ${esc(rows[0].measurement.sample_unit || 'examples')} · harness ${esc(rows[0].report.evidence.harness_version)}</option>`).join('');
    if (groups.some(([key]) => key === previous)) $('#cohort-filter').value = previous;
    const selected = groups.find(([key]) => key === $('#cohort-filter').value)?.[1] || groups[0]?.[1] || [];
    const available = matching.flatMap(r => r.measurements).filter(m => m.task === task && m.metric === metric).length;
    if (!selected.length) {
      $('#comparison-chart').innerHTML = `<p class="muted">${available ? 'These results lack some of the provenance needed to group a comparison. Their recorded values remain in the tables below.' : 'No recorded results for this benchmark and metric in the selected models. Choose another metric or benchmark.'}</p>`;
      return;
    }
    const visible = selected.slice(0,12), first = visible[0], min=Math.min(0,Math.floor(Math.min(...visible.map(x=>x.measurement.value)))), max = first.measurement.unit === 'percent' ? 1 : Math.max(1, Math.ceil(Math.max(...visible.map(x => x.measurement.value))));
    $('#comparison-chart').innerHTML = `<p class="chart-protocol">${esc(first.report.evidence.protocol)} · ${number(first.measurement.samples)} ${esc(first.measurement.sample_unit || 'examples')} · ${first.report.evidence.fewshot}-shot · ${first.measurement.higher_is_better ? 'higher' : 'lower'} is better · scale ${min}–${first.measurement.unit === 'percent' ? '100%' : max}</p>
      ${visible.map(({report:r,measurement:m}) => `<div class="chart-row"><div class="chart-name"><a href="${esc(r.run_url)}">${esc(r.run_name)}</a><small>${esc(r.owner)} · ${esc(r.model_size || '')} · step ${number(r.checkpoint.checkpoint_step)}</small></div><div class="bar-track" aria-hidden="true"><div class="bar-fill" style="margin-left:${(Math.min(0,m.value)-min)/(max-min)*100}%;width:${Math.abs(m.value)/(max-min)*100}%"></div></div><span class="chart-value">${format(m)}</span></div>`).join('')}
      <p class="chart-note">${selected.length > 12 ? 'Top 12 of '+selected.length : selected.length} checkpoints in this recorded setup. The latest result per checkpoint is used. Other setups and results without complete comparison evidence remain in the reports below.</p>`;
  }
  function render() {
    const matching = filtered(), checkpoints = new Set(matching.map(r => r.checkpoint.checkpoint_sha256 || r.run_id)), tasks = new Set(matching.flatMap(r => r.measurements.map(m => m.task)));
    const ranked=$('#mode-filter').value==='full' ? comparisonGroups(matching,'int_index','index')[0]?.[1] || [] : [];
    $('#full-leaderboard').hidden=!ranked.length;
    const columns=[['INT Index','int_index','index'],['ARC Easy','arc_easy','acc_norm'],['ARC Challenge','arc_challenge','acc_norm'],['PIQA','piqa','acc_norm'],['HellaSwag','hellaswag','acc_norm'],['ArithMark 3','arithmark3','acc_norm'],['ArithMark 2','arithmark2','accuracy'],['BananaMind 1.1','bananamind_base_1_1','elo']];
    $('#leaderboard-table').innerHTML=ranked.length ? `<table><thead><tr><th>Rank</th><th>Model</th>${columns.map(c=>`<th>${esc(c[0])}</th>`).join('')}</tr></thead><tbody>${ranked.map(({report:r},i)=>`<tr><td>${i+1}</td><td><a href="${esc(r.run_url)}">${esc(r.run_name)}</a><br><small>${esc(r.model_size)} · ${esc(r.owner)}</small></td>${columns.map(([,task,metric])=>`<td>${format(r.measurements.find(m=>m.task===task && m.metric===metric)||{})}</td>`).join('')}</tr>`).join('')}</tbody></table>` : '';
    const rankedPL = $('#mode-filter').value==='full' ? comparisonGroups(matching,'multiblimp_polish','accuracy')[0]?.[1] || [] : [];
    $('#pl-leaderboard').hidden=!rankedPL.length;
    const plCols=[['pl_induction · cross-check','pl_induction','accuracy'],['pl_lm BPB ⚠ · diag','pl_lm','bpb'],['pl_multiblimp · diag','pl_multiblimp','accuracy']];
    $('#pl-leaderboard-table').innerHTML=rankedPL.length ? `<table><thead><tr><th>Rank</th><th>Model</th><th>MultiBLiMP-PL margin</th>${plCols.map(c=>`<th>${esc(c[0])}</th>`).join('')}</tr></thead><tbody>${rankedPL.map(({report:r},i)=>{const mm=r.measurements.find(m=>m.task==='multiblimp_polish'&&m.metric==='accuracy')||{};const im=r.measurements.find(m=>m.task==='pl_induction'&&m.metric==='accuracy')||{};const flag=plDiverges(mm,im);return `<tr><td>${i+1}</td><td><a href="${esc(r.run_url)}">${esc(r.run_name)}</a><br><small>${esc(r.model_size)} · ${esc(r.owner)}</small></td><td${flag?' title="rank margin and pl_induction cross-check disagree in direction — ranking validity questionable"':''}>${flag?'⚑ ':''}${esc(plMarginText(mm))}</td>${plCols.map(([,task,metric])=>`<td>${format(r.measurements.find(m=>m.task===task && m.metric===metric)||{})}</td>`).join('')}</tr>`;}).join('')}</tbody></table>` : '';
    $('#stats').innerHTML = [[matching.length,$('#mode-filter').value === 'full' ? 'full evaluations' : 'smoke evaluations'],[checkpoints.size,'saved checkpoints'],[tasks.size,'benchmark tasks with results']].map(([value,label]) => `<div class="stat"><strong>${value}</strong><small>${label}</small></div>`).join('');
    $('#smoke-notice').hidden = $('#mode-filter').value !== 'smoke';
    const previous = $('#benchmark-filter').value, names = new Map(matching.flatMap(r => r.measurements.map(m => [m.task,m.benchmark])));
    $('#benchmark-filter').innerHTML = [...names].sort((a,b) => a[1].localeCompare(b[1])).map(([key,label]) => `<option value="${esc(key)}">${esc(label)}</option>`).join('');
    if (names.has(previous)) $('#benchmark-filter').value = previous;
    else if (names.has('int_index')) $('#benchmark-filter').value = 'int_index';
    else if (names.has('piqa')) $('#benchmark-filter').value = 'piqa';
    page = Math.min(page,Math.max(0,Math.ceil(matching.length/perPage)-1));
    $('#reports').innerHTML = matching.slice(page*perPage,(page+1)*perPage).map(reportHTML).join('') || '<div class="panel empty"><h3>No matching published results</h3><p class="muted">Try another model or evaluation scope. Completed evaluations appear here when their run is public.</p><a href="/benchmarks">Open the evaluation studio →</a></div>';
    $('#result-count').textContent = matching.length+' reports · newest first';
    $('#previous').disabled = page === 0;
    $('#next').disabled = (page+1)*perPage >= matching.length;
    $('#page-number').textContent = matching.length ? 'Page '+(page+1)+' of '+Math.ceil(matching.length/perPage) : '0 reports';
    chooseMetric();renderChart();
    announce(`Showing ${matching.length} report${matching.length===1?'':'s'} · scope ${$('#mode-filter').value} · Polish board: ${rankedPL.length} model${rankedPL.length===1?'':'s'}`);
  }
  async function load() {
    const version = ++revision, mode = $('#mode-filter').value;
    $('#load-status').textContent = 'Loading published results…';$('#load-status').hidden = false;$('#loaded').hidden = true;
    try {
      let items = [], offset = 0, total;
      do {
        const response = await fetch('/api/benchmark-results?mode='+mode+'&limit=100&offset='+offset, {cache:'no-store'});
        if (!response.ok) throw new Error('Published results could not be loaded.');
        const data = await response.json();if (version !== revision) return;
        items.push(...data.items);offset += data.items.length;total = data.total;
        if (!data.items.length) break;
      } while(offset < total);
      reports = items;page = 0;
      const previous = $('#size-filter').value;
      $('#size-filter').innerHTML = '<option value="">All sizes</option>'+[...new Set(reports.map(r => r.model_size).filter(Boolean))].sort((a,b) => parseFloat(a)-parseFloat(b)).map(size => `<option value="${esc(size)}">${esc(size.toUpperCase())}</option>`).join('');
      if (reports.some(r => r.model_size === previous)) $('#size-filter').value = previous;
      $('#load-status').hidden = true;$('#loaded').hidden = false;render();
    } catch(error) {
      if (version !== revision) return;
      $('#load-status').innerHTML = '<div class="load-error">Could not load published results. <button class="secondary" id="retry">Try again</button></div>';
      $('#retry').onclick = load;
    }
  }
  $('#model-search').oninput = $('#size-filter').onchange = () => {page=0;render();};
  $('#mode-filter').onchange = load;
  $('#benchmark-filter').onchange = () => {chooseMetric();renderChart();announce('Comparison benchmark: '+$('#benchmark-filter').value);};
  $('#metric-filter').onchange = $('#cohort-filter').onchange = () => {renderChart();announce('Comparison updated');};
  $('#previous').onclick = () => {page--;render();$('#results').scrollIntoView();};
  $('#next').onclick = () => {page++;render();$('#results').scrollIntoView();};
  async function campaignStatus() {
    try {
      const response=await fetch('/api/benchmark-results/campaign-status',{cache:'no-store'});
      if (!response.ok) return;
      const data=await response.json(), element=$('#campaign-status');
      element.hidden=!data.total;
      if (data.total) element.textContent=`Full benchmark campaign: ${data.states.finished} / ${data.total} checkpoints complete · ${data.states.running} running · ${data.states.queued} queued${data.states.failed ? ' · '+data.states.failed+' failed' : ''}. Jobs use our existing GPU when it is available.`;
    } catch (_) { /* The completed result reports remain independently available. */ }
  }
  campaignStatus();setInterval(campaignStatus,30000);
  load();
})();

/* Fabryka metric explorer. Plotly is only the local rendering engine. */
window.TrackCharts = (() => {
  const palette=['#b35236','#477f72','#5e80bf','#ae76ac','#bc943f','#609cad','#8e9b4e','#a16d68','#7b6bb0','#4a9584'];
  const escape=v=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const number=v=>Number.isFinite(v)?new Intl.NumberFormat('en',{maximumFractionDigits:4,notation:Math.abs(v)>=10000?'compact':'standard'}).format(v):'—';
  const icons={settings:'<path d="M4 7h16M4 17h16"/><circle cx="8" cy="7" r="2"/><circle cx="16" cy="17" r="2"/>',expand:'<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>',reset:'<path d="M3 10a9 9 0 1 1 2 8M3 4v6h6"/>',download:'<path d="M12 3v12m-4-4 4 4 4-4M4 16v5h16v-5"/>',close:'<path d="m6 6 12 12M6 18 18 6"/>'};
  const icon=name=>`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]}</svg>`;
  const placeholder=(series,key)=>`<div class="interactive-chart" data-chart-key="${escape(key||series.map(s=>s.id||s.name).join('|'))}" data-series="${escape(JSON.stringify(series))}"></div>`;
  const label=name=>({'throughput/tokens_sec':'Byte tokens / sec','training/tokens_seen':'Training tokens','train/loss':'Training loss','val/loss':'Validation loss','val/perplexity':'Perplexity'})[name]||name;
  function legend(el){
    const {series,settings}=el.chart;
    el.querySelector('.plot-legend').innerHTML=series.map((s,i)=>`<button class="plot-series ${settings.hidden.has(s.id||s.name)?'is-muted':''}" data-series-toggle="${i}" aria-pressed="${!settings.hidden.has(s.id||s.name)}" title="Toggle ${escape(s.name)}"><span class="plot-swatch" style="background:${s.color||palette[i%palette.length]}"></span><span>${escape(label(s.name))}</span><b>${number(s.points.at(-1)?.value)}</b></button>`).join('');
    el.querySelectorAll('[data-series-toggle]').forEach(b=>b.onclick=()=>{const s=series[+b.dataset.seriesToggle],key=s.id||s.name;settings.hidden.has(key)?settings.hidden.delete(key):settings.hidden.add(key);draw(el);});
    const count=Math.max(0,...series.map(s=>s.points.length));
    el.querySelector('.plot-count').textContent=`${count.toLocaleString()} measurements${settings.smooth?' · EMA '+settings.smooth:''}`;
    el.querySelector('[data-plot-scale]').value=settings.scale;
  }
  function draw(el){
    if(!el.isConnected)return;
    const {series,settings,canvas}=el.chart;legend(el);
    const traces=[];
    for(const [i,s] of series.entries()){
      const points=s.points.filter(p=>Number.isFinite(p.value)&&(settings.scale!=='log'||p.value>0));
      const origin=s.points.find(p=>p.timestamp)?.timestamp;
      const x=points.map(p=>settings.axis==='elapsed'&&origin?(new Date(p.timestamp)-new Date(origin))/1000:p.step);
      const raw=points.map(p=>p.value);let avg;
      const y=raw.map(v=>avg=avg===undefined?v:settings.smooth*avg+(1-settings.smooth)*v);
      const color=s.color||palette[i%palette.length],key=s.id||s.name;
      const base={type:'scatter',mode:points.length===1?'markers':'lines',x,customdata:points.map(p=>[p.step,p.value]),
        legendgroup:key,line:{color,width:1.8},hoverinfo:'none',showlegend:false,visible:!settings.hidden.has(key)};
      if(settings.smooth>0)traces.push({...base,y:raw,name:label(s.name)+' · raw',uid:key+'-raw',opacity:.17,hoverinfo:'skip'});
      traces.push({...base,y,name:escape(label(s.name)),uid:key});
    }
    const hasData=traces.some(t=>t.x.length);
    const bg='#ffffff',grid='#edf0f2',font=getComputedStyle(el).fontFamily;
    const layout={height:el.classList.contains('plot-expanded')?Math.max(300,innerHeight*.9-170):285,margin:{l:52,r:20,t:20,b:42},autosize:true,
      paper_bgcolor:bg,plot_bgcolor:bg,font:{family:font,size:11,color:'#9298a1'},hovermode:'x',dragmode:settings.drag,
      uirevision:settings.axis+':'+settings.scale+':'+settings.reset,showlegend:false,
      xaxis:{title:{text:settings.axis==='elapsed'?'Elapsed time · seconds':'Step',font:{size:10,color:'#9298a1'},standoff:12},
        gridcolor:grid,zeroline:false,showline:true,linecolor:grid,nticks:6,tickfont:{size:10},exponentformat:'SI',
        showspikes:true,spikemode:'across',spikesnap:'cursor',spikethickness:1,spikedash:'dot',spikecolor:'#78828b'},
      yaxis:{type:settings.scale,gridcolor:grid,zeroline:false,nticks:5,tickfont:{size:10},exponentformat:'SI',automargin:true},
      annotations:hasData?[]:[{text:'Waiting for measurements',xref:'paper',yref:'paper',x:.5,y:.5,showarrow:false,font:{size:12,color:'#9298a1'}}]};
    return Plotly.react(canvas,traces,layout,{responsive:true,displaylogo:false,scrollZoom:false,displayModeBar:false});
  }
  function hover(el,event){
    const points=(event.points||[]).filter(p=>p.data.hoverinfo!=='skip');if(!points.length)return;
    const tip=el.querySelector('.plot-tooltip');
    tip.innerHTML=`<div class="plot-tooltip-head">STEP <b>${number(points[0].customdata?.[0]??points[0].x)}</b>${el.chart.settings.smooth?'<span>EMA · raw</span>':''}</div>${points.map(p=>`<div class="plot-tooltip-row"><i style="background:${p.data.line.color}"></i><span>${p.data.name}</span><b>${number(p.y)}</b>${el.chart.settings.smooth?`<small>${number(p.customdata[1])}</small>`:''}</div>`).join('')}`;
    tip.hidden=false;
    // Synthetic hover events have no pointer event, preventing feedback loops.
    if(event.event&&el.chart.settings.axis==='step')for(const other of document.querySelectorAll('.interactive-chart')){
      if(other!==el&&other.chart?.settings.axis==='step'&&!other.closest('[hidden]')){
        Plotly.Fx.hover(other.chart.canvas,{xval:points[0].x},['xy']);
        const related=other.chart.canvas.data.filter(t=>t.visible!==false&&t.hoverinfo!=='skip'&&t.x.length).map(t=>{
          const index=t.x.reduce((best,x,i)=>Math.abs(x-points[0].x)<Math.abs(t.x[best]-points[0].x)?i:best,0);
          return {x:t.x[index],y:t.y[index],data:t,customdata:t.customdata[index]};
        });
        hover(other,{points:related});
      }
    }
  }
  function init(el,series){
    const log=series.length===1&&/perplexity/i.test(series[0].name);
    el.innerHTML=`<div class="plot-toolbar"><span class="plot-count"></span><div class="plot-actions"><button data-plot-reset title="Reset zoom" aria-label="Reset zoom">${icon('reset')}</button><button data-plot-export title="Download PNG" aria-label="Download chart as PNG">${icon('download')}</button><button data-plot-expand title="Expand chart" aria-label="Expand chart">${icon('expand')}</button><button data-plot-settings title="Chart controls" aria-label="Chart controls" aria-expanded="false">${icon('settings')}</button></div></div><div class="plot-settings" hidden><div class="plot-settings-title">Chart controls <button data-plot-settings-close aria-label="Close chart controls">${icon('close')}</button></div><label>X axis<select data-plot-axis aria-label="X axis"><option value="step">Step</option><option value="elapsed">Elapsed time</option></select></label><label>Y axis<select data-plot-scale aria-label="Y axis scale"><option value="linear">Linear</option><option value="log" ${log?'selected':''}>Logarithmic</option></select></label><label>Interaction<select data-plot-drag aria-label="Chart interaction"><option value="zoom">Box zoom</option><option value="pan">Pan</option></select></label><label class="plot-smoothing">Smoothing <output>0</output><input data-plot-smooth aria-label="Exponential smoothing" type="range" min="0" max="0.99" step="0.01" value="0"></label><small>Exponential moving average. Raw measurements remain visible.</small></div><div class="plot-canvas" role="img" aria-label="Interactive training metrics"></div><div class="plot-tooltip" hidden></div><div class="plot-legend"></div>`;
    el.chart={series,settings:{scale:log?'log':'linear',axis:'step',smooth:0,reset:0,drag:'zoom',hidden:new Set()},canvas:el.querySelector('.plot-canvas')};
    const {settings}=el.chart;
    const closeSettings=()=>{el.querySelector('.plot-settings').hidden=true;el.querySelector('[data-plot-settings]').setAttribute('aria-expanded','false');};
    el.querySelector('[data-plot-settings]').onclick=()=>{const panel=el.querySelector('.plot-settings');panel.hidden=!panel.hidden;el.querySelector('[data-plot-settings]').setAttribute('aria-expanded',String(!panel.hidden));};
    el.querySelector('[data-plot-settings-close]').onclick=closeSettings;
    el.onkeydown=e=>{if(e.key==='Escape'){closeSettings();if(el.classList.contains('plot-expanded'))el.querySelector('[data-plot-expand]').click();}};
    el.querySelector('[data-plot-scale]').onchange=e=>{settings.scale=e.target.value;draw(el);};
    el.querySelector('[data-plot-axis]').onchange=e=>{settings.axis=e.target.value;draw(el);};
    el.querySelector('[data-plot-drag]').onchange=e=>{settings.drag=e.target.value;draw(el);};
    el.querySelector('[data-plot-smooth]').oninput=e=>{settings.smooth=+e.target.value;el.querySelector('output').textContent=e.target.value;draw(el);};
    el.querySelector('[data-plot-reset]').onclick=()=>{settings.reset++;draw(el);};
    el.querySelector('[data-plot-export]').onclick=()=>Plotly.downloadImage(el.chart.canvas,{format:'png',filename:'fabryka-metrics',width:1400,height:700,scale:2});
    el.querySelector('[data-plot-expand]').onclick=()=>{closeSettings();el.classList.toggle('plot-expanded');const open=el.classList.contains('plot-expanded'),b=el.querySelector('[data-plot-expand]');b.innerHTML=icon(open?'close':'expand');b.setAttribute('aria-label',open?'Close expanded chart':'Expand chart');draw(el);};
    el.addEventListener('mouseleave',()=>{for(const other of document.querySelectorAll('.interactive-chart'))if(other.chart){other.querySelector('.plot-tooltip').hidden=true;Plotly.Fx.unhover(other.chart.canvas);}});
  }
  async function render(root,previous=[]){
    const unused=new Set(previous);
    for(let el of root.querySelectorAll('.interactive-chart[data-series]')){
      const series=JSON.parse(el.dataset.series),old=previous.find(p=>unused.has(p)&&p.dataset.chartKey===el.dataset.chartKey);
      if(old){unused.delete(old);el.replaceWith(old);el=old;}
      const fresh=!el.chart;if(fresh)init(el,series);
      el.removeAttribute('data-series');el.chart.series=series;await draw(el);
      if(fresh){el.chart.canvas.on('plotly_hover',e=>hover(el,e));el.chart.canvas.on('plotly_unhover',()=>{el.querySelector('.plot-tooltip').hidden=true;});}
    }
    for(const el of unused)if(el.chart)Plotly.purge(el.chart.canvas);
  }
  function setVisible(root,id,visible){for(const el of root.querySelectorAll('.interactive-chart')){if(!el.chart)continue;visible?el.chart.settings.hidden.delete(id):el.chart.settings.hidden.add(id);draw(el);}}
  function focus(root,fraction){for(const el of root.querySelectorAll('.interactive-chart')){
    if(!el.chart)continue;
    if(!fraction){el.chart.settings.reset++;draw(el);continue;}
    const canvas=el.chart.canvas,points=canvas.data.filter(t=>t.visible!==false).flatMap(t=>t.x.map((x,i)=>[x,t.y[i]]));if(!points.length)continue;
    const xmax=points.reduce((m,p)=>Math.max(m,p[0]),-Infinity),xmin=xmax*fraction,ys=points.filter(p=>p[0]>=xmin).map(p=>p[1]);if(!ys.length)continue;
    const log=el.chart.settings.scale==='log',values=log?ys.filter(y=>y>0).map(Math.log10):ys;if(!values.length)continue;
    const min=values.reduce((m,v)=>Math.min(m,v),Infinity),max=values.reduce((m,v)=>Math.max(m,v),-Infinity),pad=(max-min||Math.abs(max)*.1||1)*.12;
    Plotly.relayout(canvas,{'xaxis.range':[xmin,xmax],'xaxis.autorange':false,'yaxis.range':[min-pad,max+pad],'yaxis.autorange':false});
  }}
  function dispose(root){for(const el of root.querySelectorAll('.interactive-chart'))if(el.chart)Plotly.purge(el.chart.canvas);}
  return {placeholder,render,dispose,setVisible,focus,palette};
})();

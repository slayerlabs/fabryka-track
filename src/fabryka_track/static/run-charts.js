/* Local, interactive metric charts. Raw measurements are never overwritten. */
window.TrackCharts = (() => {
  const palette = ['#ac4c32', '#46715d', '#54799b', '#947334', '#815995', '#25918c'];
  const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const placeholder = series => `<div class="interactive-chart" data-chart-key="${escape(series.map(s=>s.name).join('|'))}" data-series="${escape(JSON.stringify(series))}"></div>`;
  function draw(el) {
    if (!el.isConnected) return;
    const {series, settings, canvas} = el.chart;
    const traces = [];
    for (const [i,s] of series.entries()) {
      const points = s.points.filter(p => Number.isFinite(p.value) && (settings.scale !== 'log' || p.value > 0));
      const firstTime = s.points.find(p=>p.timestamp)?.timestamp;
      const x = points.map(p => settings.axis === 'elapsed' && firstTime ? (new Date(p.timestamp)-new Date(firstTime))/1000 : p.step);
      const raw = points.map(p=>p.value);
      let average;
      const y = raw.map(v => average = average === undefined ? v : settings.smooth*average+(1-settings.smooth)*v);
      const base = {type:'scatter', mode:points.length===1?'markers':'lines', x,
        customdata:points.map(p=>[p.step,p.value]), legendgroup:String(i), line:{color:palette[i%palette.length],width:2},
        hovertemplate:'Step %{customdata[0]:,}<br>Value %{y:.5g}<br>Raw %{customdata[1]:.5g}<extra>%{fullData.name}</extra>'};
      if (settings.smooth > 0) traces.push({...base, y:raw, name:s.name+' · raw', opacity:.2, showlegend:false, hoverinfo:'skip', hovertemplate:null});
      traces.push({...base, y, name:escape(s.name), uid:s.name, ...(settings.smooth>0?{name:escape(s.name)+' · EMA'}:{})});
    }
    const hasData=traces.some(t=>t.x.length);
    const layout = {height:el.classList.contains('plot-expanded')?Math.max(320,innerHeight*.9-100):340, margin:{l:58,r:16,t:34,b:85}, autosize:true,
      paper_bgcolor:'#fffefa', plot_bgcolor:'#fffefa', font:{family:'Arial, sans-serif',size:12,color:'#55574f'},
      hovermode:'x unified', dragmode:'zoom', uirevision:settings.axis+':'+settings.scale+':'+settings.reset,
      legend:{orientation:'h',y:-.32,x:0,font:{size:12}},
      xaxis:{title:{text:settings.axis==='elapsed'?'Elapsed training time (s)':'Training step'},gridcolor:'#ecece4',zeroline:false,
        showspikes:true,spikemode:'across',spikesnap:'cursor',spikethickness:1, spikecolor:'#9d9f94', exponentformat:'SI'},
      yaxis:{type:settings.scale,gridcolor:'#ecece4',zeroline:false,exponentformat:'SI',automargin:true},
      annotations:hasData?[]:[{text:'Waiting for measurements',xref:'paper',yref:'paper',x:.5,y:.5,showarrow:false}]};
    return Plotly.react(canvas,traces,layout,{responsive:true,displaylogo:false,scrollZoom:false,displayModeBar:true,
      modeBarButtonsToRemove:['select2d','lasso2d','sendDataToCloud','sendChartToCloud'],
      toImageButtonOptions:{format:'png',filename:'fabryka-training',width:1400,height:800,scale:2}});
  }
  function init(el) {
    el.innerHTML=`<div class="plot-controls"><label>Y <select data-plot-scale aria-label="Y axis scale"><option value="linear">Linear</option><option value="log">Log</option></select></label><label>X <select data-plot-axis aria-label="X axis"><option value="step">Step</option><option value="elapsed">Elapsed time</option></select></label><label class="plot-smoothing">Smoothing <input data-plot-smooth aria-label="Exponential smoothing" type="range" min="0" max="0.99" step="0.01" value="0"><output>0</output></label><button type="button" data-plot-reset>Reset zoom</button><button type="button" data-plot-expand aria-label="Expand chart">Expand</button></div><div class="plot-canvas" role="img" aria-label="Interactive training metrics"></div>`;
    el.chart={series:[],settings:{scale:'linear',axis:'step',smooth:0,reset:0},canvas:el.querySelector('.plot-canvas')};
    const settings=el.chart.settings;
    el.querySelector('[data-plot-scale]').onchange=e=>{settings.scale=e.target.value;draw(el);};
    el.querySelector('[data-plot-axis]').onchange=e=>{settings.axis=e.target.value;draw(el);};
    el.querySelector('[data-plot-smooth]').oninput=e=>{settings.smooth=+e.target.value;el.querySelector('output').textContent=e.target.value;draw(el);};
    el.querySelector('[data-plot-reset]').onclick=()=>{settings.reset++;draw(el);};
    el.querySelector('[data-plot-expand]').onclick=()=>{
      el.classList.toggle('plot-expanded');
      el.querySelector('[data-plot-expand]').textContent=el.classList.contains('plot-expanded')?'Close':'Expand';
      draw(el);
    };
  }
  async function render(root, previous=[]) {
    const unused=new Set(previous);
    for (let el of root.querySelectorAll('.interactive-chart[data-series]')) {
      const series=JSON.parse(el.dataset.series);
      const old=previous.find(p=>unused.has(p)&&p.dataset.chartKey===el.dataset.chartKey);
      if(old){unused.delete(old);el.replaceWith(old);el=old;}
      if(!el.chart)init(el);
      el.removeAttribute('data-series');el.chart.series=series;
      await draw(el);
    }
    for(const el of unused)if(el.chart)Plotly.purge(el.chart.canvas);
  }
  function dispose(root){for(const el of root.querySelectorAll('.interactive-chart'))if(el.chart)Plotly.purge(el.chart.canvas);}
  return {placeholder,render,dispose};
})();

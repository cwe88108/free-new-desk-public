// Identical benchmark workload installed into both observation copies.
const benchmarkFrames:number[]=[];
let benchmarkFrame=0,benchmarkLast=0;
let benchmarkPhase='startup';
function benchmarkFrameReady():Promise<void>{
  return new Promise((resolve,reject)=>{
    let frame=0;
    const timer=window.setTimeout(()=>{
      cancelAnimationFrame(frame);
      const detail={phase:benchmarkPhase,visibility:document.visibilityState,focused:document.hasFocus()};
      console.error('Benchmark frame unavailable',JSON.stringify(detail));
      reject(new Error('Benchmark frame unavailable: '+JSON.stringify(detail)));
    },2000);
    frame=requestAnimationFrame(()=>{clearTimeout(timer);resolve();});
  });
}
function sampleBenchmarkFrame(now:number):void{
  if(benchmarkLast>0&&benchmarkFrames.length<20_000)benchmarkFrames.push(now-benchmarkLast);
  benchmarkLast=now;benchmarkFrame=requestAnimationFrame(sampleBenchmarkFrame);
}
async function benchmarkMetric(metric:string,value:number):Promise<void>{
  const ok=await window.desktop.diagnostics.recordPerformance(metric,value);if(!ok)throw new Error('Benchmark evidence rejected');
}
async function flushSmokeSurfaceTiming():Promise<unknown>{return true;}
async function waitBenchmarkPage(key:string):Promise<{localControl:number;probeMs:number}>{
  const deadline=performance.now()+10_000;
  let probeMs=0;
  while(performance.now()<deadline){
    const probeStart=performance.now();
    const root=document.querySelector<HTMLElement>('.content .'+key+'-page');
    if(root&&root.getBoundingClientRect().width>0&&Number(getComputedStyle(root).opacity)>=.99&&!root.classList.contains('route-leave-active')){
      let localControl:HTMLElement|undefined;
      for(const item of root.querySelectorAll<HTMLElement>('button:not([disabled]),a[href],input:not([disabled]),select:not([disabled])'))if(item.getClientRects().length>0&&getComputedStyle(item).visibility!=='hidden'){localControl=item;break;}
      // Empty pages may legitimately have no local action; require their actual navigation control instead.
      const control=localControl??(root.textContent?.trim().length?document.querySelector<HTMLElement>('.nav-item.active:not([disabled])'):null);
      if(control){control.focus({preventScroll:true});if(document.activeElement===control)return{localControl:localControl?1:0,probeMs:probeMs+performance.now()-probeStart};}
    }
    probeMs+=performance.now()-probeStart;
    await benchmarkFrameReady();
  }
  const root=document.querySelector<HTMLElement>('.content .'+key+'-page');
  const detail={page:key,root:!!root,opacity:root?getComputedStyle(root).opacity:null,width:root?.getBoundingClientRect().width,controls:root?[...root.querySelectorAll<HTMLElement>('button:not([disabled]),a[href],input:not([disabled]),select:not([disabled])')].map(item=>({tag:item.tagName,rects:item.getClientRects().length,visibility:getComputedStyle(item).visibility,tabIndex:item.tabIndex,inert:item.inert})):[],focused:document.activeElement?.tagName};
  console.error('Benchmark page readiness diagnostic',JSON.stringify(detail));
  throw new Error('Benchmark page did not become visible and focusable: '+key);
}
async function runUiSmoke():Promise<void>{
  await benchmarkFrameReady();await benchmarkFrameReady();
  await benchmarkMetric('firstInteractiveMs',performance.now());
  const focusDeadline=performance.now()+60_000;
  let focusedSince=performance.now();
  while(performance.now()-focusedSince<1000){
    if(performance.now()>focusDeadline)throw new Error('Benchmark needs stable foreground focus before starting');
    if(!document.hasFocus())focusedSince=performance.now();
    await sleep(50);
  }
  await benchmarkMetric('benchmarkMeasuredStart',0);
  benchmarkFrame=requestAnimationFrame(sampleBenchmarkFrame);
  const pages=['home','vod','live','music','player','search','favorites','history','sources','settings','live','music','player','search','player'] as const;
  for(let cycle=0;cycle<10;cycle++)for(const key of pages){
    benchmarkPhase=`${cycle+1}:${key}`;
    if(document.visibilityState!=='visible')throw new Error('Benchmark window is not visible: '+benchmarkPhase);
    await benchmarkMetric('pageVisible',1);await benchmarkMetric('pageFocused',document.hasFocus()?1:0);
    const at=performance.now();
    const button=document.querySelector<HTMLButtonElement>(`button[data-smoke-key="${key}"]`);
    if(!button)throw new Error('Benchmark navigation target missing: '+key);
    button.click();await waitForSmokeRoute(key,10_000);
    const readiness=await waitBenchmarkPage(key);
    await benchmarkFrameReady();await benchmarkFrameReady();
    const content=document.querySelector<HTMLElement>('.content');
    if(!content||(content.textContent?.trim().length??0)<2||document.querySelector('.renderer-fatal'))throw new Error('Benchmark content unavailable');
    const interactiveMs=performance.now()-at;
    await benchmarkMetric('pageShellInteractiveMs',interactiveMs);
    await benchmarkMetric('pageShellInteractiveMs.'+key,interactiveMs);
    await benchmarkMetric('pageLocalControlAvailable.'+key,readiness.localControl);
    await benchmarkMetric('pageReadinessProbeMs',readiness.probeMs);
    if(key==='player'){const loaded=await window.desktop.playback.smokeLoad();if(!loaded.ok)throw new Error('Benchmark player load failed');await sleep(250);}
    if(key==='sources'){
      const expected=(window as unknown as {fndBenchmark:{sourceCount:number}}).fndBenchmark.sourceCount;
      const rows='.source-table:not(.compatibility-table):not(.live-source-table) .drag-handle[draggable]';
      const deadline=performance.now()+10_000;
      while(content.querySelectorAll(rows).length<Math.min(expected,50)){if(performance.now()>deadline)throw new Error('Benchmark source first page incomplete');await benchmarkFrameReady();}
      await benchmarkMetric('sourceFirstPageReadyMs',performance.now()-at);
      const visited=new Set<string>();
      const collect=()=>{for(const row of content.querySelectorAll(rows)){const name=row.closest('tr')?.querySelector('strong')?.textContent?.trim();if(name)visited.add(name);}};
      const pagers=[...content.querySelectorAll<HTMLSelectElement>('.source-group-heading .source-pagination select')];
      if(pagers.length){
        collect();
        for(const select of pagers)for(const option of [...select.options].slice(1)){
          if(performance.now()>deadline)throw new Error('Benchmark source traversal timed out');
          select.value=option.value;select.dispatchEvent(new Event('change',{bubbles:true}));
          await benchmarkFrameReady();await benchmarkFrameReady();collect();
        }
      }else{
        while(content.querySelectorAll(rows).length<expected){if(performance.now()>deadline)throw new Error('Benchmark source list incomplete');await benchmarkFrameReady();}
        collect();
      }
      if(visited.size!==expected||Array.from({length:expected},(_,i)=>'基准来源 '+String(i+1).padStart(4,'0')).some(name=>!visited.has(name)))throw new Error('Benchmark did not expose every expected source');
      await benchmarkMetric('sourceRowsVisited',visited.size);
      await benchmarkMetric('sourceListReadyMs',performance.now()-at);
      await benchmarkMetric('sourceRowsRendered',content.querySelectorAll(rows).length);
      const scrollStart=performance.now(),before=content.scrollTop;
      content.scrollTop=content.scrollHeight;await sleep(100);content.scrollTop=before;
      await benchmarkMetric('sourceScrollStepMs',performance.now()-scrollStart);
    }
    document.title=`Free New Desk - Benchmark ${cycle+1}:${key}`;
    await sleep(160);
  }
  cancelAnimationFrame(benchmarkFrame);
  if(benchmarkFrames.length<100)throw new Error('Insufficient frame samples');
  await benchmarkMetric('benchmarkMeasuredEnd',0);
  for(const gap of benchmarkFrames)await benchmarkMetric('rendererFrameGapMs',gap);
  await benchmarkMetric('rendererFrameMaxMs',Math.max(...benchmarkFrames));
  await benchmarkMetric('rendererFrameOver33MsRate',benchmarkFrames.filter(gap=>gap>33.3).length/benchmarkFrames.length);
  await benchmarkMetric('benchmarkComplete',0);
  document.title='Free New Desk - Benchmark Complete';
}

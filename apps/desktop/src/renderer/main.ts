import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import { router } from './router';
import './styles.css';
import './parity.css';

const systemDark=window.matchMedia('(prefers-color-scheme: dark)');
function resolvedTheme(theme:string):'light'|'dark'{return theme==='dark'||(theme==='system'&&systemDark.matches)?'dark':'light';}
function applyTheme(theme:string):void{
  const resolved=resolvedTheme(theme);
  document.documentElement.style.colorScheme=resolved;
  document.documentElement.dataset.themePreference=theme;
  document.documentElement.dataset.theme=resolved;
}
systemDark.addEventListener('change',()=>{if(document.documentElement.dataset.themePreference==='system')applyTheme('system');});

const smokeFrameGaps:number[]=[];
let smokeFrameSampling=false,smokeFrameHandle=0,smokeFrameLast=0;
function sampleSmokeFrame(now:number):void{
  if(!smokeFrameSampling)return;
  if(smokeFrameLast>0){
    const gap=now-smokeFrameLast;
    if(Number.isFinite(gap)&&gap>0&&gap<=1000){
      smokeFrameGaps.push(gap);
      if(smokeFrameGaps.length>6000)smokeFrameGaps.shift();
    }
  }
  smokeFrameLast=now;
  smokeFrameHandle=requestAnimationFrame(sampleSmokeFrame);
}
function smokePercentile(values:number[],ratio:number):number{
  if(!values.length)return 0;
  const ordered=[...values].sort((a,b)=>a-b);
  return ordered[Math.min(ordered.length-1,Math.max(0,Math.ceil(ordered.length*ratio)-1))]??0;
}
function startSmokeFrameSampling():void{
  if(smokeFrameSampling)return;
  smokeFrameSampling=true;smokeFrameLast=0;smokeFrameGaps.length=0;
  smokeFrameHandle=requestAnimationFrame(sampleSmokeFrame);
}
async function stopSmokeFrameSampling():Promise<void>{
  if(!smokeFrameSampling)return;
  smokeFrameSampling=false;cancelAnimationFrame(smokeFrameHandle);
  const values=[...smokeFrameGaps],over16=values.filter(value=>value>16.7).length,over33=values.filter(value=>value>33.3).length,over50=values.filter(value=>value>50).length;
  if(!values.length)return;
  const metrics:Array<[string,number]>=[
    ['rendererFrameSampleCount',values.length],
    ['rendererFrameP50Ms',smokePercentile(values,.5)],
    ['rendererFrameP95Ms',smokePercentile(values,.95)],
    ['rendererFrameMaxMs',Math.max(...values)],
    ['rendererFrameOver16MsCount',over16],
    ['rendererFrameOver33MsCount',over33],
    ['rendererFrameOver50MsCount',over50],
    ['rendererFrameOver16MsRate',over16/values.length],
    ['rendererFrameOver33MsRate',over33/values.length],
    ['rendererFrameOver50MsRate',over50/values.length]
  ];
  for(const[metric,value]of metrics)await window.desktop.diagnostics.recordPerformance(metric,value).catch(()=>false);
}
async function flushSmokeSurfaceTiming():Promise<unknown>{
  await stopSmokeFrameSampling();
  return await Promise.race([window.desktop.diagnostics.recordPerformance('surfaceTraceFlush',0).catch(()=>false),new Promise(resolve=>setTimeout(resolve,2000))]);
}

function renderFatal(reason:unknown):void{
  const message=reason instanceof Error?reason.message:String(reason);
  if(window.desktop?.app?.isUiSmoke?.())void flushSmokeSurfaceTiming();
  const smokeDetail=message.replace(/[\r\n:]+/g,' ').slice(0,120);
  document.title=window.desktop?.app?.isUiSmoke?.()?`Free New Desk - Renderer Error ${smokeDetail}`:'Free New Desk - Renderer Error';
  const root=document.getElementById('app');
  if(root)root.innerHTML=`<main class="renderer-fatal"><strong>界面加载失败</strong><p>${message.replace(/[<>&]/g,value=>({'<':'&lt;','>':'&gt;','&':'&amp;'}[value]??value))}</p><small>请在“设置 → 导出诊断包”或日志目录中查看详细信息。</small></main>`;
}

const sleep=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
function activeSmokeKey():string{return document.querySelector<HTMLElement>('.nav-item.active')?.dataset.smokeKey??'';}
function waitForSmokeRoute(key:string,timeoutMs=1500):Promise<void>{
  if(activeSmokeKey()===key)return Promise.resolve();
  return new Promise<void>((resolve,reject)=>{
    let timer=0;
    let settled=false;
    const observer=new MutationObserver(()=>{if(activeSmokeKey()===key)finish();});
    const finish=(error?:Error)=>{if(settled)return;settled=true;window.clearTimeout(timer);observer.disconnect();error?reject(error):resolve();};
    timer=window.setTimeout(()=>finish(new Error(`UI smoke route activation timed out: ${key}`)),timeoutMs);
    observer.observe(document.body,{subtree:true,attributes:true,attributeFilter:['class']});
    if(activeSmokeKey()===key)finish();
  });
}

function assertAccessibleFocusTargets(page:string):void{
  const visible=(element:HTMLElement)=>!element.closest('details:not([open])')&&element.getClientRects().length>0&&getComputedStyle(element).visibility!=='hidden'&&getComputedStyle(element).display!=='none';
  for(const image of document.querySelectorAll<HTMLImageElement>('img'))if(visible(image)&&!image.hasAttribute('alt'))throw new Error(`Visible image is missing alt text on ${page}`);
  const controls=[...document.querySelectorAll<HTMLElement>('button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])')].filter(visible);
  if(controls.length===0)throw new Error(`No keyboard focus targets rendered on ${page}`);
  for(const control of controls){
    if(control instanceof HTMLButtonElement&&!control.textContent?.trim()&&!control.getAttribute('aria-label')&&!control.title)throw new Error(`Unlabelled button rendered on ${page}`);
    control.focus({preventScroll:true});
    if(document.activeElement!==control)throw new Error(`Control cannot receive keyboard focus on ${page}: ${control.tagName}`);
  }
}

async function runUiSmoke():Promise<void>{
  startSmokeFrameSampling();
  const pages=['home','vod','live','music','player','search','favorites','history','sources','settings','live','music','player','search','player'] as const;
  await sleep(800);
  for(const key of pages){
    document.title='Free New Desk - UI Smoke Transition';
    const button=document.querySelector<HTMLButtonElement>(`button[data-smoke-key="${key}"]`);
    if(!button)throw new Error(`UI smoke navigation button missing: ${key}`);
    let navigationMs=0;
    for(let attempt=0;attempt<2;attempt+=1){const attemptButton=document.querySelector<HTMLButtonElement>(`button[data-smoke-key="${key}"]`);if(!attemptButton)throw new Error(`UI smoke navigation button disappeared: ${key}`);const navigationStarted=performance.now();attemptButton.click();try{await waitForSmokeRoute(key);navigationMs=performance.now()-navigationStarted;break;}catch(error){if(attempt===1)throw error;await sleep(100);}}
    if(navigationMs>100)throw new Error(`UI smoke navigation exceeded 100ms: ${key} ${navigationMs.toFixed(1)}ms`);if(key==='player'){void window.desktop.diagnostics.recordPerformance('playbackNavigationMs',navigationMs).catch(()=>false);const smoke=await window.desktop.playback.smokeLoad();if(!smoke.ok||smoke.acceptedMs>200)throw new Error(`PlayerHost async smoke accept exceeded 200ms: ${smoke.acceptedMs.toFixed(1)}ms`);await sleep(250);}
    await sleep(250);
    const active=activeSmokeKey();
    if(active!==key)throw new Error(`UI smoke route did not activate: expected ${key}, got ${active||'none'}`);
    if(document.querySelector('.renderer-fatal'))throw new Error(`Renderer fatal state reached on route: ${key}`);
    const content=document.querySelector<HTMLElement>('.content');
    if(!content||content.innerText.trim().length<2)throw new Error(`UI smoke route rendered empty content: ${key}`);
    assertAccessibleFocusTargets(key);
    if(key==='sources'){const labels=[...document.querySelectorAll<HTMLButtonElement>('.bulk-toolbar button')].map(button=>button.textContent?.trim());for(const required of ['全部启动','全部停用','启用检查通过来源','停止检查失败来源'])if(!labels.includes(required))throw new Error('Sources bulk control missing: '+required);}
    if(key==='settings'){
      const javaCard=document.querySelector<HTMLElement>('.java-runtime-card');
      if(!javaCard)throw new Error('Settings UI smoke is missing the Java Runtime card.');
      javaCard.scrollIntoView({block:'center',inline:'nearest'});
      await sleep(350);
      if(javaCard.getBoundingClientRect().bottom<0||javaCard.getBoundingClientRect().top>window.innerHeight)throw new Error('Java Runtime card could not be brought into the screenshot viewport.');
    }
    document.title=`Free New Desk - Smoke:${key}`;
    await sleep(1600);
  }
  await flushSmokeSurfaceTiming();
  document.title='Free New Desk - UI Smoke Complete';
}

window.addEventListener('error',event=>renderFatal(event.error??event.message));
window.addEventListener('unhandledrejection',event=>renderFatal(event.reason));

async function bootstrap():Promise<void>{
  try{
    const app=createApp(App);
    app.config.errorHandler=error=>renderFatal(error);
    app.use(createPinia()).use(router);
    await router.isReady();
    app.mount('#app');
    const settings=await window.desktop.settings.list().catch(()=>({} as Record<string,string>));
    applyTheme(settings.theme??'system');
    const fontScale=Math.max(.9,Math.min(1.5,Number(settings['ui.fontScale']??1)||1));
    document.documentElement.style.setProperty('--font-scale',String(fontScale));
    document.documentElement.classList.add('renderer-ready');
    document.title='Free New Desk - Ready';
    if(window.desktop.app.isUiSmoke())void runUiSmoke().catch(renderFatal);
  }catch(error){renderFatal(error);}
}

void bootstrap();

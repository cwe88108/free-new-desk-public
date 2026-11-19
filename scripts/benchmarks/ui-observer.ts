// Observation-copy only. Never imported by the shipping application.
import {app,ipcMain,powerMonitor} from 'electron';
import {writeFile} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';

const started=performance.now();
// Event-only diagnostics: distinguish app hiding/minimizing from session locking.
// Never force visibility/focus or suppress a failed foreground measurement.
app.on('browser-window-created',(_event,window)=>{
  const report=(event:string)=>console.error('benchmark-window-state',JSON.stringify({
    event,atMs:performance.now()-started,windowId:window.id,
    visible:window.isVisible(),focused:window.isFocused(),minimized:window.isMinimized(),
  }));
  window.on('show',()=>report('show'));
  window.on('hide',()=>report('hide'));
  window.on('minimize',()=>report('minimize'));
  window.on('restore',()=>report('restore'));
  window.on('focus',()=>report('focus'));
  window.on('blur',()=>report('blur'));
  window.on('close',()=>report('close'));
});
void app.whenReady().then(()=>{
  powerMonitor.on('lock-screen',()=>console.error('benchmark-session-state','lock-screen'));
  powerMonitor.on('unlock-screen',()=>console.error('benchmark-session-state','unlock-screen'));
  powerMonitor.on('suspend',()=>console.error('benchmark-session-state','suspend'));
  powerMonitor.on('resume',()=>console.error('benchmark-session-state','resume'));
});
const samples:Record<string,number[]>={};
const errors:Record<string,number>={};
const preWorkloadErrors:Record<string,number>={};
let measuredStart:number|undefined;
let measuredEnd:number|undefined;
const channels=new Set(['playback:query','playback:runtimeSession']);
const metricNames=new Set(['navigationMs','navigationOver100Ms','pageShellInteractiveMs','pageReadinessProbeMs','pageVisible','pageFocused','firstInteractiveMs','rendererFrameGapMs','rendererFrameOver33MsRate','rendererFrameMaxMs','sourceRowsRendered','sourceRowsVisited','sourceFirstPageReadyMs','sourceListReadyMs','sourceScrollStepMs']);
const queryMetric=(args:unknown[])=>{
  const input=args[0];
  const query=typeof input==='string'?input:input&&typeof input==='object'?(input as {query?:unknown}).query:undefined;
  return query==='stats'?'playbackStats':query==='load-status'?'playbackLoadStatus':query==='tracks'?'playbackTracks':'playbackOther';
};
function record(name:string,value:number):void{
  if(!Number.isFinite(value)||value<0||value>120_000)return;
  const values=samples[name]??=[];if(values.length<20_000)values.push(value);
}
const rawHandle=ipcMain.handle.bind(ipcMain);
rawHandle('benchmark:preloadEvidence',(event,input:unknown)=>{
  if(!event.senderFrame?.url.startsWith('file://'))throw new Error('Untrusted benchmark sender');
  if(!input||typeof input!=='object')throw new Error('Invalid benchmark evidence');
  for(const[name,values]of Object.entries(input)){
    if(!['playbackStatsIpcMs','playbackLoadStatusIpcMs','playbackTracksIpcMs'].includes(name)||!Array.isArray(values)||values.length>20_000)throw new Error('Invalid benchmark samples');
    for(const value of values)if(typeof value==='number')record(name,value);
  }
  return true;
});
ipcMain.handle=(channel,listener)=>rawHandle(channel,async(event,...args)=>{
  const measured=channels.has(channel),name=channel==='playback:query'?queryMetric(args):'runtimeSession';
  const at=performance.now();
  const inWorkload=measuredStart!==undefined&&measuredEnd===undefined;
  try{
    const result=await listener(event,...args);
    if(channel==='diagnostics:recordPerformance'&&args[0]&&typeof args[0]==='object'){
      const input=args[0] as {metric?:unknown;value?:unknown};
      if(input.metric==='benchmarkMeasuredStart'){
        measuredStart=performance.now();
        for(const name of Object.keys(samples))if(name!=='firstInteractiveMs')delete samples[name];
      }
      if(typeof input.metric==='string'&&(metricNames.has(input.metric)||/^(pageShellInteractiveMs|pageLocalControlAvailable)\.(home|vod|live|music|player|search|favorites|history|sources|settings)$/.test(input.metric))&&typeof input.value==='number')record(input.metric,input.value);
      if(input.metric==='benchmarkMeasuredEnd')measuredEnd=performance.now();
      if(input.metric==='benchmarkComplete'){
        const output=process.env.FND_BENCH_OUTPUT;if(!output)throw new Error('Missing benchmark output');
        await writeFile(output,JSON.stringify({schemaVersion:1,appVersion:app.getVersion(),workload:'observed-ui-150-v8',completed:true,durationMs:(measuredEnd??performance.now())-(measuredStart??started),preWorkloadMs:(measuredStart??started)-started,samples,errors,preWorkloadErrors},null,2),'utf8');
      }
    }
    return result;
  }catch(error){if(measured&&measuredEnd===undefined){const target=inWorkload?errors:preWorkloadErrors;target[name]=(target[name]??0)+1;}throw error;}
  finally{if(measured&&inWorkload&&measuredEnd===undefined)record(name+'HandlerMs',performance.now()-at);}
});

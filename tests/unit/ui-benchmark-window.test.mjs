import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';

test('preload timings exclude foreground waiting, including requests settled after measurement starts',async()=>{
  const source=await readFile(new URL('../../scripts/benchmarks/ui-preload.cts',import.meta.url),'utf8');
  let time=0,finish,evidence;
  const ipcRenderer={invoke:async(channel,input)=>{
    if(channel==='benchmark:preloadEvidence'){evidence=structuredClone(input);return true;}
    if(channel==='playback:query')return await new Promise(resolve=>{finish=resolve;});
    return true;
  }};
  vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,{ipcRenderer,contextBridge:{exposeInMainWorld(){}},process:{env:{}},performance:{now:()=>time}});
  const early=ipcRenderer.invoke('playback:query','stats');time=1000;
  await ipcRenderer.invoke('diagnostics:recordPerformance',{metric:'benchmarkMeasuredStart'});
  time=2000;finish({});await early;
  const measured=ipcRenderer.invoke('playback:query','stats');time=2025;finish({});await measured;
  const late=ipcRenderer.invoke('playback:query','stats');
  await ipcRenderer.invoke('diagnostics:recordPerformance',{metric:'benchmarkMeasuredEnd'});
  time=9000;finish({});await late;
  await ipcRenderer.invoke('diagnostics:recordPerformance',{metric:'benchmarkComplete'});
  assert.deepEqual(evidence.playbackStatsIpcMs,[25]);
});

test('main observer separates startup errors and reports operation duration rather than focus wait',async()=>{
  let source=await readFile(new URL('../../scripts/benchmarks/ui-observer.ts',import.meta.url),'utf8');
  source=source.replace(/^import .*;\r?\n/gm,'');
  let time=0,output;
  const handlers=new Map(),ipcMain={handle:(channel,listener)=>handlers.set(channel,listener)};
  vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,{app:{on(){},whenReady:()=>Promise.resolve(),getVersion:()=> '1.5.14'},powerMonitor:{on(){}},ipcMain,performance:{now:()=>time},writeFile:async(_path,text)=>{output=JSON.parse(text);},process:{env:{FND_BENCH_OUTPUT:'unused.json'}}});
  const event={senderFrame:{url:'file:///fixture'}};
  ipcMain.handle('diagnostics:recordPerformance',async()=>true);
  ipcMain.handle('playback:query',async()=>{throw Error('pending');});
  await assert.rejects(handlers.get('playback:query')(event,'stats'));
  time=5000;await handlers.get('diagnostics:recordPerformance')(event,{metric:'benchmarkMeasuredStart',value:0});
  time=5010;await assert.rejects(handlers.get('playback:query')(event,'stats'));
  time=5100;await handlers.get('diagnostics:recordPerformance')(event,{metric:'benchmarkMeasuredEnd',value:0});
  time=6000;await handlers.get('diagnostics:recordPerformance')(event,{metric:'benchmarkComplete',value:0});
  assert.equal(output.durationMs,100);assert.equal(output.preWorkloadMs,5000);
  assert.deepEqual(output.errors,{playbackStats:1});assert.deepEqual(output.preWorkloadErrors,{playbackStats:1});
  assert.equal(output.samples.playbackStatsHandlerMs.length,1);
});

import {readFile,writeFile,mkdir,copyFile,cp,symlink,stat} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';

const templates=fileURLToPath(new URL('./benchmarks/',import.meta.url));
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
function git(root,...args){const result=spawnSync('git',['-C',root,...args],{encoding:'utf8'});if(result.status!==0)throw Error(result.stderr);return result.stdout;}
function replaceFunction(text,name,replacement){
  const ast=ts.createSourceFile('source.ts',text,ts.ScriptTarget.Latest,true);
  const node=ast.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text===name);
  if(!node)throw Error('Missing benchmark hook: '+name);
  return text.slice(0,node.getStart(ast))+replacement+text.slice(node.end);
}
const[sourceArg,outputArg,mode]=process.argv.slice(2);
if(mode&&!['--trace-source-view','--trace-source-view-no-motion','--trace-source-view-separate-borders','--trace-source-view-containment'].includes(mode))throw Error('Unknown observation mode');
if(!sourceArg||!outputArg)throw Error('Usage: node scripts/prepare-ui-benchmark.mjs <source checkout> <new observation copy>');
const source=path.resolve(sourceArg),output=path.resolve(outputArg);
if(output===source||output.startsWith(source+path.sep)||source.startsWith(output+path.sep))throw Error('Observation copy must be outside the source checkout');
try{await stat(output);throw Error('Refusing existing observation directory');}catch(error){if(error.code!=='ENOENT')throw error;}
const files=[...new Set(git(source,'ls-files','-z','--cached','--others','--exclude-standard').split('\0').filter(Boolean))].sort();
await mkdir(output,{recursive:true});
const inventory=[];
for(const relative of files){
  const from=path.resolve(source,relative),to=path.resolve(output,relative);
  if(!from.startsWith(source+path.sep)||!to.startsWith(output+path.sep))throw Error('Source path escapes checkout');
  let bytes;try{bytes=await readFile(from);}catch(error){if(error.code==='ENOENT')continue;throw error;}
  await mkdir(path.dirname(to),{recursive:true});await copyFile(from,to);inventory.push({path:relative,sha256:digest(bytes)});
}
await symlink(path.join(source,'node_modules'),path.join(output,'node_modules'),'junction');
for(const entry of inventory.filter(item=>/^(services|packages)\/[^/]+\/package\.json$/.test(item.path))){
  const folder=path.dirname(entry.path),from=path.join(source,folder,'dist');
  try{await stat(from);await cp(from,path.join(output,folder,'dist'),{recursive:true});}catch(error){if(error.code!=='ENOENT')throw error;}
}
await mkdir(path.join(output,'native/player-host/build'),{recursive:true});
await cp(path.join(source,'native/player-host/build/Release'),path.join(output,'native/player-host/build/Release'),{recursive:true});
const changes=[];
async function change(relative,transform){const file=path.join(output,relative),before=await readFile(file,'utf8'),after=await transform(before);await writeFile(file,after);changes.push({path:relative,beforeSha256:digest(before),afterSha256:digest(after)});}
let workload=await readFile(path.join(templates,'ui-workload.ts'),'utf8');
if(mode)workload=workload.replace('cycle<10','cycle<2');
const runAst=ts.createSourceFile('workload.ts',workload,ts.ScriptTarget.Latest,true);
const run=runAst.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='runUiSmoke').getText(runAst);
const helpers=workload.slice(0,runAst.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='runUiSmoke').getStart(runAst));
await change('apps/desktop/src/renderer/main.ts',text=>{
  const start=text.indexOf('const smokeFrameGaps')>=0?text.indexOf('const smokeFrameGaps'):text.indexOf('function flushSmokeSurfaceTiming');
  const end=text.indexOf('function renderFatal');if(start<0||end<=start)throw Error('Missing renderer observation hook');
  return replaceFunction(text.slice(0,start)+helpers+text.slice(end),'runUiSmoke',run);
});
await change('apps/desktop/src/main/bootstrap.ts',text=>"import './benchmark-observer.js';\n"+text);
await change('apps/desktop/src/renderer/App.vue',text=>{
  const budget="if(window.desktop.app.isUiSmoke()&&elapsed>100)throw new Error(`Navigation exceeded 100ms budget: ${path} ${elapsed.toFixed(1)}ms`);";
  if(text.split(budget).length!==2)throw Error('Missing unique smoke-only navigation budget assertion');
  return text.replace(budget,"if(window.desktop.app.isUiSmoke()&&elapsed>100)void window.desktop.diagnostics.recordPerformance('navigationOver100Ms',elapsed).catch(()=>false);");
});
let observer=await readFile(path.join(templates,'ui-observer.ts'),'utf8');
if(mode)observer=observer.replace("'playback:runtimeSession'","'playback:runtimeSession','source:list','live:listSources','source:health','settings:list','source:executableStatus'").replace(":'runtimeSession';",":channel.replaceAll(':','_');").replace('observed-ui-150-v8','source-view-trace-v1');
if(mode==='--trace-source-view-no-motion')observer=observer.replace('source-view-trace-v1','source-view-trace-no-motion-v1');
if(mode==='--trace-source-view-separate-borders')observer=observer.replace('source-view-trace-v1','source-view-trace-borders-v1');
if(mode)observer+=`\n// Diagnostic only: locate stalls outside IPC handler bodies.\nlet traceLastTick=performance.now();\nconst traceTimer=setInterval(()=>{const now=performance.now(),gap=now-traceLastTick;traceLastTick=now;if(gap>200)console.error('benchmark-main-gap',JSON.stringify({at:Date.now(),gapMs:gap}));},50);traceTimer.unref();\n`;
if(mode){
  if(process.env.FND_BENCH_NATIVE_TRACE==='1'){
  observer=observer.replace("import {app,ipcMain,powerMonitor}","import {app,ipcMain,powerMonitor,contentTracing}");
  observer+=`\nconst nativeTraceReady=app.whenReady().then(async()=>{console.error('benchmark-accessibility',JSON.stringify({enabled:app.accessibilitySupportEnabled}));await contentTracing.startRecording({included_categories:['toplevel','accessibility','electron','ipc','base','sequence_manager'],excluded_categories:['*'],included_process_ids:[process.pid],trace_buffer_size_in_kb:32768,recording_mode:'record-until-full'});});\n`;
  }
  observer="import {Session as CpuTraceSession} from 'node:inspector';\n"+observer;
  observer=observer.replace('const started=performance.now();',`const traceCpuSession=new CpuTraceSession();traceCpuSession.connect();\nconst traceCpuPost=(method:string)=>new Promise<any>((resolve,reject)=>traceCpuSession.post(method,(error,result)=>error?reject(error):resolve(result)));\nconst traceCpuReady=traceCpuPost('Profiler.enable').then(()=>traceCpuPost('Profiler.start'));\nconst started=performance.now();`);
  observer=observer.replace("const output=process.env.FND_BENCH_OUTPUT;if(!output)throw new Error('Missing benchmark output');",`const output=process.env.FND_BENCH_OUTPUT;if(!output)throw new Error('Missing benchmark output');\n        await traceCpuReady;const traceCpuResult=await traceCpuPost('Profiler.stop');await writeFile(output+'.cpuprofile',JSON.stringify(traceCpuResult.profile));traceCpuSession.disconnect();`);
  if(process.env.FND_BENCH_NATIVE_TRACE==='1')observer=observer.replace('traceCpuSession.disconnect();','traceCpuSession.disconnect();await nativeTraceReady;await contentTracing.stopRecording(output+\'.native-trace.json\');');
}
await writeFile(path.join(output,'apps/desktop/src/main/benchmark-observer.ts'),observer);
let preload=await readFile(path.join(templates,'ui-preload.cts'),'utf8');
if(mode)preload=preload.replace('finally{',`finally{\n    const traceElapsed=performance.now()-at;\n    if(traceElapsed>200)console.info('benchmark-slow-ipc',JSON.stringify({at:Date.now(),channel,metric:channel==='diagnostics:recordPerformance'?(args[0] as {metric?:unknown})?.metric:undefined,elapsedMs:traceElapsed}));`);
await change('apps/desktop/src/preload/index.cts',text=>{
  const ast=ts.createSourceFile('preload.cts',text,ts.ScriptTarget.Latest,true);
  const imports=ast.statements.filter(ts.isImportDeclaration);const end=imports.at(-1)?.end;if(!end)throw Error('Missing preload imports');
  return text.slice(0,end)+'\n'+preload+'\n'+text.slice(end);
});
const templateHashes={};for(const name of ['ui-workload.ts','ui-observer.ts','ui-preload.cts'])templateHashes[name]=digest(await readFile(path.join(templates,name)));
if(mode){
  const trace=await readFile(path.join(templates,'source-view-trace.ts'),'utf8');templateHashes['source-view-trace.ts']=digest(trace);
  await change('apps/desktop/src/renderer/views/SourcesView.vue',text=>{
    let wrapper='';
    if(text.includes("import {sourceCapabilities}")){
      text=text.replace('import {sourceCapabilities}','import {sourceCapabilities as traceCapabilitySubject}');
      wrapper='function sourceCapabilities(...args:Parameters<typeof traceCapabilitySubject>){const at=performance.now();try{return traceCapabilitySubject(...args);}finally{traceCapabilityCalls++;traceCapabilityMs+=performance.now()-at;}}\n';
    }
    const reload="const results=await Promise.allSettled([window.desktop.source.list(),window.desktop.live.listSources(),window.desktop.source.health(),window.desktop.settings.list(),window.desktop.source.executableStatus()]);";
    if(text.split(reload).length!==2)throw Error('Missing source reload trace point');
    text=text.replace(reload,"const traceReloadStarted=performance.now();console.info('source-view-trace',JSON.stringify({phase:'reload-start',at:traceReloadStarted}));"+reload+"console.info('source-view-trace',JSON.stringify({phase:'reload-settled',at:performance.now(),waitMs:performance.now()-traceReloadStarted,statuses:results.map(item=>item.status)}));");
    return text.replace('<script setup lang="ts">','<script setup lang="ts">\n'+trace+'\n'+wrapper);
  });
  if(mode==='--trace-source-view-containment')await change('apps/desktop/src/renderer/styles.css',text=>text+'\n/* Diagnostic offscreen rendering containment; all rows remain in the document. */\n.source-group-body>tr:not(.source-group-row){content-visibility:auto;contain-intrinsic-size:auto 78px}\n');
  if(mode==='--trace-source-view-no-motion')await change('apps/desktop/src/renderer/styles.css',text=>text+'\n/* Diagnostic ablation only, never a production optimization. */\n.route-enter-active,.route-leave-active{transition:none!important;will-change:auto!important}.route-enter-from,.route-leave-to{opacity:1!important;transform:none!important}\n');
  if(mode==='--trace-source-view-separate-borders')await change('apps/desktop/src/renderer/styles.css',text=>text+'\n/* Diagnostic table layout comparison only. */\n.source-table{border-collapse:separate;border-spacing:0}\n');
}
await writeFile(path.join(output,'benchmark-observation.json'),JSON.stringify({schemaVersion:1,diagnostic:!!mode,routeMotionAblation:mode==='--trace-source-view-no-motion',source,commit:git(source,'rev-parse','HEAD').trim(),dirty:Boolean(git(source,'status','--porcelain').trim()),inventory,sourceInventorySha256:digest(JSON.stringify(inventory)),changes,templateHashes,prepareScriptSha256:digest(await readFile(fileURLToPath(import.meta.url))),nodeModulesRealSource:path.join(source,'node_modules'),warning:'Observation-only copy. Dependencies and compiled workspace packages remain those of the selected source checkout; no production business functions are replaced.'},null,2));
console.log(JSON.stringify({output,files:inventory.length,changed:changes.map(item=>item.path),templateHashes}));

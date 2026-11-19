// Run with the pinned Electron executable, not ELECTRON_RUN_AS_NODE.
// Exercises real PlayerClient/PlayerHost/Win32 code using the same local media.
const {app,BrowserWindow,screen}=require('electron');
const fs=require('node:fs');
const path=require('node:path');
const {createHash}=require('node:crypto');
const {pathToFileURL}=require('node:url');
const {performance}=require('node:perf_hooks');
const {execFileSync}=require('node:child_process');
const [rootArg,outputArg,mediaArg]=process.argv.slice(2);
if(!rootArg||!outputArg||!mediaArg)throw Error('Usage: electron benchmark-player-runtime.cjs <built-project> <new-result.json> <local-media>');
const root=path.resolve(rootArg),output=path.resolve(outputArg),media=path.resolve(mediaArg),profile=output+'.profile';
if(fs.existsSync(output)||fs.existsSync(profile))throw Error('Refusing to overwrite benchmark evidence/profile');
fs.mkdirSync(path.dirname(output),{recursive:true});fs.mkdirSync(profile);
app.setPath('userData',profile);app.setAppPath(root);
const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const result={schemaVersion:1,workload:'native-player-local-paused-v2',appVersion:JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).version,
 scope:'Real local native player and visible fixture parent; excludes Vue navigation, actual video presentation verification and full-app performance claims',
 electron:process.versions.electron,node:process.versions.node,mediaSha256:hash(media),
 nativeSha256:hash(path.join(root,'native/player-host/build/Release/player-host.exe')),mpvSha256:hash(path.join(root,'native/player-host/build/Release/libmpv-2.dll')),
 compiledClientSha256:hash(path.join(root,'apps/desktop/dist/main/player-client.js')),benchmarkSha256:hash(__filename),
 sourceDirty:Boolean(execFileSync('git',['-C',root,'status','--porcelain'],{encoding:'utf8',windowsHide:true}).trim()),
 sourceCommit:execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8',windowsHide:true}).trim(),startedAt:new Date().toISOString(),samples:{},errors:[]};
let client,parent,measuring=false,finished=false;
const samples=result.samples;
function record(name,value){if(measuring&&Number.isFinite(value))(samples[name]??=[]).push(value);}
async function timed(name,action){const started=performance.now();const value=await action();record(name,performance.now()-started);return value;}
function summarize(values){const sorted=[...values].sort((a,b)=>a-b);const p=ratio=>sorted[Math.max(0,Math.ceil(sorted.length*ratio)-1)];return{count:sorted.length,p50:p(.5),p95:p(.95),max:sorted.at(-1)};}
function finish(error){
 if(finished)return;finished=true;
 if(error)result.errors.push({stage:result.stage,message:String(error.message??error).slice(0,400)});
 result.status=result.errors.length?'failed':'passed';result.finishedAt=new Date().toISOString();
 result.metrics=Object.fromEntries(Object.entries(samples).map(([name,values])=>[name,summarize(values)]));
 try{client?.stop();parent?.destroy();fs.writeFileSync(output,JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({version:result.appVersion,status:result.status,metrics:result.metrics}));}
 finally{app.exit(result.errors.length?1:0);}
}
process.on('uncaughtException',finish);process.on('unhandledRejection',finish);
const deadline=setTimeout(()=>finish(Error('Benchmark deadline exceeded')),120000);deadline.unref();
app.whenReady().then(async()=>{
 try{
  result.stage='load';
  parent=new BrowserWindow({width:1000,height:700,show:true,title:'Free New Desk native benchmark',webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
  const scale=screen.getDisplayMatching(parent.getBounds()).scaleFactor;
  const {PlayerClient}=await import(pathToFileURL(path.join(root,'apps/desktop/dist/main/player-client.js')));
  client=new PlayerClient(record);client.setParentWindowHandle(parent.getNativeWindowHandle());
  const loaded=await client.load({url:pathToFileURL(media).href,profile:'vod'});if(!loaded.ok)throw Error(loaded.detail??'Load rejected');
  const paused=await client.command({command:'pause',value:true});if(!paused.ok)throw Error('Pause rejected');
  let initial;const settleStarted=performance.now();result.initialSampling=[];
  while(performance.now()-settleStarted<5000){
   try{initial=await client.query('stats');result.initialSampling.push({valid:initial.sampleValid,fresh:initial.sampleFresh,stable:initial.samplePositionStable,paused:initial.paused,width:initial.width,height:initial.height});
    if(initial.sampleValid&&initial.sampleFresh&&initial.samplePositionStable!==false&&initial.paused&&initial.width>0&&initial.height>0)break;
   }catch(error){result.initialSampling.push({pending:String(error.message).includes('PLAYBACK_STATS_PENDING')});}
   await new Promise(resolve=>setTimeout(resolve,50));
  }
  result.settleMs=performance.now()-settleStarted;
  if(!initial?.sampleValid||!initial.sampleFresh||initial.samplePositionStable===false||!initial.paused||!initial.width||!initial.height)throw Error('Missing valid fresh stable paused sample after 5s');
  result.media={width:initial.width,height:initial.height,duration:initial.duration,videoCodec:initial.videoFormat,hwdec:initial.hwdec};
  const geometry={x:20,y:40,width:640,height:360,scale};result.geometry=geometry;
  result.stage='surface';
  for(let i=0;i<130;i++){
   measuring=i>=10;
   const shown=await timed('surfaceAttachCommandMs',()=>client.command({command:'window-sync',...geometry,visible:true}));if(!shown.ok)throw Error(shown.detail??'Surface attach rejected');
   const hidden=await timed('surfaceHideCommandMs',()=>client.command({command:'window-sync',...geometry,visible:false}));if(!hidden.ok)throw Error(hidden.detail??'Surface hide rejected');
  }
  result.stage='queries';
  for(let i=0;i<130;i++){
   measuring=i>=10;
   const stats=await timed('statsQueryMs',()=>client.query('stats'));
   if(!stats.sampleValid||!stats.sampleFresh||stats.samplePositionStable===false||!stats.paused)throw Error('Invalid benchmark sample');
   await timed('loadStatusQueryMs',()=>client.query('load-status'));
   await timed('tracksQueryMs',()=>client.query('tracks'));
   await new Promise(resolve=>setTimeout(resolve,20));
  }
  finish();
 }catch(error){finish(error);}
});

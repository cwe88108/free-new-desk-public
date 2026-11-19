import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';

async function statsSubject(session,sample){
  const text=await readFile(new URL('../../apps/desktop/src/main/player-client.ts',import.meta.url),'utf8');
  const source=ts.createSourceFile('client.ts',text,ts.ScriptTarget.Latest,true);
  const cls=source.statements.find(node=>ts.isClassDeclaration(node)&&node.name.text==='PlayerClient');
  const method=cls.members.find(node=>ts.isMethodDeclaration(node)&&node.name.getText(source)==='#queryOnce').getText(source);
  const context={process:{platform:'win32'},performance,runtimeController:{current:()=>({...session})},sample,PlaybackSupersededError:Error,STATS_HARD_EXPIRY_MS:15000,STATS_SOFT_STALE_MS:3000};
  vm.runInNewContext(ts.transpileModule(`class Subject {#acceptedEpoch='epoch';#sampleSeq=0;#seekRevision=0;#lastStatsAt=0;#statsState='pending';#lastStats;#resetTransportFaults(){}recordMetric(){}recordCounter(){}async #sendWithRecovery(){return sample;}${method}query(query='stats'){return this.#queryOnce(query);}}globalThis.client=new Subject();`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,context);
  return context.client;
}
const pending={sampleValid:false,hostEpoch:'epoch',loadId:'old-live',path:'live.avi',duration:30,position:4};
test('VOD requested state never relabels old live statistics with its request identity',async()=>{
  const client=await statsSubject({requestId:'new-vod',domain:'vod',generation:2,status:'requested'},pending);
  await assert.rejects(client.query(),/PLAYBACK_STATS_PENDING/);
});
test('unverified pending samples are rejected even with matching load ID and host epoch',async()=>{
  const current={requestId:'vod',domain:'vod',generation:2,status:'loading',loadId:'current'};
  for(const sample of [pending,{...pending,loadId:'current',hostEpoch:'old-host'}]){
    await assert.rejects((await statsSubject(current,sample)).query(),/PLAYBACK_STATS_PENDING/);
  }
  await assert.rejects((await statsSubject(current,{...pending,loadId:'current',path:'vod.avi'})).query(),/PLAYBACK_STATS_PENDING/);
});
test('fresh matching samples remain authoritative',async()=>{
  const current={requestId:'vod',domain:'vod',generation:2,status:'playing',loadId:'current'};
  const result=await (await statsSubject(current,{...pending,loadId:'current',sampleValid:true,sampleSeq:1})).query();
  assert.equal(result.sampleFresh,true);assert.equal(result.requestId,'vod');
});
async function functionText(path,name){
  let text=await readFile(new URL('../../'+path,import.meta.url),'utf8');
  if(path.endsWith('.vue'))text=text.match(/<script setup[^>]*>([\s\S]*?)<\/script>/)[1];
  const source=ts.createSourceFile('subject.ts',text,ts.ScriptTarget.Latest,true);
  return source.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text===name).getText(source);
}
function evaluate(text,context){vm.runInNewContext(ts.transpileModule(text,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,context);return context;}
test('stale or mismatched native key samples cannot switch channels or consume their sequence',async()=>{
  let switches=0;const context={runtimeSession:{requestId:'new',loadId:'new-load'},lastInputSequence:0,fullscreen:true,playbackKind:'live',activeLive:{},switchLiveChannel:()=>{switches++;},showLiveChannelGuide(){}};
  evaluate(await functionText('apps/desktop/src/preload/index.cts','consumeNativeInput'),context);
  const key={inputSequence:1,inputKey:'ArrowDown',requestId:'new',loadId:'new-load'};
  context.consumeNativeInput({...key,sampleFresh:false});context.consumeNativeInput({...key,sampleFresh:true,loadId:'old-load'});
  assert.equal(switches,0);assert.equal(context.lastInputSequence,0);
  context.consumeNativeInput({...key,sampleFresh:true});assert.equal(switches,1);
});
test('app now-playing bar does not display pending old media',async()=>{
  const context={playerStats:{value:null},playerReachable:{value:false},refreshPlaybackClock:async()=>{},window:{desktop:{playback:{query:async()=>pending}}}};
  evaluate(await functionText('apps/desktop/src/renderer/App.vue','refreshPlayer'),context);
  await context.refreshPlayer();assert.equal(context.playerStats.value,null);assert.equal(context.playerReachable.value,false);
});
test('fullscreen overlay hides on pending, mismatched or unavailable stats',async()=>{
  let hidden=0,sent=0;const session={domain:'vod',requestId:'new',loadId:'new-load'};
  const context={polling:false,closing:false,getCurrentPlayerClient:()=>({query:async()=>({...pending,fullscreen:true,requestId:'new'})}),getPlayerRuntimeSession:()=>session,lastVisible:true,lastState:'old',overlay:{isDestroyed:()=>false,hide:()=>{hidden++;}},sendState:()=>{sent++;}};
  evaluate(await functionText('apps/desktop/src/main/fullscreen-overlay.ts','hideOverlay'),context);
  evaluate(await functionText('apps/desktop/src/main/fullscreen-overlay.ts','poll'),context);
  await context.poll();assert.equal(hidden,1);assert.equal(sent,0);assert.equal(context.lastState,'');
  context.lastVisible=true;context.getCurrentPlayerClient=()=>({query:async()=>{throw new Error('pending');}});
  await context.poll();assert.equal(hidden,2);assert.equal(sent,0);
});
test('PlayerView clears previous media details when runtime identity changes',async()=>{
  const context={runtimeSession:{value:{generation:1,requestId:'old',loadId:'old-load',updatedAt:1}},stats:{value:pending},tracks:{value:[{}]},loadStatus:{value:{}},lastFailed:{value:null},autoAdvanceLocked:false,consumedEofLoadId:''};
  evaluate(await functionText('apps/desktop/src/renderer/views/PlayerView.vue','applyRuntime'),context);
  context.applyRuntime({generation:2,requestId:'new',domain:'vod',status:'requested',updatedAt:2});
  assert.equal(context.stats.value,null);assert.equal(context.tracks.value.length,0);assert.equal(context.loadStatus.value,null);
});
test('metadata readiness ignores pending dimensions from an earlier sample',async()=>{
  let queries=0;const metrics=[];
  const context={getPlayerRuntimeSession:()=>({requestId:'new'}),player:{query:async()=>({width:640,height:360,sampleFresh:++queries>1})},setTimeout:resolve=>resolve(),performance,recordPerformanceMetric:(...args)=>metrics.push(args)};
  evaluate(await functionText('apps/desktop/src/main/index.ts','measureVideoMetadata'),context);
  await context.measureVideoMetadata(performance.now());assert.equal(queries,2);assert.equal(metrics.length,1);
});
function deferred(){let resolve;const promise=new Promise(yes=>{resolve=yes;});return{resolve,promise};}
test('late tracks response is rejected after another request or same-session route wins',async()=>{
  for(const change of [{requestId:'new'},{loadId:'new-load'}]){
    const session={requestId:'old',loadId:'old-load'},response=deferred();
    const client=await statsSubject(session,response.promise),query=client.query('tracks');
    Object.assign(session,change);response.resolve([{id:'old-track'}]);
    await assert.rejects(query);
  }
});
test('preload fullscreen notifications require freshness and current identity at response time',async()=>{
  const notices=[];let response=deferred();
  const context={runtimeSession:{requestId:'old',loadId:'old-load'},ipcRenderer:{invoke:()=>response.promise},notifyFullscreen:value=>notices.push(value)};
  evaluate(await functionText('apps/desktop/src/preload/index.cts','playbackQuery'),context);
  let query=context.playbackQuery('stats');context.runtimeSession={requestId:'new',loadId:'new-load'};
  response.resolve({sampleFresh:true,requestId:'old',loadId:'old-load',fullscreen:true});await query;assert.equal(notices.length,0);
  response=deferred();query=context.playbackQuery('stats');response.resolve({sampleFresh:false,requestId:'new',loadId:'new-load',fullscreen:true});await query;assert.equal(notices.length,0);
  response=deferred();query=context.playbackQuery('stats');response.resolve({sampleFresh:true,requestId:'new',loadId:'new-load',fullscreen:true});await query;assert.deepEqual(notices,[true]);
});
test('PlayerView ignores tracks from a replaced request or load',async()=>{
  for(const change of [{requestId:'new'},{loadId:'new-load'}]){
    const old=deferred(),current=deferred(),responses=[old,current];
    const original={generation:1,requestId:'old',loadId:'old-load',status:'playing',updatedAt:1};
    const context={runtimeSession:{value:original},tracks:{value:[]},tracksRefresh:undefined,
      window:{desktop:{playback:{query:()=>responses.shift().promise}}}};
    evaluate(await functionText('apps/desktop/src/renderer/views/PlayerView.vue','refreshTracks'),context);
    context.refreshTracks();
    context.runtimeSession.value={...original,...change};
    context.refreshTracks();
    old.resolve([{id:'old-track'}]);
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(context.tracks.value.length,0);
    current.resolve([{id:'current-track'}]);
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(context.tracks.value[0].id,'current-track');
  }
});
test('pending track queries do not gate playback stats or duplicate natural EOF advance',async()=>{
  const response=deferred();
  const session={generation:1,requestId:'request',loadId:'load',status:'playing'};
  const stats={requestId:'request',loadId:'load',sampleFresh:false};
  let queries=0,advances=0;
  const context={runtimeSession:{value:session},stats:{value:null},tracks:{value:[]},tracksRefresh:undefined,
    loadStatus:{value:null},clockRuntime:{value:session},clockLoadStatus:{value:null},clockStats:{value:stats},
    clockStale:{value:false},isVod:{value:true},autoNext:{value:true},canNext:{value:true},
    actualDomain:{value:'vod'},liveBufferProbe:undefined,liveBufferingLoadId:{value:''},
    consumedEofLoadId:'',autoAdvanceLocked:false,applyRuntime(){},
    playAdjacent:async(index,reason)=>{assert.equal(index,1);assert.equal(reason,'auto-next');advances++;},
    window:{desktop:{playback:{query:()=>{queries++;return response.promise;}}}}};
  for(const symbol of ['refreshTracks','updateLiveBuffering','refresh']){
    evaluate(await functionText('apps/desktop/src/renderer/views/PlayerView.vue',symbol),context);
  }
  await context.refresh();
  assert.equal(context.stats.value,stats);
  context.clockStats.value=null;
  context.clockLoadStatus.value={loadId:'load',status:'ended',error:'eof'};
  await context.refresh();
  await context.refresh();
  assert.equal(queries,1);
  assert.equal(advances,1);
  response.resolve([]);
});

test('live buffering requires a sustained stall and clears on pause, recovery or a new load',async()=>{
  let now=0;
  const context={actualDomain:{value:'live'},runtimeSession:{value:{status:'playing'}},
    seeking:{value:false},liveBufferProbe:undefined,liveBufferingLoadId:{value:''},performance:{now:()=>now}};
  evaluate(await functionText('apps/desktop/src/renderer/views/PlayerView.vue','updateLiveBuffering'),context);
  const sample={loadId:'first',position:8,cacheDuration:0,sampleFresh:true};
  const update=(time,values={})=>{now=time;context.updateLiveBuffering({...sample,...values});return context.liveBufferingLoadId.value;};
  assert.equal(update(0),'');
  assert.equal(update(1000),'');
  assert.equal(update(2000),'first');
  assert.equal(update(2100,{paused:true}),'');
  assert.equal(update(2200),'');
  assert.equal(update(4000),'first');
  assert.equal(update(4100,{position:9,cacheDuration:2}),'');
  assert.equal(update(4200),'');
  assert.equal(update(6000),'first');
  assert.equal(update(6100,{loadId:'second'}),'');
});

test('live stall recovery cancels only for user pause or fresh progress on the active load',async()=>{
  const session={requestId:'live-request',lastPosition:9.8,lastProgressAt:100,stallStartedAt:200};
  const fresh={requestId:session.requestId,loadId:'current',position:12,sampleFresh:true,samplePositionStable:true};
  let current=fresh;
  const runtimeSession={status:'playing',loadId:'current'};
  const context={runtimeSession,assertLiveIntent:async()=>{},playbackQuery:async()=>current,Date:{now:()=>1000}};
  evaluate(await functionText('apps/desktop/src/preload/index.cts','shouldCancelLiveRecovery'),context);
  for(const sample of [{loadId:'old'},{sampleFresh:false},{samplePositionStable:false},{pausedForCache:true},{position:9.81}]){
    current={...fresh,...sample};
    assert.equal(await context.shouldCancelLiveRecovery(session,1,'stall'),false);
  }
  current=fresh;
  assert.equal(await context.shouldCancelLiveRecovery(session,1,'terminal'),false);
  assert.equal(await context.shouldCancelLiveRecovery(session,1,'stall'),true);
  assert.equal(session.lastProgressAt,1000);
  assert.equal(session.stallStartedAt,0);
  runtimeSession.status='paused';
  assert.equal(await context.shouldCancelLiveRecovery(session,1,'stall'),true);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import {parse} from '@vue/compiler-sfc';
const ref=value=>({value});
function deferred(){let resolve;const promise=new Promise(yes=>{resolve=yes;});return{resolve,promise};}
function run(code,context){vm.runInNewContext(ts.transpileModule(code,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,context);}
async function view(name,method,context){const code=parse(await readFile(new URL('../../apps/desktop/src/renderer/views/'+name+'.vue',import.meta.url),'utf8')).descriptor.scriptSetup.content,source=ts.createSourceFile('view.ts',code,ts.ScriptTarget.Latest,true),node=source.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name.text===method);run(node.getText(source)+'\nglobalThis.action='+method,context);return context.action;}
for(const [name,method,domain]of [['VodView','play','vod'],['SearchView','play','vod'],['SearchView','playLive','live'],['LiveView','openPlayer','live'],['LiveView','play','live']])test(name+'.'+method+' submits playback before awaiting navigation or surface cleanup',async()=>{
  const events=[],navigation=deferred(),cleanup=deferred(),opened=deferred();
  const context={console,performance:{now:()=>1},crypto:{randomUUID:()=> 'pending'},error:ref(''),detail:ref({id:'video',name:'Video',episodes:[]}),detailSource:ref('source'),sourceId:ref('source'),selectedSource:ref({name:'Source'}),playBusy:ref(false),nowPlaying:ref(null),previewActive:ref(true),manualRoute:ref(null),selected:ref({id:'channel',name:'Channel'}),fallbackEnabled:ref(true),activeRoute:ref(0),playbackSession:{begin:()=>{},update:()=>{}},savePendingPlayback:()=>{},clearPendingPlayback:()=>{},emitPlaybackStage:()=>{},saveLiveSession:()=>{},toast:{error:()=>{}},localStorage:{setItem:()=>{}},syncPreview:()=>{events.push('cleanup');return cleanup.promise;},router:{push:()=>{events.push('navigation');return navigation.promise;}}};
  const dispatch=kind=>{events.push(kind);return opened.promise;};
  context.window={desktop:{playback:{play:()=>dispatch('vod')},live:{play:()=>dispatch('live')},diagnostics:{recordPerformance:async()=>true},app:{isUiSmoke:()=>false}}};
  context.playStatus=ref('');context.switchReasons=ref([]);context.nextTick=async()=>{};context.schedulePreview=()=>{};
  const action=await view(name,method,context),pending=method==='playLive'?action({sourceId:'source',channelId:'channel',name:'Channel'}):method==='openPlayer'?action():name==='LiveView'?action({id:'channel',name:'Channel'},undefined,true):action('route','episode','Episode');
  assert.equal(events[0],domain);await new Promise(resolve=>setImmediate(resolve));assert.ok(events.includes('navigation'),'navigation must be dispatched while media opening and surface cleanup remain unresolved');cleanup.resolve();navigation.resolve();opened.resolve({ok:true,routeIndex:0,routeCount:1});await pending;
  assert.ok(events.indexOf(domain)<events.indexOf('navigation'));
});

test('search live reports load failure and ignores a superseded request',async()=>{
  for(const superseded of [false,true]){
    const stages=[],updates=[];
    const ctx={performance:{now:()=>0},error:ref(''),router:{push:async()=>{}},playbackSession:{begin:()=>{},update:value=>updates.push(value)},emitPlaybackStage:(...args)=>stages.push(args),window:{desktop:{live:{play:async()=>{if(superseded)throw new Error('[PLAYBACK_SUPERSEDED]');return{ok:false,detail:'station failed'};}},diagnostics:{recordPerformance:async()=>true},app:{isUiSmoke:()=>false}}}};
    const action=await view('SearchView','playLive',ctx);
    await action({sourceId:'source',channelId:'channel',name:'Channel'});
    await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual(stages.map(([stage])=>stage),superseded?['connecting']:['connecting','failed']);
    assert.deepEqual(updates,[]);
  }
});

test('a superseded VOD click clears only its pending playback without showing a failure',async()=>{
  const stages=[],cleared=[],toasts=[];
  const ctx={performance:{now:()=>0},error:ref(''),detail:ref({id:'video',name:'Video',episodes:[]}),sourceId:ref('source'),selectedSource:ref(null),playBusy:ref(false),nowPlaying:ref(null),localStorage:{setItem:()=>{}},crypto:{randomUUID:()=> 'old-pending'},savePendingPlayback:()=>{},clearPendingPlayback:id=>cleared.push(id),router:{push:async()=>{}},playbackSession:{begin:()=>{}},emitPlaybackStage:stage=>stages.push(stage),toast:{error:message=>toasts.push(message)},window:{desktop:{playback:{play:async()=>{throw new Error('[PLAYBACK_SUPERSEDED]');}},diagnostics:{recordPerformance:async()=>true},app:{isUiSmoke:()=>false}}}};
  const action=await view('VodView','play',ctx);
  await action('route','episode','Episode');
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(cleared,['old-pending']);
  assert.deepEqual(stages,['source-resolving']);
  assert.deepEqual(toasts,[]);
  assert.equal(ctx.playBusy.value,false);
});

test('opening the live player reports a failed load without saving a successful route',async()=>{
  const stages=[],saved=[];
  const ctx={performance:{now:()=>0},selected:ref({id:'channel',name:'Channel'}),sourceId:ref('source'),manualRoute:ref(null),fallbackEnabled:ref(true),activeRoute:ref(null),previewActive:ref(true),syncPreview:async()=>{},router:{push:async()=>{}},emitPlaybackStage:(...args)=>stages.push(args),saveLiveSession:value=>saved.push(value),window:{desktop:{live:{play:async()=>({ok:false,routeIndex:0,detail:'channel unavailable'})},diagnostics:{recordPerformance:async()=>true},app:{isUiSmoke:()=>false}}}};
  const action=await view('LiveView','openPlayer',ctx);
  await action();
  assert.deepEqual(stages.map(([stage])=>stage),['connecting','failed']);
  assert.equal(stages[1][2],'channel unavailable');
  assert.equal(ctx.activeRoute.value,null);
  assert.deepEqual(saved,[]);
});

test('stale automatic requests are rejected in preload before disturbing active live recovery state',async()=>{
  const code=await readFile(new URL('../../apps/desktop/src/preload/index.cts',import.meta.url),'utf8'),source=ts.createSourceFile('preload.ts',code,ts.ScriptTarget.Latest,true);
  const helper=source.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name.text==='playbackIntentInput');
  const expose=source.statements.find(n=>ts.isExpressionStatement(n)&&ts.isCallExpression(n.expression)&&n.expression.expression.getText(source)==='contextBridge.exposeInMainWorld').expression.arguments[1];
  for(const domain of ['music','vod']){
    const section=expose.properties.find(p=>p.name?.getText(source)===(domain==='music'?'music':'playback')).initializer;
    const play=section.properties.find(p=>p.name?.getText(source)==='play').initializer;
    const calls=[],live={requestId:'live'},ctx={runtimeSession:{domain:'live',requestId:'live',loadId:'live-load',controlRevision:0},activeLive:live,liveGeneration:7,playbackKind:'live',ipcRenderer:{invoke:async(...args)=>{calls.push(args);return{ok:true};}}};
    run(helper.getText(source)+'\nglobalThis.play='+play.getText(source),ctx);
    assert.throws(()=>ctx.play({initiator:'auto-next'}),/PLAYBACK_SUPERSEDED/);assert.equal(ctx.activeLive,live);assert.equal(ctx.liveGeneration,7);assert.equal(ctx.playbackKind,'live');assert.equal(calls.length,0);
    ctx.runtimeSession={domain,requestId:'parent',loadId:'parent-load',controlRevision:3};
    assert.throws(()=>ctx.play({initiator:'auto-next',parentRequestId:'parent',expectedLoadId:'parent-load',expectedControlRevision:2}),/PLAYBACK_SUPERSEDED/);
    await ctx.play({initiator:'auto-next'});assert.equal(calls[0][1].parentRequestId,'parent');assert.equal(calls[0][1].expectedControlRevision,3);assert.equal(ctx.liveGeneration,7);
  }
});

for(const [name,method]of [['HomeView','resume'],['HistoryView','resume'],['HistoryView','playFromStart']])test(name+'.'+method+' binds follow-up seek to the playback receipt, never to a newer global session',async()=>{
  for(const identity of [{requestId:'played-request',loadId:'played-load'},undefined]){
    const controls=[],ctx={resumableFirst:ref(null),resuming:ref(false),actionMessage:ref(''),busyId:ref(''),error:ref(''),canResume:()=>true,toast:{error:()=>{}},router:{push:async()=>{}},window:{desktop:{playback:{play:async()=>({ok:true,session:identity}),control:async value=>{controls.push(value);return{ok:true};}}}}};
    const action=await view(name,method,ctx);await action({id:'history',sourceId:'source',videoId:'video',videoName:'Video',flag:'route',episodeId:'ep',episodeName:'Episode',position:20});
    assert.equal(controls.length,identity?1:0);if(identity){assert.equal(controls[0].requestId,identity.requestId);assert.equal(controls[0].loadId,identity.loadId);}else assert.match(ctx.error.value+ctx.actionMessage.value,/缺少会话身份/);
  }
});

test('renderer presentation updates cannot replace the authoritative media identity or timestamp',async()=>{
  const text=await readFile(new URL('../../apps/desktop/src/renderer/stores/playback-session.ts',import.meta.url),'utf8'),source=ts.createSourceFile('store.ts',text,ts.ScriptTarget.Latest,true),declaration=source.statements.flatMap(n=>ts.isVariableStatement(n)?[...n.declarationList.declarations]:[]).find(n=>n.name.getText(source)==='usePlaybackSessionStore');
  const ctx={defineStore:(_name,create)=>create(),reactive:value=>value,computed:read=>({get value(){return read();}}),window:{desktop:{playback:{onRuntimeSessionChanged:()=>{},onFullscreenChanged:()=>{},runtimeSession:()=>new Promise(()=>{})}}}};
  run('globalThis.store='+declaration.initializer.getText(source),ctx);const store=ctx.store;
  store.applyRuntime({generation:4,sessionId:'session',requestId:'music',domain:'music',status:'playing',loadId:'music-load',sourceId:'music-source',updatedAt:100});
  store.begin({kind:'live',requestId:'fake',loadId:'fake',status:'playing',sourceId:'preview-source',channelId:'preview',updatedAt:999});store.update({fullscreen:true,updatedAt:1000});
  assert.equal(store.state.kind,'music');assert.equal(store.state.requestId,'music');assert.equal(store.state.sourceId,'music-source');assert.equal(store.state.updatedAt,100);assert.equal(store.state.fullscreen,true);
  store.applyRuntime({generation:5,sessionId:'next',requestId:'live',domain:'live',status:'loading',sourceId:'live-source',channelId:'channel',routeIndex:1,routeCount:3,updatedAt:101});
  assert.equal(store.state.sourceId,'live-source');assert.equal(store.state.channelId,'channel');assert.equal(store.state.routeIndex,1);
});

test('mini player controls use the displayed sample identity and report stale control rejection',async()=>{
  for(const method of ['pause','mute','volume']){
    const controls=[],ctx={reachable:ref(true),playerStats:ref({requestId:'displayed',loadId:'displayed-load',paused:false,muted:false}),miniError:ref(''),refresh:async()=>{},window:{desktop:{playback:{control:async value=>{controls.push(value);return{ok:false,detail:'PLAYBACK_SUPERSEDED'};}}}}};
    ctx.controlDisplayedPlayer=await view('HomeShellView','controlDisplayedPlayer',ctx);
    const action=await view('HomeShellView',method,ctx);await action({target:{value:'35'}});
    assert.equal(controls.length,1);assert.equal(controls[0].requestId,'displayed');assert.equal(controls[0].loadId,'displayed-load');assert.match(ctx.miniError.value,/PLAYBACK_SUPERSEDED/);
    ctx.playerStats.value={};await action({target:{value:'35'}});assert.equal(controls.length,1);assert.match(ctx.miniError.value,/播放会话已变化/);
  }
});

test('preload cannot relabel an old window-sync ACK or fullscreen ACK as a new session',async()=>{
  const code=await readFile(new URL('../../apps/desktop/src/preload/index.cts',import.meta.url),'utf8'),source=ts.createSourceFile('preload.ts',code,ts.ScriptTarget.Latest,true),method=source.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name.text==='playbackControl');
  for(const command of ['window-sync','fullscreen']){
    const pending=deferred(),calls=[],oldSync={requestId:'earlier',command:'window-sync'},effects=[],ctx={runtimeSession:{requestId:'old'},lastWindowSync:oldSync,performance:{now:()=>1},ipcRenderer:{invoke:(_channel,value)=>{calls.push(value);return pending.promise;}},notifyFullscreen:()=>effects.push('fullscreen'),recordMetric:()=>effects.push('metric')};
    run(method.getText(source)+'\nglobalThis.action=playbackControl',ctx);const result=ctx.action({command,value:true});assert.equal(calls[0].requestId,'old');
    ctx.runtimeSession={requestId:'new'};pending.resolve({ok:true});assert.equal((await result).ok,false);assert.equal(ctx.lastWindowSync,oldSync);assert.equal(effects.length,0);
  }
});

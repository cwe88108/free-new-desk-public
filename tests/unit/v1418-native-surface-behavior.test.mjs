import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';
import {parse} from '@vue/compiler-sfc';

const root=new URL('../../',import.meta.url);
const bounds={x:20,y:40,width:640,height:360};
function deferred(){let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};}
async function harness(control=async()=>({ok:true}),rollback={}){
  const calls=[],runtimeListeners=[],context=vm.createContext({crypto:{randomUUID},performance,console});
  context.document={documentElement:{dataset:{}}};
  context.localStorage={getItem:()=>null};
  context.window={devicePixelRatio:1,desktop:{rollback,diagnostics:{recordPerformance:async()=>true},playback:{
    control:async command=>{calls.push({...command});return control(command);},onFullscreenChanged:()=>()=>{},
    onRuntimeSessionChanged:listener=>{runtimeListeners.push(listener);return()=>{};},
  }}};
  async function load(source,require=()=>{throw new Error('Unexpected dependency');}){
    const module={exports:{}};
    const output=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
    vm.runInContext('(function(module,exports,require){\n'+output+'\n})',context)(module,module.exports,require);
    return module.exports;
  }
  const surface=await load(await readFile(new URL('apps/desktop/src/renderer/native-surface.ts',root),'utf8'));
  return{calls,context,load,surface,runtime:value=>runtimeListeners.forEach(listener=>listener(value))};
}

test('native occlusion rollback skips panel hiding while keeping clipped surfaces hidden',async()=>{
  const standard=await harness(),legacy=await harness(undefined,{nativeOcclusion:true});
  for(const [h,visibleBehindPanel] of [[standard,false],[legacy,true]]){
    h.context.window.document={querySelector:()=>({getBoundingClientRect:()=>({left:0,top:0,right:660,bottom:500})})};
    const lease=h.surface.createNativeSurfaceLease('player');
    await lease.sync(bounds);
    h.surface.setNativeSurfaceOccluded('menu',true);
    await lease.restore();
    assert.equal(h.calls.at(-1).visible,visibleBehindPanel);
    h.surface.setNativeSurfaceOccluded('menu',false);
    await lease.restore();
    assert.equal(h.calls.at(-1).visible,true);
    await lease.sync({...bounds,x:22});
    assert.equal(h.calls.at(-1).visible,false);
    await lease.release();
  }
});

test('surface reclaim sends show again after another owner releases identical geometry',async()=>{
  const {surface,calls}=await harness();
  const a=surface.createNativeSurfaceLease('a'),b=surface.createNativeSurfaceLease('b');
  await a.sync(bounds);await b.sync(bounds);await b.release();
  const before=calls.length;
  assert.equal(await a.sync(bounds),true);
  assert.equal(calls.length,before+1);
  assert.equal(calls.at(-1).visible,true);
  await a.release();
});

test('late ACK cannot authorize a reclaimed owner, even when the owner ID is unchanged',async()=>{
  const sent=deferred(),ack=deferred();let first=true;
  const {surface,calls}=await harness(async()=>{if(first){first=false;sent.resolve();return ack.promise;}return{ok:true};});
  const a=surface.createNativeSurfaceLease('a'),b=surface.createNativeSurfaceLease('b');
  const old=a.sync(bounds);await sent.promise;
  const displaced=b.sync(bounds),reclaimed=a.sync(bounds);
  ack.resolve({ok:true});
  assert.equal(await old,false);
  assert.equal(await displaced,false);
  assert.equal(await reclaimed,true);
  assert.equal(calls.length,2,'current generation must obtain its own show ACK');
  await a.release();await b.release();
});

test('release while sync is in flight rejects its ACK and does not hide the new owner',async()=>{
  const sent=deferred(),ack=deferred();let first=true;
  const {surface,calls}=await harness(async()=>{if(first){first=false;sent.resolve();return ack.promise;}return{ok:true};});
  const a=surface.createNativeSurfaceLease('a'),b=surface.createNativeSurfaceLease('b');
  const old=a.sync(bounds);await sent.promise;
  const release=a.release(),next=b.sync(bounds);
  ack.resolve({ok:true});
  assert.equal(await old,false);await release;assert.equal(await next,true);
  assert.equal(calls.at(-1).visible,true);
  assert.equal(calls.filter(command=>command.visible===false).length,0);
  await b.release();
});

test('replacement host invalidates same-bounds ACK and restores the active video surface',async()=>{
  const {surface,calls,runtime}=await harness();
  const a=surface.createNativeSurfaceLease('a');
  runtime({...session(1,'vod'),loadId:'old',hostEpoch:'host-1'});await a.sync(bounds);
  const before=calls.length;
  runtime({...session(1,'vod'),loadId:'new',hostEpoch:'host-2'});
  await a.restore();
  assert.equal(calls.length,before+1);
  assert.equal(calls.at(-1).visible,true);
  await a.release();
});

test('ACK from the previous host cannot acknowledge the new host',async()=>{
  const sent=deferred(),ack=deferred();let first=true;
  const {surface,calls,runtime}=await harness(async()=>{if(first){first=false;sent.resolve();return ack.promise;}return{ok:true};});
  const a=surface.createNativeSurfaceLease('a');
  runtime({...session(1,'vod'),loadId:'old',hostEpoch:'host-1'});
  const old=a.sync(bounds);await sent.promise;
  runtime({...session(1,'vod'),loadId:'new',hostEpoch:'host-2'});
  ack.resolve({ok:true});assert.equal(await old,false);
  assert.equal(await a.restore(),true);assert.equal(calls.length,2);
  await a.release();
});

async function playerView(control){
  const h=await harness(control),mounted=[];
  let leave,afterNavigation;
  h.context.requestAnimationFrame=()=>1;
  h.context.window.desktop.app={isUiSmoke:()=>false};
  const {descriptor}=parse(await readFile(new URL('apps/desktop/src/renderer/views/PlayerView.vue',root),'utf8'));
  const vue={watch:(_sources,fn,options)=>{if(options?.immediate)fn();return()=>{};},ref:value=>({value}),computed:get=>({get value(){return get();}}),nextTick:async()=>{},onMounted:fn=>mounted.push(fn),onBeforeUnmount:()=>{}};
  await h.load(descriptor.scriptSetup.content+'\nglobalThis.view={surface,runtimeSession,syncSurface,releaseSurface,surfaceError,applyRuntime};',name=>{
    if(name==='vue')return vue;
    if(name==='vue-router')return{useRouter:()=>({push:async()=>{},afterEach:fn=>{afterNavigation=fn;return()=>{};}}),onBeforeRouteLeave:fn=>{leave=fn;}};
    if(name==='../native-surface')return h.surface;
    if(name==='../playback-events')return{onPlaybackStage:()=>()=>{}};
    if(name==='../stores/playback-session')return{usePlaybackSessionStore:()=>({update:()=>{}}),clockStats:{value:null},clockStale:{value:true},clockLoadStatus:{value:null},clockRuntime:{value:{generation:0,requestId:'',domain:null,status:'idle',updatedAt:0}},refreshPlaybackClock:async()=>{}};
    throw new Error('Unexpected import '+name);
  });
  h.context.view.surface.value={getBoundingClientRect:()=>({...bounds,left:bounds.x,top:bounds.y})};
  return{...h,view:h.context.view,leave:()=>leave(),cancelNavigation:()=>afterNavigation(null,null,new Error('navigation cancelled'))};
}
function session(generation,domain){return{generation,requestId:String(generation),domain,status:'playing',updatedAt:generation};}

test('actual PlayerView recreates a video lease after music and can repeat the cycle',async()=>{
  const {view,calls}=await playerView(async()=>({ok:true}));
  for(let i=0;i<3;i++){
    view.applyRuntime(session(i*2+1,'music'));await view.syncSurface();
    view.applyRuntime(session(i*2+2,'vod'));await view.syncSurface();
    assert.equal(calls.at(-1).visible,true);
    assert.equal(view.surfaceError.value,'');
  }
  assert.equal(calls.filter(command=>command.visible).length,3);
  await view.releaseSurface();
});

test('stopped PlayerView releases the video surface and only reclaims it for a new playback',async()=>{
  const {view,calls}=await playerView();
  view.applyRuntime({...session(1,'vod'),loadId:'first'});await view.syncSurface();
  assert.equal(calls.at(-1).visible,true);
  view.applyRuntime({...session(1,'vod'),loadId:'first',updatedAt:2,status:'stopped'});await view.syncSurface();
  assert.equal(calls.at(-1).visible,false);
  const count=calls.length;await view.syncSurface();assert.equal(calls.length,count);
  view.applyRuntime({...session(2,'vod'),loadId:'next'});await view.syncSurface();
  assert.equal(calls.at(-1).visible,true);assert.equal(calls.length,count+1);
  await view.releaseSurface();
});

test('PlayerView retains a distinct surface error until a successful remount',async()=>{
  let ok=false;const {view}=await playerView(async()=>({ok,detail:'display unavailable'}));
  view.applyRuntime(session(1,'vod'));await view.syncSurface();
  assert.match(view.surfaceError.value,/播放器区域同步异常/);
  view.applyRuntime({...session(1,'vod'),updatedAt:2});
  assert.notEqual(view.surfaceError.value,'');
  ok=true;await view.syncSurface();assert.equal(view.surfaceError.value,'');
  await view.releaseSurface();
});

test('PlayerView cannot reacquire a lease while leaving and resumes if navigation is cancelled',async()=>{
  const sent=deferred(),hidden=deferred();
  const {view,calls,leave,cancelNavigation}=await playerView(async command=>{if(command.visible===false){sent.resolve();await hidden.promise;}return{ok:true};});
  view.applyRuntime(session(1,'vod'));await view.syncSurface();
  const navigation=leave();await sent.promise;
  const before=calls.length;await view.syncSurface();assert.equal(calls.length,before);
  hidden.resolve();await navigation;
  await view.syncSurface();assert.equal(calls.length,before);
  cancelNavigation();await view.syncSurface();assert.equal(calls.at(-1).visible,true);
  await view.releaseSurface();
});

test('surface release waits for the same real hide ACK on repeated calls',async()=>{
  const sent=deferred(),ack=deferred();
  const {surface,calls}=await harness(async command=>{if(!command.visible){sent.resolve();return ack.promise;}return{ok:true};});
  const a=surface.createNativeSurfaceLease('a');await a.sync(bounds);
  const first=a.release();await sent.promise;
  let finished=false;const second=a.release().then(()=>{finished=true;});
  await Promise.resolve();assert.equal(finished,false);
  ack.resolve({ok:true});await Promise.all([first,second]);
  assert.equal(calls.filter(command=>!command.visible).length,1);
});

test('surface release rejects a negative or missing hide ACK instead of reporting success',async()=>{
  for(const response of [()=>({ok:false,detail:'hide failed'}),()=>{throw new Error('transport lost');}]){
    const {surface}=await harness(async command=>command.visible?{ok:true}:response());
    const a=surface.createNativeSurfaceLease('a');await a.sync(bounds);
    await assert.rejects(a.release(),/hide failed|transport lost/);
    await assert.rejects(a.release(),/hide failed|transport lost/);
  }
});

test('a rejected hide leaves the lease recoverable after cancelled navigation',async()=>{
  let rejectHide=true;
  const {surface,calls}=await harness(async command=>({ok:command.visible||!rejectHide}));
  const a=surface.createNativeSurfaceLease('a');await a.sync(bounds);
  await assert.rejects(a.release());
  const before=calls.length;assert.equal(await a.sync(bounds),true);
  assert.equal(calls.length,before+1,'uncertain hide ACK must invalidate identical geometry show cache');
  rejectHide=false;await a.release();assert.equal(calls.at(-1).visible,false);
});

test('PlayerView retains a failed release and a second navigation must obtain hide ACK',async()=>{
  let rejectHide=true;
  const {view,calls,leave}=await playerView(async command=>({ok:command.visible||!rejectHide,detail:'hide failed'}));
  view.applyRuntime(session(1,'vod'));await view.syncSurface();
  await assert.rejects(leave(),/hide failed/);
  assert.match(view.surfaceError.value,/隐藏失败/);
  await assert.rejects(leave(),/hide failed/);
  assert.equal(calls.filter(command=>!command.visible).length,2,'failed navigation must retain and retry its lease');
  // Thrown router errors need recovery here, not solely an afterEach failure callback.
  await view.syncSurface();assert.equal(calls.at(-1).visible,true);
  rejectHide=false;await leave();assert.equal(calls.at(-1).visible,false);
  assert.equal(calls.filter(command=>!command.visible).length,3);
});


test('PlayerView restores identical bounds after native hide succeeds but its ACK is lost',async()=>{
  let nativeVisible=false,loseAck=true;
  const {view,calls,leave}=await playerView(async command=>{
    nativeVisible=command.visible;
    if(!command.visible&&loseAck)throw new Error('ACK lost');
    return{ok:true};
  });
  view.applyRuntime(session(1,'vod'));await view.syncSurface();assert.equal(nativeVisible,true);
  await assert.rejects(leave(),/ACK lost/);assert.equal(nativeVisible,false);
  const before=calls.length;await view.syncSurface();
  assert.equal(calls.length,before+1);assert.equal(nativeVisible,true);
  loseAck=false;await leave();assert.equal(nativeVisible,false);
});


test('release diagnostics retain queue and IPC stages without resolving before native ACK',async()=>{
  const sent=deferred(),showAck=deferred(),hideSent=deferred(),hideAck=deferred(),metrics=[];
  const h=await harness(async command=>{if(command.visible){sent.resolve();return showAck.promise;}hideSent.resolve();return hideAck.promise;});
  h.context.window.desktop.diagnostics.recordPerformance=async(metric,value)=>{metrics.push({metric,value});return true;};
  const a=h.surface.createNativeSurfaceLease('a');
  const showing=a.sync(bounds);await sent.promise;
  let finished=false;const release=a.release().then(()=>{finished=true;});
  await Promise.resolve();assert.equal(finished,false);assert.equal(metrics.some(x=>x.metric==='surfaceReleaseQueueMs'),false);
  showAck.resolve({ok:true});await showing;await hideSent.promise;
  assert.equal(finished,false);assert.equal(metrics.some(x=>x.metric==='surfaceReleaseQueueMs'),true);
  assert.equal(metrics.some(x=>x.metric==='surfaceReleaseIpcMs'),false);
  hideAck.resolve({ok:true});await release;
  assert.equal(metrics.some(x=>x.metric==='surfaceReleaseIpcMs'),true);
  assert.ok(metrics.every(x=>Number.isFinite(x.value)&&x.value>=0));
});


test('rejected hide still records IPC elapsed and clears its pending marker',async()=>{
  const metrics=[];
  const h=await harness(async command=>{if(!command.visible)throw new Error('transport failure');return{ok:true};});
  h.context.window.desktop.diagnostics.recordPerformance=async(metric,value)=>{metrics.push({metric,value});return true;};
  const a=h.surface.createNativeSurfaceLease('a');await a.sync(bounds);await assert.rejects(a.release(),/transport failure/);
  assert.ok(metrics.find(x=>x.metric==='surfaceReleaseIpcMs'));
  assert.deepEqual(metrics.filter(x=>x.metric==='surfaceReleaseIpcPending').map(x=>x.value),[1,0]);
  assert.deepEqual(metrics.filter(x=>x.metric==='surfaceReleaseQueuePending').map(x=>x.value),[1,0]);
});

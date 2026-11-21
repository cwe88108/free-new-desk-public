import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';

async function clock(rollback={}){
 const source=await readFile(new URL('../../apps/desktop/src/renderer/stores/playback-clock.ts',import.meta.url),'utf8');
 let sequence=0,pending=false,request='vod',load='load';
 const api={query:async kind=>{if(kind==='load-status')return{loadId:load,status:'loaded'};if(pending)throw Error('PLAYBACK_STATS_PENDING');return{requestId:request,loadId:load,hostEpoch:'host',sampleSeq:++sequence,sampleValid:true,sampleFresh:true,samplePositionStable:true,paused:true,position:123,duration:600};},runtimeSession:async()=>({generation:1,requestId:request,loadId:load,domain:'vod',status:'paused',updatedAt:sequence})};
 const frames=new Map(),listeners=new Map();let frameId=0,poll;
 api.onRuntimeSessionChanged=()=>()=>{};
 const context={exports:{},require:name=>{assert.equal(name,'vue');return{ref:value=>({value}),shallowRef:value=>({value})};},performance:{now:()=>100},
   window:{desktop:{playback:api,rollback},addEventListener:(name,callback)=>listeners.set(name,callback)},
   document:{hidden:false,addEventListener(){},removeEventListener(){}},Promise,Number,Math,setTimeout,clearTimeout,
   setInterval:callback=>{poll=callback;return 1;},clearInterval:()=>{poll=undefined;},
   requestAnimationFrame:callback=>{frames.set(++frameId,callback);return frameId;},cancelAnimationFrame:id=>frames.delete(id)};
 vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,context);
 return{...context.exports,setPending:value=>{pending=value;},setIdentity:(r,l)=>{request=r;load=l;},api,frames,
   poll:()=>poll?.(),unload:()=>listeners.get('beforeunload')?.()};
}
test('new renderer clock restores paused position and metadata without a playback control command',async()=>{
 const c=await clock();await c.refreshPlaybackClock();assert.equal(c.clockStats.value.paused,true);assert.equal(c.clockPosition.value,123);assert.equal(c.clockStale.value,false);
});
test('an initially pending native sample recovers on the next ordinary refresh',async()=>{
 const c=await clock();c.setPending(true);await c.refreshPlaybackClock();assert.equal(c.clockStats.value,null);assert.equal(c.clockStale.value,true);c.setPending(false);await c.refreshPlaybackClock();assert.equal(c.clockStats.value.position,123);assert.equal(c.clockRuntime.value.status,'paused');
});
test('an old response cannot populate a different authoritative runtime identity',async()=>{
 const c=await clock();c.api.query=async kind=>kind==='load-status'?{loadId:'old',status:'loaded'}:{requestId:'old',loadId:'old',hostEpoch:'host',sampleSeq:1,sampleValid:true,sampleFresh:true,samplePositionStable:true,position:4};await c.refreshPlaybackClock();assert.equal(c.clockStats.value,null);assert.equal(c.clockLoadStatus.value,null);
});

test('a new generation restores despite a newer preload idle timestamp',async()=>{
 const c=await clock();c.clockRuntime.value={generation:0,requestId:'',domain:null,status:'idle',updatedAt:99999};await c.refreshPlaybackClock();assert.equal(c.clockRuntime.value.status,'paused');assert.equal(c.clockPosition.value,123);
});

test('an older update within the same session cannot roll back its state',async()=>{
 const c=await clock();c.clockRuntime.value={generation:1,requestId:'vod',loadId:'load',domain:'vod',status:'playing',updatedAt:99999};await c.refreshPlaybackClock();assert.equal(c.clockRuntime.value.status,'playing');
});

test('a lower generation cannot replace the active session even with a later timestamp',async()=>{
 const c=await clock();c.clockRuntime.value={generation:2,requestId:'new',loadId:'new',domain:'music',status:'playing',updatedAt:0};await c.refreshPlaybackClock();assert.equal(c.clockRuntime.value.requestId,'new');assert.equal(c.clockStats.value,null);
});

test('idle or requested sessions do not poll native media, and an accepted load resumes sampling',async()=>{
 const c=await clock();let queries=0;const query=c.api.query;c.api.query=async kind=>{queries++;return query(kind);};c.setIdentity('','');await c.refreshPlaybackClock();assert.equal(queries,0);c.setIdentity('vod','');await c.refreshPlaybackClock();assert.equal(queries,0);c.setIdentity('vod','load');await c.refreshPlaybackClock();assert.equal(queries,2);assert.equal(c.clockPosition.value,123);
});

test('a failed runtime refresh retains a known active identity and can recover later',async()=>{
 const c=await clock();await c.refreshPlaybackClock();c.api.runtimeSession=async()=>{throw Error('temporary IPC failure');};await c.refreshPlaybackClock();assert.equal(c.clockStats.value.position,123);assert.equal(c.clockRuntime.value.requestId,'vod');
});

test('explicit stop clears samples even when request/load identity is retained, and stops native polling',async()=>{
 const c=await clock();await c.refreshPlaybackClock();assert.equal(c.clockPosition.value,123);
 let queries=0;c.api.query=async()=>{queries++;throw Error('Stopped sessions must not query native media');};
 c.api.runtimeSession=async()=>({generation:1,requestId:'vod',loadId:'load',domain:'vod',status:'stopped',updatedAt:99999});
 await c.refreshPlaybackClock();assert.equal(c.clockStats.value,null);assert.equal(c.clockLoadStatus.value,null);assert.equal(c.clockPosition.value,0);assert.equal(c.clockStale.value,true);assert.equal(queries,0);
});

test('only an observed, advancing music clock schedules visual frames',async()=>{
 const c=await clock();
 c.api.runtimeSession=async()=>({generation:1,requestId:'vod',loadId:'load',domain:'music',status:'playing',updatedAt:1});
 const query=c.api.query;
 c.api.query=async kind=>({...await query(kind),paused:false,speed:1});
 await c.refreshPlaybackClock();
 assert.equal(c.frames.size,0);
 const unsubscribe=c.observePlaybackPosition();
 assert.equal(c.frames.size,1);
 const [id,callback]=c.frames.entries().next().value;
 c.frames.delete(id);
 callback(120);
 assert.equal(c.clockPosition.value,123.02);
 assert.equal(c.frames.size,1);
 unsubscribe();
 assert.equal(c.frames.size,0);
});

test('clock rollback restores the idle frame loop and polling for this launch only',async()=>{
 const c=await clock({playbackClock:true});
 c.setIdentity('','');
 let reads=0;
 const runtimeSession=c.api.runtimeSession;
 c.api.runtimeSession=()=>{reads++;return runtimeSession();};
 c.startPlaybackClock();
 try {
   await c.refreshPlaybackClock();
   assert.equal(reads,1);
   assert.equal(c.frames.size,1);
   const [id,callback]=c.frames.entries().next().value;
   c.frames.delete(id);
   callback(120);
   assert.equal(c.frames.size,1);
   assert.equal(c.clockStale.value,true);
   c.poll();
   await c.refreshPlaybackClock();
   assert.equal(reads,2);
 } finally { c.unload(); }
 assert.equal(c.frames.size,0);
});

test('a response already in flight cannot restore stopped media with the same identity',async()=>{
 const c=await clock();await c.refreshPlaybackClock();let resolve,signal;const pending=new Promise(r=>resolve=r),queried=new Promise(r=>signal=r);
 c.api.query=()=>{signal();return pending;};const work=c.refreshPlaybackClock();await queried;
 c.clockRuntime.value={...c.clockRuntime.value,status:'stopped'};
 c.clockStats.value=null;c.clockLoadStatus.value=null;c.clockPosition.value=0;
 resolve({requestId:'vod',loadId:'load',hostEpoch:'host',sampleSeq:999,sampleValid:true,sampleFresh:true,samplePositionStable:true,position:999,status:'loaded'});
 await work;assert.equal(c.clockStats.value,null);assert.equal(c.clockLoadStatus.value,null);assert.equal(c.clockPosition.value,0);
});

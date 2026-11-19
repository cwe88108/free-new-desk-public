import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';

const view=await readFile(new URL('../../apps/desktop/src/renderer/views/PlayerView.vue',import.meta.url),'utf8');
const source=ts.createSourceFile('view.ts',view.match(/<script setup[^>]*>([\s\S]*?)<\/script>/)[1],ts.ScriptTarget.Latest,true);
const functions=source.statements.filter(node=>ts.isFunctionDeclaration(node)&&['refresh','refreshTracks','persistCurrentHistoryProgress','updateLiveBuffering'].includes(node.name?.text)).map(node=>node.getText(source)).join('\n');
const session={generation:1,requestId:'request-new',loadId:'load-new',historyId:'history-new',domain:'vod',status:'playing',sourceId:'local-race',videoId:'1',episodeId:'http://127.0.0.1:18080/vod.avi'};
const oldRow={id:'history-old',sourceId:session.sourceId,videoId:session.videoId,episodeId:session.episodeId};
const sample={requestId:session.requestId,loadId:session.loadId,domain:'vod',sessionGeneration:1,hostEpoch:'host',sampleSeq:1,seekRevision:0,sampleFresh:true,samplePositionStable:true,position:8,duration:60,volume:100,speed:1};

function subject({queueEntry=oldRow,current=session,stats=sample}={}){
  const updates=[];let now=10000;
  const ref=value=>({value});
  const context={Date:{now:()=>now},performance,Number,Boolean,Promise,console,
    runtimeSession:ref({...current}),loadStatus:ref(null),tracks:ref([]),tracksRefresh:undefined,stats:ref(null),clockStats:ref(stats),clockStale:ref(false),clockLoadStatus:ref({status:'playing',loadId:current.loadId}),clockRuntime:ref({...current}),refreshPlaybackClock:async()=>{},isVod:ref(true),
    fullscreen:ref(false),pip:ref(false),paused:ref(false),muted:ref(false),volumeTouched:ref(true),volume:ref(100),speed:ref(1),
    mediaSwitching:ref(false),bufferingStarted:0,videoMetadataStarted:0,seeking:ref(false),seekValue:ref(0),
    actualDomain:ref(current.domain),liveBufferProbe:undefined,liveBufferingLoadId:ref(''),
    currentQueueEntry:ref(queueEntry),lastProgressPersist:0,lastHistorySample:undefined,autoNext:ref(false),canNext:ref(false),
    applyRuntime(value){context.runtimeSession.value=value;},
    window:{desktop:{playback:{runtimeSession:async()=>({...current}),query:async kind=>kind==='stats'?stats:kind==='tracks'?[]:{status:'playing',loadId:current.loadId}},
      history:{list:async()=>{throw Error('progress must never infer its ID from list ordering');},updateProgress:async(...args)=>{updates.push(args);return true;}}}}
  };
  vm.runInNewContext(ts.transpileModule(functions,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,context);
  return {context,updates,advance:()=>{now+=6000;}};
}

test('saved queue replay persists to the ID bound to current playback, not the old queue row',async()=>{
  const {context,updates}=subject();await context.refresh();assert.deepEqual(updates,[['history-new',8,60]]);
});
test('unsaved, cleared, and saved-empty queues do not control the current history ID',async()=>{
  for(const queueEntry of [null,{...oldRow,id:'history-new'}]){
    const {context,updates}=subject({queueEntry});await context.refresh();assert.deepEqual(updates,[['history-new',8,60]]);
  }
});
test('missing bound history does not write an arbitrary queue ID',async()=>{
  const {context,updates}=subject({current:{...session,historyId:undefined}});await context.refresh();assert.deepEqual(updates,[]);
});
test('stale request/load samples and pending/unstable samples cannot write progress',async()=>{
  for(const change of [{requestId:'old'},{loadId:'old'},{sampleFresh:false},{samplePositionStable:false},{sampleSeq:undefined},{seekRevision:undefined}]){
    const {context,updates}=subject({stats:{...sample,...change}});await context.refresh();assert.deepEqual(updates,[]);
  }
});
test('delayed older sample cannot overwrite a newer position in the same session',()=>{
  const {context,updates,advance}=subject();
  context.persistCurrentHistoryProgress({...sample,sampleSeq:2,position:16});advance();
  context.persistCurrentHistoryProgress({...sample,sampleSeq:1,position:8});
  assert.deepEqual(updates,[['history-new',16,60]]);
});
test('watermark advances even for samples throttled from persistence',()=>{
  const {context,updates,advance}=subject();
  context.persistCurrentHistoryProgress(sample);
  context.persistCurrentHistoryProgress({...sample,sampleSeq:3,position:16});advance();
  context.persistCurrentHistoryProgress({...sample,sampleSeq:2,position:12});
  assert.deepEqual(updates,[['history-new',8,60]]);
});
test('backward seek is allowed, but old seek revisions are rejected',()=>{
  const {context,updates,advance}=subject();
  context.persistCurrentHistoryProgress({...sample,sampleSeq:2,position:16});advance();
  context.persistCurrentHistoryProgress({...sample,sampleSeq:3,seekRevision:1,position:4});advance();
  context.persistCurrentHistoryProgress({...sample,sampleSeq:4,seekRevision:0,position:18});
  assert.deepEqual(updates,[['history-new',16,60],['history-new',4,60]]);
});
test('new session allows reset sample sequence and uses its own bound row',()=>{
  const {context,updates,advance}=subject();
  context.persistCurrentHistoryProgress({...sample,sampleSeq:20});advance();
  context.runtimeSession.value={...session,requestId:'next',loadId:'next',historyId:'history-next'};
  context.persistCurrentHistoryProgress({...sample,requestId:'next',loadId:'next',sampleSeq:1,position:1});
  assert.deepEqual(updates,[['history-new',8,60],['history-next',1,60]]);
});
test('playback binds the inserted ID only after successful addHistory',async()=>{
  const main=await readFile(new URL('../../apps/desktop/src/main/index.ts',import.meta.url),'utf8');
  assert.match(main,/const historyId=randomUUID\(\);store\.addHistory\(\{id:historyId,/);
  assert.match(main,/store\.addHistory\([\s\S]*?\);\s*bindPlayerRuntimeHistory\(intentRequestId,historyId\);/);
  assert.match(view,/persistCurrentHistoryProgress\(nextStats\)/);
  assert.doesNotMatch(view,/history\.updateProgress\(current\.id/);
});
const rulesSource=await readFile(new URL('../../apps/desktop/src/main/playback-session-rules.ts',import.meta.url),'utf8');
const rulesContext={exports:{}};
vm.runInNewContext(ts.transpileModule(rulesSource,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,rulesContext);
test('main-process guard remains strict about latest row and exact VOD identity',()=>{
  const {canUpdateVodHistory}=rulesContext.exports;
  assert.equal(canUpdateVodHistory(session,oldRow,session.historyId,oldRow.id),false);
  assert.equal(canUpdateVodHistory(session,oldRow,session.historyId,session.historyId),true);
  assert.equal(canUpdateVodHistory({...session,domain:'live'},oldRow,session.historyId,session.historyId),false);
  assert.equal(canUpdateVodHistory(session,{...oldRow,episodeId:'different'},session.historyId,session.historyId),false);
});

const controllerSource=await readFile(new URL('../../apps/desktop/src/main/playback-session-controller.ts',import.meta.url),'utf8');
const controllerContext={exports:{},require:()=>({randomUUID:()=>String(Math.random())})};
vm.runInNewContext(ts.transpileModule(controllerSource,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,controllerContext);
test('real controller publishes history binding even after EOF and clears it on next intent',()=>{
  const published=[],controller=new controllerContext.exports.PlaybackSessionController(value=>published.push(value));
  const current=controller.begin('vod');controller.playing(current.requestId,'load');controller.end('eof');
  assert.equal(controller.bindHistory(current.requestId,'history').historyId,'history');
  assert.equal(published.at(-1).historyId,'history');assert.equal(published.at(-1).status,'ended');
  const next=controller.begin('vod');assert.equal(next.historyId,undefined);
  assert.equal(controller.bindHistory(current.requestId,'old'),undefined);
});
test('binding cannot revive failed/stopped sessions or attach to non-VOD media',()=>{
  for(const status of ['failed','stopped','live']){
    const controller=new controllerContext.exports.PlaybackSessionController(()=>{}),current=controller.begin(status==='live'?'live':'vod');
    controller.playing(current.requestId,'load');if(status==='failed')controller.fail(current.requestId,'failed');if(status==='stopped')controller.end('stop');
    assert.equal(controller.bindHistory(current.requestId,'history'),undefined);assert.equal(controller.current().historyId,undefined);
  }
});
test('production insert/bind block never publishes an ID if insertion throws',async()=>{
  const text=await readFile(new URL('../../apps/desktop/src/main/index.ts',import.meta.url),'utf8');
  const block=text.match(/assertPlaybackCurrent\(\);const historyId=randomUUID\(\);store.addHistory\([\s\S]*?bindPlayerRuntimeHistory\(intentRequestId,historyId\);/)[0];
  const context={assertPlaybackCurrent(){},randomUUID:()=> 'new-id',source:{id:'source',name:'name'},request:{},resolution:{},historyEpisodes:undefined,Date,intentRequestId:'r',store:{addHistory(){throw new Error('insert failed');}},bindPlayerRuntimeHistory(){throw new Error('must not publish');}};
  assert.throws(()=>vm.runInNewContext(block,context),/insert failed/);
  const calls=[];context.store.addHistory=entry=>calls.push(['insert',entry.id]);context.bindPlayerRuntimeHistory=(request,id)=>calls.push(['bind',request,id]);
  vm.runInNewContext(`{${block}}`,context);assert.deepEqual(calls,[['insert','new-id'],['bind','r','new-id']]);
});

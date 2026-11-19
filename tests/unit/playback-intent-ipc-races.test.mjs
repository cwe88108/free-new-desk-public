import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {AsyncLocalStorage} from 'node:async_hooks';
import ts from 'typescript';
import {PlaybackSessionController} from '../../apps/desktop/src/main/playback-session-controller.ts';
import {validateVodAutoNext,canUpdateVodHistory} from '../../apps/desktop/src/main/playback-session-rules.ts';
function deferred(){let resolve;const promise=new Promise(yes=>{resolve=yes;});return{resolve,promise};}
async function harness(afterConsumed){
  const handlers=new Map(),controller=new PlaybackSessionController(()=>{}),loads=[],commands=[];
  const player={load:async value=>{loads.push(value);return{ok:true};},command:async value=>{commands.push(value);return{ok:true};},query:async()=>({loadId:'parent-load',status:'ended',error:'eof'})};
  class Store{addHistory(){}listHistory(){return [];}updateHistoryProgress(){return true;}}
  class Claims extends Map{set(key,value){super.set(key,value);if(value?.stage==='consumed'&&afterConsumed)queueMicrotask(()=>afterConsumed(controller));return this;}}
  const runtime={getCurrentPlayerClient:()=>player,getPlayerRuntimeSession:()=>controller.current(),beginPlayerRuntimeSession:(...args)=>controller.begin(...args),failPlayerRuntimeSession:(...args)=>controller.fail(...args),patchPlayerRuntimeSession:(id,patch)=>controller.isMutable(id)?controller.patch(id,patch):undefined,isPlayerRuntimeCurrent:(id,domain)=>controller.isCurrent(id)&&(!domain||controller.current().domain===domain),assertPlayerRuntimeCurrent:(id,domain)=>{controller.assertMutable(id);assert.equal(controller.current().domain,domain);return controller.current();},onPlayerRuntimeSession:()=>()=>{}};
  const modules={electron:{app:{isReady:()=>false},BrowserWindow:{getAllWindows:()=>[]},ipcMain:{handle:(channel,listener)=>handlers.set(channel,listener)}},'node:async_hooks':{AsyncLocalStorage},'node:fs/promises':{},'node:path':{default:{}},'@free-new-desk/data-service':{DataService:Store},'./media-identity.js':{mediaIdentity:()=>undefined,sameMediaPath:()=>true},'./player-client.js':runtime,'./playback-session-rules.js':{validateVodAutoNext,canUpdateVodHistory}};
  const text=await readFile(new URL('../../apps/desktop/src/main/playback-session-ipc.ts',import.meta.url),'utf8');
  const compiled=ts.transpileModule(text,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
  const context={exports:{},require:name=>{if(!(name in modules))throw new Error('Unexpected dependency '+name);return modules[name];},Map:Claims,Set,WeakSet,WeakMap,Promise,Date,Number,String,Boolean,Object,Array,Error,queueMicrotask};
  vm.runInNewContext(compiled,context);
  const event={sender:{id:1},senderFrame:{url:'file:///test/index.html'}};
  return{controller,handlers,player,commands,loads,register:modules.electron.ipcMain.handle,invoke:(channel,input,owner=1)=>handlers.get(channel)({...event,sender:{id:owner}},input)};
}
test('late music file lookup cannot hide or load over a newer VOD request',async()=>{
  const h=await harness(),lookup=deferred();
  h.register('music:play',async()=>{await lookup.promise;await h.player.command({command:'window-sync',visible:false}).catch(()=>{});return h.player.load({url:'old-song',profile:'music'});});
  h.register('playback:play',async()=>({ok:true}));
  const old=h.invoke('music:play',{trackId:'old-song'});await h.invoke('playback:play',{sourceId:'new-vod'});lookup.resolve();
  await assert.rejects(old,/PLAYBACK_SUPERSEDED/);assert.equal(h.commands.length,0);assert.equal(h.loads.length,0);assert.equal(h.controller.current().domain,'vod');
});
test('delayed VOD and live results are rejected after music takes ownership',async()=>{
  const h=await harness(),vod=deferred(),live=deferred();
  h.register('playback:play',()=>vod.promise);
  h.register('live:play',()=>live.promise);
  h.register('music:play',async()=>({ok:true}));
  const vodResult=h.invoke('playback:play',{sourceId:'old-vod'});
  const liveResult=h.invoke('live:play',{sourceId:'old-live',channelId:'test-channel'});
  const musicResult=await h.invoke('music:play',{trackId:'latest-song'});
  const rejectedVod=assert.rejects(vodResult,/PLAYBACK_SUPERSEDED/);
  const rejectedLive=assert.rejects(liveResult,/PLAYBACK_SUPERSEDED/);
  vod.resolve({ok:true});
  live.resolve({ok:true,routeIndex:1,routeCount:2});
  await Promise.all([rejectedVod,rejectedLive]);
  assert.equal(h.controller.current().requestId,musicResult.session.requestId);
  assert.equal(h.controller.current().trackId,'latest-song');
});
test('user intent between EOF consumption and auto-next commit wins atomically',async()=>{
  const h=await harness(c=>c.begin('live',{channelId:'new-user-channel'}));
  const parent=h.controller.begin('music',{trackId:'old-song'});h.controller.playing(parent.requestId,'parent-load');
  let started=0;h.register('music:play',async()=>{started++;return{ok:true};});
  await assert.rejects(h.invoke('music:play',{trackId:'automatic-song',initiator:'auto-next',parentRequestId:parent.requestId,expectedLoadId:'parent-load',expectedControlRevision:0}),/PLAYBACK_SUPERSEDED/);
  assert.equal(started,0);assert.equal(h.controller.current().domain,'live');assert.equal(h.controller.current().channelId,'new-user-channel');
});
test('stop after EOF fences an already prepared automatic successor',()=>{
  const c=new PlaybackSessionController(()=>{}),parent=c.begin('music',{trackId:'old'});c.playing(parent.requestId,'parent-load');const ended=c.end('eof');c.end('stop');
  assert.equal(c.current().status,'stopped');assert.throws(()=>c.begin('music',{trackId:'next'},'auto-next',ended),/PLAYBACK_SUPERSEDED/);
});
test('valid automatic music successor consumes its exact parent while stale parent metadata is rejected',async()=>{
  const h=await harness(),parent=h.controller.begin('music',{trackId:'old-song'});h.controller.playing(parent.requestId,'parent-load');
  let started=0;h.register('music:play',async()=>{started++;return{ok:true};});
  await assert.rejects(h.invoke('music:play',{trackId:'next',initiator:'auto-next',parentRequestId:'wrong',expectedLoadId:'parent-load',expectedControlRevision:0}),/PLAYBACK_SUPERSEDED/);assert.equal(started,0);
  await h.invoke('music:play',{trackId:'next',initiator:'auto-next',parentRequestId:parent.requestId,expectedLoadId:'parent-load',expectedControlRevision:0});
  assert.equal(started,1);assert.equal(h.controller.current().trackId,'next');assert.notEqual(h.controller.current().requestId,parent.requestId);
});
test('old window cannot hide another window surface even with its latest broadcast request id',async()=>{
  const h=await harness();let commands=0;
  h.register('playback:control',async()=>{commands++;return{ok:true};});
  const session=h.controller.begin('vod',{ownerWindowId:2});
  const old=await h.invoke('playback:control',{command:'window-sync',requestId:session.requestId},1);
  assert.equal(old.ok,false);assert.equal(commands,0);
  const current=await h.invoke('playback:control',{command:'window-sync',requestId:session.requestId},2);assert.equal(current.ok,true);assert.equal(commands,1);
  const unbound=await h.invoke('playback:control',{command:'stop'},2);assert.equal(unbound.ok,false);assert.equal(commands,1);
});
test('automatic live retry must bind its current owning window and cannot create a new priority',async()=>{
  const h=await harness(),session=h.controller.begin('live',{ownerWindowId:2});let started=0;h.register('live:play',async()=>{started++;return{ok:true};});
  await assert.rejects(h.invoke('live:play',{initiator:'auto-route'},2),/PLAYBACK_SUPERSEDED/);
  await assert.rejects(h.invoke('live:play',{initiator:'auto-route',requestId:session.requestId},1),/PLAYBACK_SUPERSEDED/);
  assert.equal(started,0);await h.invoke('live:play',{initiator:'auto-route',requestId:session.requestId},2);assert.equal(started,1);assert.equal(h.controller.current().generation,session.generation);
  assert.throws(()=>h.invoke('playback:beginIntent',{domain:'music',initiator:'auto-next'},2),/PLAYBACK_SUPERSEDED/);assert.equal(h.controller.current().requestId,session.requestId);
});

test('coordinated live loads keep their request mutable until the owning window reports final failure',async()=>{
  const h=await harness();
  const contexts=[];
  h.player.load=async(_request,_accepted,context)=>{
    contexts.push(context);
    if(!context.deferLiveFailure)h.controller.fail(context.requestId,'route failed');
    throw Error('route failed');
  };
  h.register('live:play',()=>h.player.load({url:'route',profile:'live'}));
  const request=h.invoke('playback:beginIntent',{domain:'live',sourceId:'source',channelId:'channel'},2);
  for(const initiator of ['user','auto-route']){
    await assert.rejects(h.invoke('live:play',{requestId:request.requestId,initiator},2),/route failed/);
    assert.equal(h.controller.isMutable(request.requestId),true);
  }
  assert.equal(contexts.length,2);
  assert.ok(contexts.every(context=>context.deferLiveFailure===true));
  const failure={requestId:request.requestId,error:'three attempts failed'};
  assert.equal(h.invoke('playback:failIntent',failure,1),false);
  assert.equal(h.invoke('playback:failIntent',failure,2),true);
  assert.equal(h.controller.current().error,failure.error);
  assert.equal(h.controller.current().status,'failed');
});

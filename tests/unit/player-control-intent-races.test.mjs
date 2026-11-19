import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import {PlaybackSessionController} from '../../apps/desktop/src/main/playback-session-controller.ts';
import {PlayerCommandSchema} from '../../packages/contracts/dist/index.js';
function deferred(){let resolve;const promise=new Promise(yes=>{resolve=yes;});return{resolve,promise};}
async function subject(){
  const text=await readFile(new URL('../../apps/desktop/src/main/player-client.ts',import.meta.url),'utf8'),source=ts.createSourceFile('client.ts',text,ts.ScriptTarget.Latest,true);
  const cls=source.statements.find(node=>ts.isClassDeclaration(node)&&node.name.text==='PlayerClient'),method=cls.members.find(node=>ts.isMethodDeclaration(node)&&node.name.getText(source)==='command');
  const controller=new PlaybackSessionController(()=>{}),calls=[];
  const context={runtimeController:controller,process:{platform:'win32'},transport:(...args)=>{const d=deferred();calls.push({args,...d});return d.promise;}};
  const harness='class Subject {#loadGeneration=0;#liveTargetController;#pauseRevision=0;#seekRevision=0;#resetStatsCache(){}#resetTransportFaults(){}#sendWithRecovery(...args){return transport(...args);}recordMetric(){}'+method.getText(source)+'}\nglobalThis.subject=new Subject();';
  vm.runInNewContext(ts.transpileModule(harness,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,context);
  return{client:context.subject,controller,calls};
}
test('late pause ACK cannot pause a new playback domain',async()=>{
  const {client,controller:c,calls}=await subject();const a=c.begin('vod');c.playing(a.requestId,'load-a');
  const pause=client.command({command:'pause',value:true,requestId:a.requestId});
  assert.equal(calls[0].args[3],a.requestId);assert.equal(calls[0].args[1].sessionGeneration,a.generation);
  const b=c.begin('music');c.playing(b.requestId,'load-b');calls[0].resolve({ok:true});await pause;
  assert.equal(c.current().requestId,b.requestId);assert.equal(c.current().status,'playing');assert.equal(c.current().desiredPaused,false);
});
test('reverse pause/resume ACK order preserves the most recent user control',async()=>{
  const {client,controller:c,calls}=await subject();const a=c.begin('vod');c.playing(a.requestId,'load-a');
  const pause=client.command({command:'pause',value:true}),resume=client.command({command:'pause',value:false});
  assert.ok(calls[1].args[1].pauseRevision>calls[0].args[1].pauseRevision);
  calls[1].resolve({ok:true});await resume;calls[0].resolve({ok:true});await pause;
  assert.equal(c.current().status,'playing');assert.equal(c.current().desiredPaused,false);
});
test('stale stop is rejected before invalidating or stopping the new session',async()=>{
  const {client,controller:c,calls}=await subject();const a=c.begin('vod'),b=c.begin('music');c.playing(b.requestId,'load-b');
  const result=await client.command(PlayerCommandSchema.parse({command:'stop',requestId:a.requestId}));
  assert.equal(result.ok,false);assert.equal(calls.length,0);assert.equal(c.current().requestId,b.requestId);assert.equal(c.current().status,'playing');
});
test('pause during resolution remains the desired state when loading finishes',async()=>{
  const {client,controller:c,calls}=await subject();const a=c.begin('vod');const paused=client.command({command:'pause',value:true});
  assert.equal(c.current().status,'requested');assert.equal(c.current().desiredPaused,true);c.loading(a.requestId,'load-a');c.playing(a.requestId,'load-a');assert.equal(c.current().status,'paused');calls[0].resolve({ok:true});await paused;
});
test('a new pause invalidates an already prepared automatic successor',()=>{
  const c=new PlaybackSessionController(()=>{}),a=c.begin('music');c.playing(a.requestId,'load-a');const parent=c.current();c.requestPause(a.requestId,true);
  assert.throws(()=>c.begin('music',{},'auto-next',parent),/PLAYBACK_SUPERSEDED/);
});
test('stop during a same-session route replacement fences every load in that session',async()=>{
  const {client,controller:c,calls}=await subject();const a=c.begin('live');c.playing(a.requestId,'previous-route');
  // The new route may already be accepted natively while its load ACK is still pending.
  const stopped=client.command({command:'stop',requestId:a.requestId,loadId:'previous-route'});
  const payload=JSON.parse(JSON.stringify(calls[0].args[1]));
  assert.equal(payload.sessionGeneration,a.generation);
  assert.equal(payload.loadId,undefined,'stop must not be rejected against the previous route load ID');
  calls[0].resolve({ok:true});await stopped;assert.equal(c.current().status,'stopped');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';

const text=await readFile(new URL('../../apps/desktop/src/main/fullscreen-overlay.ts',import.meta.url),'utf8');
const ast=ts.createSourceFile('overlay.ts',text,ts.ScriptTarget.Latest,true);
const functions=['poll','hideOverlay'].map(name=>ast.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text===name).getText(ast)).join('\n');
function subject(){
  let queries=0,created=0,shown=0,hidden=0,sent=0;
  const session={domain:null,requestId:'',loadId:''};
  const stats={sampleFresh:true,requestId:'vod',loadId:'load',fullscreen:true,paused:true,position:12,duration:60,volume:50};
  const client={query:async()=>{queries++;return stats;}};
  const context={polling:false,closing:false,lastVisible:false,lastState:'',overlay:undefined,getCurrentPlayerClient:()=>client,getPlayerRuntimeSession:()=>session,activeAppWindow:()=>({}),createOverlay:()=>{created++;return{isDestroyed:()=>false,showInactive:()=>shown++,hide:()=>hidden++};},fitOverlay(){},sendState:()=>sent++,Math};
  vm.runInNewContext(ts.transpileModule(functions,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context);
  return{context,session,stats,client,counts:()=>({queries,created,shown,hidden,sent})};
}
test('idle, pending and music sessions do not query or create a fullscreen renderer',async()=>{
  const s=subject();await s.context.poll();Object.assign(s.session,{domain:'vod',requestId:'vod'});await s.context.poll();Object.assign(s.session,{domain:'music',loadId:'load'});await s.context.poll();
  assert.deepEqual(s.counts(),{queries:0,created:0,shown:0,hidden:0,sent:0});
});
test('fullscreen creates one renderer on demand and music takeover hides it without another query',async()=>{
  const s=subject();Object.assign(s.session,{domain:'vod',requestId:'vod',loadId:'load'});await s.context.poll();await s.context.poll();
  assert.deepEqual(s.counts(),{queries:2,created:1,shown:1,hidden:0,sent:2});
  s.session.domain='music';await s.context.poll();assert.equal(s.counts().queries,2);assert.equal(s.counts().hidden,1);
});
test('slow overlay queries cannot overlap or show after playback ownership changes',async()=>{
  const s=subject();Object.assign(s.session,{domain:'vod',requestId:'vod',loadId:'load'});let resolve;
  s.client.query=()=>{s.stats.queryCount=(s.stats.queryCount??0)+1;return new Promise(yes=>resolve=yes);};
  const pending=s.context.poll();await s.context.poll();assert.equal(s.stats.queryCount,1);
  Object.assign(s.session,{domain:'live',requestId:'new',loadId:'new'});resolve(s.stats);await pending;assert.equal(s.counts().created,0);assert.equal(s.context.polling,false);
});
test('shutdown fences pending overlay creation and startup does not eagerly create a window',async()=>{
  const s=subject();Object.assign(s.session,{domain:'vod',requestId:'vod',loadId:'load'});let resolve;
  s.client.query=()=>new Promise(yes=>resolve=yes);const pending=s.context.poll();s.context.closing=true;resolve(s.stats);await pending;
  assert.equal(s.counts().created,0);assert.equal(s.context.polling,false);
  const startup=ast.statements.find(node=>ts.isExpressionStatement(node)&&node.getText(ast).startsWith('app.whenReady()'));
  let tick;
  vm.runInNewContext(ts.transpileModule(startup.getText(ast),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,{closing:false,app:{whenReady:()=>({then:callback=>callback()})},setInterval:callback=>{tick=callback;return{unref(){}};},poll:()=>{},pollTimer:undefined});
  assert.equal(typeof tick,'function');
});

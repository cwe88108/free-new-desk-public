import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
const text=await readFile(new URL('../../apps/desktop/src/renderer/views/PlayerView.vue',import.meta.url),'utf8');
const source=ts.createSourceFile('view.ts',text.match(/<script setup[^>]*>([\s\S]*?)<\/script>/)[1],ts.ScriptTarget.Latest,true);
const fn=source.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name.text==='refreshBoundHistory');
function subject(){
  let resolve;const pending=new Promise(r=>{resolve=r;});
  const context={runtimeSession:{value:{requestId:'new',historyId:'current',domain:'vod'}},boundHistory:{value:null},allowSurfaceSync:true,window:{desktop:{history:{list:()=>pending}}}};
  vm.runInNewContext(ts.transpileModule(fn.getText(source),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context);
  return{context,resolve};
}
test('history binding loads metadata written after the player page mounted, independently of the saved queue',async()=>{
  const {context,resolve}=subject();const work=context.refreshBoundHistory();
  resolve([{id:'old'},{id:'current',videoName:'current title'}]);await work;
  assert.equal(context.boundHistory.value.videoName,'current title');
});
test('late history responses cannot overwrite another session or an unmounted page',async()=>{
  for(const change of [c=>c.runtimeSession.value.requestId='other',c=>c.runtimeSession.value.historyId='other',c=>c.allowSurfaceSync=false]){
    const {context,resolve}=subject();const work=context.refreshBoundHistory();change(context);resolve([{id:'current'}]);await work;assert.equal(context.boundHistory.value,null);
  }
});
test('history loading does not run for live or music sessions',async()=>{
  const {context}=subject();context.runtimeSession.value.domain='music';await context.refreshBoundHistory();assert.equal(context.boundHistory.value,null);
});

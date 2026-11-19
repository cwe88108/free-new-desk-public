import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import vm from 'node:vm';import ts from 'typescript';

test('repeated authoritative reads do not overwrite renderer sample state while real changes and live fences remain observable',async()=>{
 const text=await readFile(new URL('../../apps/desktop/src/preload/index.cts',import.meta.url),'utf8'),ast=ts.createSourceFile('preload.ts',text,ts.ScriptTarget.Latest,true);
 const fn=ast.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='notifyRuntimeSession');let count=0;
 const snapshot={generation:1,requestId:'vod',domain:'vod',status:'playing',updatedAt:100,loadId:'one',controlRevision:0};
 const context={runtimeSession:{generation:0,requestId:'',domain:null,status:'idle',updatedAt:0},activeLive:undefined,playbackKind:undefined,runtimeSessionListeners:new Set([()=>{count++;}])};
 vm.runInNewContext(ts.transpileModule(fn.getText(ast)+'\nglobalThis.notify=notifyRuntimeSession;',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,context);
 context.notify(snapshot);for(let i=0;i<10;i++)context.notify({...snapshot});assert.equal(count,1);
 context.notify({...snapshot,status:'paused',controlRevision:1});assert.equal(count,2,'same-millisecond pause revision must be delivered');
 context.notify({...snapshot,status:'paused',controlRevision:1,historyId:'history'});assert.equal(count,3,'same-millisecond metadata binding must be delivered');
 context.notify({...snapshot,generation:0,updatedAt:999});assert.equal(count,3);
 const live={...snapshot,generation:2,requestId:'live',domain:'live',updatedAt:200};context.notify(live);assert.equal(count,4);context.activeLive={requestId:'old'};context.notify({...live});assert.equal(context.activeLive,undefined,'deduplication cannot skip stale-live cleanup');assert.equal(count,4);
});

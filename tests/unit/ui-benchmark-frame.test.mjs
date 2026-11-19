import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
const text=await readFile(new URL('../../scripts/benchmarks/ui-workload.ts',import.meta.url),'utf8');
const ast=ts.createSourceFile('workload.ts',text,ts.ScriptTarget.Latest,true);
const fn=ast.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='benchmarkFrameReady').getText(ast);
function subject(){
  let timer,frame,cleared=false,cancelled=false;
  const context={Promise,benchmarkPhase:'5:history',document:{visibilityState:'hidden',hasFocus:()=>false},console:{error(){}},window:{setTimeout:callback=>{timer=callback;return 99;}},clearTimeout:id=>{assert.equal(id,99);cleared=true;},requestAnimationFrame:callback=>{frame=callback;return 7;},cancelAnimationFrame:id=>{assert.equal(id,7);cancelled=true;}};
  vm.runInNewContext(ts.transpileModule(fn,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context);
  return{promise:context.benchmarkFrameReady(),frame:()=>frame(),timeout:()=>timer(),cleared:()=>cleared,cancelled:()=>cancelled};
}
test('benchmark frame completion clears its timeout and does not leave a background timer',async()=>{
  const s=subject();s.frame();await s.promise;assert.equal(s.cleared(),true);assert.equal(s.cancelled(),false);
});
test('unavailable animation frame rejects with visibility and phase evidence instead of hanging',async()=>{
  const s=subject();s.timeout();await assert.rejects(s.promise,/5:history.*hidden/);assert.equal(s.cancelled(),true);
});

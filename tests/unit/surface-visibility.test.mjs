import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';
import vm from 'node:vm';
const source=await readFile(new URL('../../apps/desktop/src/renderer/native-surface.ts',import.meta.url),'utf8');
const ast=ts.createSourceFile('surface.ts',source,ts.ScriptTarget.Latest,true);
const fn=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='surfaceFitsContent');
const context={exports:{}};
vm.runInNewContext(ts.transpileModule(fn.getText(ast),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,context);
const fits=context.exports.surfaceFitsContent,clip={left:220,top:48,right:1420,bottom:790};
test('embedded video stays inside the scroll content and restores when returned to view',()=>{
  const bounds={x:240,y:120,width:850,height:478};
  assert.equal(fits(bounds,clip),true);
  for(const change of [{y:0},{y:400},{x:0},{x:800}])assert.equal(fits({...bounds,...change},clip),false);
  assert.equal(fits(bounds,clip),true);
});

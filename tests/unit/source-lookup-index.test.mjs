import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import {parse} from '@vue/compiler-sfc';
import {ref,computed} from 'vue';

const text=await readFile(new URL('../../apps/desktop/src/renderer/views/SourcesView.vue',import.meta.url),'utf8');
const ast=ts.createSourceFile('source.ts',parse(text).descriptor.scriptSetup.content,ts.ScriptTarget.Latest,true);
const names=['importGroupLabels','liveSourceIds','compatibilityRows','compatibilityLabel'];
const snippets=[];
for(const node of ast.statements){
  if(ts.isVariableStatement(node))for(const decl of node.declarationList.declarations)if(names.includes(decl.name.getText(ast)))snippets.push('const '+decl.getText(ast)+';');
  if(ts.isFunctionDeclaration(node)&&names.includes(node.name?.text))snippets.push(node.getText(ast));
}
assert.equal(snippets.length,names.length);
function subject(){
  const context={computed,importGroups:ref([{id:'g',label:'原批次'}]),sources:ref([{id:'v',importGroupId:'g'},{id:'orphan',importGroupId:'missing'},{id:'manual'}]),liveSources:ref([{id:'l',importGroupId:'g'}]),healthMap:ref(new Map()),compatibilityFilter:ref('all'),sourceCapabilities:(health,live)=>({label:live?(health?.ok?'列表已解析':'待验证'):(health?.ok?'接口通过':'待验证')})};
  vm.runInNewContext(ts.transpileModule(snippets.join('\n')+';globalThis.result={compatibilityRows,compatibilityLabel};',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context);
  return {...context,...context.result};
}
test('source group labels follow rename, removal and newly imported groups without navigation',()=>{
  const s=subject();
  assert.deepEqual(Array.from(s.compatibilityRows.value,r=>r.group),['原批次','导入配置','未归组','原批次']);
  s.importGroups.value[0].label='新批次';assert.equal(s.compatibilityRows.value[0].group,'新批次');
  s.importGroups.value=[];assert.equal(s.compatibilityRows.value[0].group,'导入配置');
  s.importGroups.value.push({id:'g',label:'恢复批次'});assert.equal(s.compatibilityRows.value[3].group,'恢复批次');
});
test('live membership updates labels after import, deletion and in-place ID changes',()=>{
  const s=subject();s.healthMap.value=new Map([['l',{ok:true}],['v',{ok:true}],['new',{ok:true}]]);
  assert.equal(s.compatibilityLabel('l'),'列表已解析');assert.equal(s.compatibilityLabel('v'),'接口通过');
  s.liveSources.value[0].id='new';assert.equal(s.compatibilityLabel('l'),'接口通过');assert.equal(s.compatibilityLabel('new'),'列表已解析');
  s.liveSources.value=[];assert.equal(s.compatibilityLabel('new'),'接口通过');
  s.liveSources.value.push({id:'v'});assert.equal(s.compatibilityLabel('v'),'列表已解析');
  s.healthMap.value.set('v',{ok:false});assert.equal(s.compatibilityLabel('v'),'待验证');
});
test('compatibility filter still distinguishes VOD and live results and observes health updates',()=>{
  const s=subject();s.healthMap.value=new Map([['v',{ok:true}],['l',{ok:true}]]);s.compatibilityFilter.value='compatible';
  assert.deepEqual(Array.from(s.compatibilityRows.value,r=>r.source.id),['v','l']);
  s.healthMap.value.set('l',{ok:false});assert.deepEqual(Array.from(s.compatibilityRows.value,r=>r.source.id),['v']);
  s.compatibilityFilter.value='pending';assert.deepEqual(Array.from(s.compatibilityRows.value,r=>r.source.id),['orphan','manual','l']);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import {parse} from '@vue/compiler-sfc';
import {ref,computed,watch,reactive,nextTick} from 'vue';
const pagination=ts.transpileModule(await readFile(new URL('../../apps/desktop/src/renderer/source-pagination.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
const helpers=await import('data:text/javascript;base64,'+Buffer.from(pagination).toString('base64'));
const view=parse(await readFile(new URL('../../apps/desktop/src/renderer/views/SourcesView.vue',import.meta.url),'utf8')).descriptor;
const ast=ts.createSourceFile('Sources.ts',view.scriptSetup.content,ts.ScriptTarget.Latest,true);
const names=['sourcePages','sourceSearch','filteredCompatibilityRows','renderedCompatibilityRows'];
const functions=['matchesSource','pageFor','setSourcePage','renderedItems','visibleItems'];
const code=ast.statements.flatMap(node=>ts.isVariableStatement(node)?[...node.declarationList.declarations].filter(item=>names.includes(item.name.getText(ast))).map(item=>'const '+item.getText(ast)+';'):ts.isFunctionDeclaration(node)&&functions.includes(node.name?.text)?[node.getText(ast)]:ts.isExpressionStatement(node)&&node.getText(ast).startsWith('watch([onlyUnhealthy,')?[node.getText(ast)]:[]).join('\n');
function subject(){
  const compatibilityRows=ref([]),onlyUnhealthy=ref(false),healthMap=ref(new Map()),compatibilityFilter=ref('all'),draggedSourceId=ref('');
  const context={...helpers,compatibilityRows,onlyUnhealthy,healthMap,compatibilityFilter,draggedSourceId,ref,computed,reactive,watch};
  vm.runInNewContext(ts.transpileModule(code+'\nglobalThis.api={sourcePages,sourceSearch,renderedCompatibilityRows,pageFor,setSourcePage,renderedItems,visibleItems};',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context);
  return {...context,api:context.api};
}
const entries=()=>Array.from({length:712},(_,i)=>({id:'s'+i,name:'Source '+i,endpoint:'https://example.invalid/'+i}));
test('all 712 sources remain reachable exactly once with at most 50 rows per group',()=>{
  const s=subject(),items=entries(),visited=[];
  for(let page=1;page<=15;page++){s.api.setSourcePage('vod:api',page);const rows=s.api.renderedItems(items,'vod:api');assert.ok(rows.length<=50);visited.push(...rows.map(row=>row.id));}
  assert.deepEqual(visited,items.map(row=>row.id));assert.equal(s.api.visibleItems(items).length,712);
  assert.equal(s.api.renderedItems(items,'live:local').length,50);assert.equal(s.api.pageFor('live:local',712),1);
});
test('deleting the final page clamps display to remaining rows; empty data stays valid',()=>{
  const s=subject(),items=entries();s.api.setSourcePage('vod:api',15);
  assert.equal(s.api.renderedItems(items.slice(0,700),'vod:api')[0].id,'s650');
  assert.equal(s.api.pageFor('vod:api',700),14);assert.equal(s.api.pageFor('vod:api',0),1);
  assert.equal(s.api.renderedItems([],'vod:api').length,0);
});
test('search and health filters apply before paging and reset all page selections',async()=>{
  const s=subject(),items=entries();s.api.setSourcePage('vod:api',15);s.api.sourceSearch.value='example.invalid/711';await nextTick();
  assert.equal(s.api.pageFor('vod:api',1),1);assert.equal(s.api.renderedItems(items,'vod:api')[0].id,'s711');
  s.api.sourceSearch.value='';s.onlyUnhealthy.value=true;s.healthMap.value=new Map([['s711',{ok:false}]]);await nextTick();
  assert.equal(s.api.visibleItems(items).length,1);assert.equal(s.api.renderedItems(items,'vod:api')[0].id,'s711');
});
test('compatibility details have independent pages; batch actions retain full group inputs',async()=>{
  const s=subject(),items=entries();s.compatibilityRows.value=items.map(source=>({source}));s.api.setSourcePage('compatibility',15);
  assert.equal(s.api.renderedCompatibilityRows.value.length,12);assert.equal(s.api.renderedCompatibilityRows.value[0].source.id,'s700');
  assert.equal(s.api.renderedItems(items,'vod:api')[0].id,'s0');s.compatibilityFilter.value='pending';await nextTick();
  assert.equal(s.api.renderedCompatibilityRows.value[0].source.id,'s0');
  assert.match(view.template.content,/setPointSources\(group.items,true\)/);assert.match(view.template.content,/setPointSources\(group.items,false\)/);
});
test('invalid and out of range page values cannot hide the list',()=>{
  assert.equal(helpers.clampSourcePage(NaN,712),1);assert.equal(helpers.clampSourcePage(Infinity,712),1);
  assert.equal(helpers.clampSourcePage(-4,712),1);assert.equal(helpers.clampSourcePage(99,712),15);
});

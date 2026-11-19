import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import {parse} from '@vue/compiler-sfc';
import {ref,computed} from 'vue';

const text=await readFile(new URL('../../apps/desktop/src/renderer/views/SourcesView.vue',import.meta.url),'utf8');
const source=ts.createSourceFile('sources.ts',parse(text).descriptor.scriptSetup.content,ts.ScriptTarget.Latest,true);
function summary(point,live,checks,loading=false,trust=[]){
  const names=['executableStateMap','healthMap','enabledCount','passedCount','totalCount','passedPercent','sourceStateBanner'];
  const declarations=source.statements.flatMap(n=>ts.isVariableStatement(n)?[...n.declarationList.declarations]:[]).filter(n=>names.includes(n.name.getText(source)));
  assert.equal(declarations.length,names.length);
  const ctx={ref,computed,sources:ref(point),liveSources:ref(live),health:ref(checks),loading:ref(loading),executableStates:ref(trust)};
  vm.runInNewContext(ts.transpileModule(declarations.map(n=>'const '+n.getText(source)+';').join('\n')+';globalThis.result={sourceStateBanner,passedCount,passedPercent};',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,ctx);
  return {...ctx,...ctx.result};
}
const enabled=id=>({id,enabled:true});
test('partial checks never claim all enabled VOD and live sources failed',()=>{
  const s=summary([enabled('vod')],[enabled('live')],[{sourceId:'vod',ok:false}]);
  assert.equal(s.sourceStateBanner.value.kind,'partial');
  assert.doesNotMatch(s.sourceStateBanner.value.title,/均|全部/);
  assert.match(s.sourceStateBanner.value.detail,/已检查 1\/2/);
  assert.match(s.sourceStateBanner.value.detail,/1 个尚未检查/);
  s.health.value.push({sourceId:'live',ok:false});
  assert.equal(s.sourceStateBanner.value.kind,'unavailable');
  s.health.value[1]={sourceId:'live',ok:true};
  assert.equal(s.sourceStateBanner.value.kind,'partial');
  assert.match(s.sourceStateBanner.value.detail,/0 个尚未检查/);
});
test('stale and disabled source checks cannot broaden enabled failure scope',()=>{
  const s=summary([enabled('a'),{id:'off',enabled:false}],[enabled('b')],[{sourceId:'off',ok:false},{sourceId:'removed',ok:false}]);
  assert.equal(s.sourceStateBanner.value,null);
  s.health.value.push({sourceId:'a',ok:false});assert.equal(s.sourceStateBanner.value.kind,'partial');
  s.liveSources.value[0].enabled=false;assert.equal(s.sourceStateBanner.value.kind,'unavailable');
});
test('summary retains loading, empty, disabled and unapproved-code states',()=>{
  assert.equal(summary([],[],[],true).sourceStateBanner.value,null);
  assert.equal(summary([],[],[]).sourceStateBanner.value.kind,'empty');
  assert.equal(summary([{id:'a',enabled:false}],[],[]).sourceStateBanner.value.kind,'disabled');
  assert.equal(summary([{id:'a',enabled:false}],[],[],false,[{sourceId:'a',required:true,approved:false}]).sourceStateBanner.value.kind,'trust');
  assert.equal(summary([enabled('a')],[],[{sourceId:'a',ok:true}]).sourceStateBanner.value,null);
});
test('passed summary counts current VOD and live sources once and uses the total-source denominator',()=>{
  const s=summary([enabled('a')],[enabled('b')],[{sourceId:'a',ok:true},{sourceId:'removed',ok:true}]);
  assert.equal(s.passedCount.value,1);assert.equal(s.passedPercent.value,50);
  s.health.value.push({sourceId:'b',ok:true});assert.equal(s.passedCount.value,2);assert.equal(s.passedPercent.value,100);
  assert.match(text,/<small>检查通过<\/small><strong>\{\{passedCount\}\}<\/strong><span>占全部来源/);
});

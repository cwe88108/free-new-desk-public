import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import {parse} from '@vue/compiler-sfc';

test('dashboard health counts use the same enabled VOD and live source population',async()=>{
  const code=parse(await readFile(new URL('../../apps/desktop/src/renderer/views/HomeView.vue',import.meta.url),'utf8')).descriptor.scriptSetup.content;
  const source=ts.createSourceFile('HomeView.ts',code,ts.ScriptTarget.Latest,true);
  const names=['enabledSourceIds','enabledSources','healthySources','unhealthySources'];
  const declarations=source.statements.flatMap(node=>ts.isVariableStatement(node)?[...node.declarationList.declarations]:[]).filter(node=>names.includes(node.name.getText(source)));
  assert.equal(declarations.length,names.length);
  const ctx={sources:{value:[{id:'vod',enabled:true},{id:'disabled',enabled:false}]},liveSources:{value:[{id:'live',enabled:true}]},health:{value:[{sourceId:'vod',ok:true},{sourceId:'live',ok:true},{sourceId:'disabled',ok:true},{sourceId:'deleted',ok:true}]},computed:read=>({get value(){return read();}})};
  vm.runInNewContext(ts.transpileModule(declarations.map(node=>'const '+node.getText(source)+';').join('\n')+'\nglobalThis.counts=()=>[enabledSources.value,healthySources.value,unhealthySources.value];',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,ctx);
  const counts=()=>JSON.parse(JSON.stringify(ctx.counts()));
  assert.deepEqual(counts(),[2,2,0]);ctx.liveSources.value[0].enabled=false;assert.deepEqual(counts(),[1,1,0]);ctx.sources.value.push({id:'pending',enabled:true});assert.deepEqual(counts(),[2,1,1]);ctx.sources.value=[];ctx.liveSources.value=[];assert.deepEqual(counts(),[0,0,0]);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import {parse} from '@vue/compiler-sfc';
import {musicTrackDuration} from '../../packages/contracts/dist/index.js';

test('music library renders bounded CUE segments and the final track using their own duration',async()=>{
  const descriptor=parse(await readFile(new URL('../../apps/desktop/src/renderer/views/MusicView.vue',import.meta.url),'utf8')).descriptor;
  const source=ts.createSourceFile('MusicView.ts',descriptor.scriptSetup.content,ts.ScriptTarget.Latest,true);
  const format=source.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name.text==='formatTime');
  const expression=descriptor.template.content.match(/\{\{(formatTime\([^{}]*track\.duration[^{}]*)\}\}/)?.[1];
  assert.ok(expression,'track row must render its duration');
  const render=track=>vm.runInNewContext(ts.transpileModule(format.getText(source)+'\n'+expression,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,{track,musicTrackDuration});
  assert.deepEqual([{duration:120,cueStart:0,cueEnd:30},{duration:120,cueStart:30,cueEnd:60},{duration:120,cueStart:60},{duration:120}].map(render),['00:30','00:30','01:00','02:00']);
});

test('a short music scan finishing before the first poll still refreshes its catalog once',async()=>{
  const code=parse(await readFile(new URL('../../apps/desktop/src/renderer/views/MusicView.vue',import.meta.url),'utf8')).descriptor.scriptSetup.content;
  const source=ts.createSourceFile('MusicView.ts',code,ts.ScriptTarget.Latest,true);
  const load=source.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name.text==='loadSources');
  let interval;
  function visit(node){if(ts.isCallExpression(node)&&node.expression.getText(source)==='setInterval'&&node.arguments[1]?.getText(source)==='3000')interval=node.arguments[0];ts.forEachChild(node,visit);}
  visit(source);assert.ok(interval);
  let state='scanning',refreshes=0;
  const context={sources:{value:[]},sourceId:{value:'fixture'},wasScanning:false,window:{desktop:{music:{listSources:async()=>[{id:'fixture',scanState:state}]}}},refreshLibrary:async()=>{refreshes++;}};
  vm.runInNewContext(ts.transpileModule(load.getText(source)+'\nglobalThis.load=loadSources;globalThis.tick='+interval.getText(source),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context);
  await context.load();assert.equal(context.wasScanning,true);
  state='ready';context.tick();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(refreshes,1);assert.equal(context.wasScanning,false);
  context.tick();await new Promise(resolve=>setImmediate(resolve));assert.equal(refreshes,1);
});

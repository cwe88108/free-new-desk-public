import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import vm from 'node:vm';import ts from 'typescript';
const text=await readFile(new URL('../../apps/desktop/src/renderer/views/PlayerView.vue',import.meta.url),'utf8');const source=ts.createSourceFile('view.ts',text.match(/<script setup[^>]*>([\s\S]*?)<\/script>/)[1],ts.ScriptTarget.Latest,true);const fn=source.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name.text==='applyRuntime');
test('reloaded player restores pause from authoritative runtime while media sampling is pending',()=>{
 const c={runtimeSession:{value:{generation:0,updatedAt:0}},paused:{value:false},stats:{value:null},tracks:{value:[]},loadStatus:{value:null}};
 vm.runInNewContext(ts.transpileModule(fn.getText(source),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,c);
 c.applyRuntime({generation:2,updatedAt:2,domain:'vod',requestId:'current',loadId:'load',status:'paused'});assert.equal(c.paused.value,true);assert.equal(c.stats.value,null);
 c.applyRuntime({generation:1,updatedAt:3,domain:'vod',requestId:'old',status:'playing'});assert.equal(c.paused.value,true);
 c.applyRuntime({generation:2,updatedAt:1,domain:'vod',requestId:'current',status:'playing'});assert.equal(c.paused.value,true);
 c.applyRuntime({generation:2,updatedAt:3,domain:'vod',requestId:'current',loadId:'load',status:'playing'});assert.equal(c.paused.value,false);
});

test('stop with retained session IDs clears displayed media and window modes',()=>{
 const previous={generation:2,updatedAt:2,domain:'vod',requestId:'current',loadId:'load',status:'playing'};
 const c={runtimeSession:{value:previous},paused:{value:false},stats:{value:{position:123,duration:600}},tracks:{value:[{id:1}]},loadStatus:{value:{status:'loaded'}},seekValue:{value:123},seeking:{value:true},pip:{value:true},fullscreen:{value:true}};
 vm.runInNewContext(ts.transpileModule(fn.getText(source),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,c);
 c.applyRuntime({...previous,updatedAt:3,status:'stopped'});
 assert.equal(c.stats.value,null);assert.equal(c.tracks.value.length,0);assert.equal(c.loadStatus.value,null);assert.equal(c.seekValue.value,0);assert.equal(c.seeking.value,false);assert.equal(c.paused.value,true);assert.equal(c.pip.value,false);assert.equal(c.fullscreen.value,false);
 c.applyRuntime(previous);assert.equal(c.runtimeSession.value.status,'stopped');assert.equal(c.paused.value,true);
});

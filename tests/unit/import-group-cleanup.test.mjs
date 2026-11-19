import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import {parse} from '@vue/compiler-sfc';
const main=ts.createSourceFile('main.ts',await readFile(new URL('../../apps/desktop/src/main/index.ts',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true);
let handler;function visit(n){if(ts.isCallExpression(n)&&n.expression.getText(main)==='ipcMain.handle'&&n.arguments[0]?.text==='source:removeImportGroup')handler=n.arguments[1];ts.forEachChild(n,visit);}visit(main);
const run=(code,ctx)=>vm.runInNewContext(ts.transpileModule(code,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,ctx);
test('batch deletion reports each failed managed file while completing other cleanup and refresh',async()=>{
  const attempted=[],events=[];
  const ctx={trusted:fn=>fn,executableReview:{invalidate:async()=>{}},store:{listSources:()=>[],listLiveSources:()=>['locked','ok'].map(id=>({id,importGroupId:'g',endpoint:'fnd-local://'+id})),removeImportGroup:()=>({pointSources:0,liveSources:2,history:0,health:0,liveFavorites:0,epgPrograms:0,reservations:0,liveSourceIds:['locked','ok']}),getSetting:()=> '[]',setSetting:()=>{}},liveGroupsCache:new Map(),managedPlaylistPath:id=>id,rm:async id=>{attempted.push(id);if(id==='locked')throw Object.assign(new Error('file busy'),{code:'EPERM'});},clearLiveRouteCache:()=>{},cache:{clear:async()=>{}},syncSources:async()=>events.push('refresh'),log:{warn:()=>{},info:()=>{}}};
  ctx.queuePlaylistCleanup=(_store,ids)=>events.push('queued:'+ids.join(','));
  ctx.completePlaylistCleanup=(_store,id)=>events.push('cleaned:'+id);
  assert.ok(handler);run('globalThis.handler='+handler.getText(main),ctx);
  const result=await ctx.handler({importGroupId:'g'});
  assert.deepEqual(attempted,['locked','ok']);assert.deepEqual(events,['queued:locked,ok','cleaned:ok','refresh']);assert.equal(result.managedFiles,1);
  assert.equal(result.managedFileFailures.length,1);assert.equal(result.managedFileFailures[0].sourceId,'locked');assert.match(result.managedFileFailures[0].message,/file busy/);
});
test('renderer preserves partial cleanup warning after source refresh without claiming total deletion',async()=>{
  const code=parse(await readFile(new URL('../../apps/desktop/src/renderer/views/SourcesView.vue',import.meta.url),'utf8')).descriptor.scriptSetup.content;
  const file=ts.createSourceFile('view.ts',code,ts.ScriptTarget.Latest,true);
  const fn=file.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name.text==='deleteImportGroup');
  const ctx={error:{value:''},importMessage:{value:''},localStorage:{getItem:()=>null,removeItem:()=>{}},reload:async clear=>{if(clear!==false)ctx.error.value='';},window:{desktop:{source:{removeImportGroup:async()=>({pointSources:0,liveSources:2,managedFiles:1,managedFileFailures:[{sourceId:'locked',message:'file busy'}]})}}}};
  run(fn.getText(file)+';globalThis.remove=deleteImportGroup;',ctx);
  await ctx.remove({id:'g',label:'Test',pointSources:[],liveSources:[]});
  assert.match(ctx.error.value,/1.*托管.*未能删除/);assert.doesNotMatch(ctx.importMessage.value,/全部关联数据/);
});

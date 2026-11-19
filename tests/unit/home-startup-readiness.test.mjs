import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
const file=await readFile(new URL('../../apps/desktop/src/renderer/views/HomeView.vue',import.meta.url),'utf8');
const code=file.slice(file.indexOf('>')+1,file.indexOf('</script>'));
const ast=ts.createSourceFile('HomeView.ts',code,ts.ScriptTarget.Latest,true);
const script=ts.transpileModule(ast.statements.filter(node=>!ts.isImportDeclaration(node)).map(node=>node.getText(ast)).join('\n')+'\nglobalThis.view={loadDashboard,refreshSourceSummary,checkUpdate,recent,vodFavorites,importRecords,sourceHealthy,diagnostics,update,checkingUpdate,refreshing};',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
const turn=()=>new Promise(setImmediate);
function setup(overrides={}){
  const ping=deferred(),diagnostics=deferred(),update=deferred();let unmount;
  const desktop={source:{ping:()=>ping.promise,list:async()=>[],health:async()=>[]},app:{getInfo:async()=>({version:'test'})},history:{list:async()=>[{id:'local'}]},reservation:{list:async()=>[]},live:{listSources:async()=>[],favorites:async()=>[]},settings:{list:async()=>({'imports.recent':'[{"name":"local import","kind":"vod","importedAt":"2026-11-03"}]'})},diagnostics:{dashboard:()=>diagnostics.promise},update:{check:()=>update.promise},...overrides};
  const context={window:{desktop},ref:value=>({value}),computed:fn=>({get value(){return fn();}}),onMounted:()=>{},onBeforeUnmount:fn=>{unmount=fn;},useSourceChanges:()=>{},useRouter:()=>({}),useToastStore:()=>({success:()=>{},error:()=>{}}),listVodFavorites:async()=>[{videoId:'favorite'}]};
  vm.runInNewContext(script,context);return{view:context.view,desktop,ping,diagnostics,update,unmount:()=>unmount()};
}
test('history, favorites and local settings settle while source, diagnostics and update remain pending',async()=>{
  const {view}=setup();await view.loadDashboard();assert.equal(view.recent.value[0].id,'local');assert.equal(view.vodFavorites.value[0].videoId,'favorite');assert.equal(view.importRecords.value[0].name,'local import');assert.equal(view.refreshing.value,false);assert.equal(view.checkingUpdate.value,true);assert.equal(view.sourceHealthy.value,null);
});
test('older dashboard results cannot replace a newer local refresh',async()=>{
  const older=deferred();let calls=0;const {view}=setup({history:{list:()=>++calls===1?older.promise:Promise.resolve([{id:'new'}])}});
  const first=view.loadDashboard();await view.loadDashboard();older.resolve([{id:'old'}]);await first;assert.equal(view.recent.value[0].id,'new');
});
test('unmount invalidates local and background completions',async()=>{
  const history=deferred(),state=setup({history:{list:()=>history.promise}}),pending=state.view.loadDashboard();state.unmount();history.resolve([{id:'late'}]);state.ping.resolve(true);state.diagnostics.resolve({cacheFiles:9,hardwareDecode:'late',memoryGB:8});state.update.resolve({latest:'late'});await pending;await turn();
  assert.equal(state.view.recent.value.length,0);assert.equal(state.view.sourceHealthy.value,null);assert.equal(state.view.diagnostics.value.cacheFiles,undefined);assert.equal(state.view.update.value,null);
});
test('newer source summary events supersede a dashboard summary still in flight',async()=>{
  const old=deferred(),state=setup();let calls=0;state.desktop.settings.list=()=>++calls===1?old.promise:Promise.resolve({'imports.recent':'[{"name":"new import","kind":"vod","importedAt":"2026-11-03"}]'});
  const first=state.view.loadDashboard();await state.view.refreshSourceSummary();old.resolve({'imports.recent':'[]'});await first;assert.equal(state.view.importRecords.value[0].name,'new import');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import {parse} from '@vue/compiler-sfc';
import {DataService} from '../../services/data-service/dist/index.js';
const file=new URL('../../apps/desktop/src/renderer/views/SourcesView.vue',import.meta.url);
const code=parse(await readFile(file,'utf8')).descriptor.scriptSetup.content;
const source=ts.createSourceFile('sources.ts',code,ts.ScriptTarget.Latest,true);
function functions(names,context){
  if(names.includes('reload'))names=[...names,'retainUnchangedRows'];
  if(names.includes('visibleItems')){names=[...names,'matchesSource'];context.sourceSearch??={value:''};}
  context.reloadGeneration??=0;
  const nodes=source.statements.filter(node=>ts.isFunctionDeclaration(node)&&names.includes(node.name?.text));
  assert.equal(nodes.length,names.length);
  const js=ts.transpileModule(nodes.map(node=>node.getText(source)).join('\n')+'\nglobalThis.api={'+names.join(',')+'}',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
  vm.runInNewContext(js,context);return context.api;
}
const ref=value=>({value});

test('delete preview distinguishes failed reads from verified zero counts',async()=>{
  const ctx={error:ref(''),deleteDraft:ref(null),listVodFavorites:async()=>{throw new Error('unavailable');},window:{desktop:{history:{list:async()=>[]},live:{channels:async()=>{throw new Error('unavailable');},favorites:async()=>[{liveSourceId:'chosen'},{liveSourceId:'other'}]},reservation:{list:async()=>{throw new Error('unavailable');}},epg:{list:async()=>[]}}}};
  const api=functions(['requestRemove','requestRemoveLive'],ctx);
  await api.requestRemove({id:'chosen',name:'Chosen'});
  assert.equal(ctx.deleteDraft.value.counts.find(x=>x.label==='关联收藏').count,null);
  assert.equal(ctx.deleteDraft.value.counts.find(x=>x.label.includes('历史')).count,0);
  await api.requestRemoveLive({id:'chosen',name:'Chosen',origin:'local-file'});
  const counts=Object.fromEntries(ctx.deleteDraft.value.counts.map(x=>[x.label,x.count]));
  assert.equal(counts['直播频道'],null);assert.equal(counts['直播收藏'],1);
  assert.equal(counts['节目预约'],null);assert.equal(counts['EPG 节目单条目'],0);assert.equal(counts['托管的播放列表文件'],1);
  const template=parse(await readFile(file,'utf8')).descriptor.template.content;
  assert.match(template,/item.count\s*\?\?\s*'未能读取'/);
});

test('deletion of a source removed while its dialog was open has a clear error and sends no request',async()=>{
  for(const kind of ['vod','live']){
    let calls=0;
    const ctx={error:ref(''),deleteDraft:ref({kind,id:'gone',name:'Gone',confirmText:'Gone'}),sources:ref([]),liveSources:ref([]),remove:async()=>{calls++;},removeLive:async()=>{calls++;}};
    await functions(['deleteReady','confirmDelete'],ctx).confirmDelete();
    assert.equal(calls,0);assert.match(ctx.error.value,/不存在或已经删除/);assert.equal(ctx.deleteDraft.value,null);
  }
});

test('health stop stays clickable while a batch is active, even if sources disappear',async()=>{
  const template=parse(await readFile(file,'utf8')).descriptor.template.content;
  const button=template.match(/<button\b[^>]*@click="runBulkHealth"[^>]*>/)?.[0];
  assert.ok(button);
  const expression=button.match(/:disabled="([^"]+)"/)[1];
  for(const sources of [[],[{enabled:true}]])assert.equal(vm.runInNewContext(expression,{bulkHealthBusy:true,sources}),false);
  assert.equal(vm.runInNewContext(expression,{bulkHealthBusy:false,sources:[]}),true);
});

test('stopping a pending health batch suppresses later requests and preserves independent audit markers',async()=>{
  for(const count of [1,2]){
    let finish;const calls=[];
    const ctx={sources:ref(Array.from({length:count},(_,i)=>({id:String(i),name:String(i),enabled:true}))),bulkHealthBusy:ref(false),bulkHealthProgress:ref(''),bulkHealthCancel:false,error:ref(''),importMessage:ref(''),audit:ref(null),health:ref([]),auditing:ref(new Set(['independent'])),window:{desktop:{source:{audit:id=>{calls.push(id);return new Promise(resolve=>{finish=resolve;});},health:async()=>[]}}}};
    const {runBulkHealth}=functions(['runBulkHealth'],ctx);
    const batch=runBulkHealth();assert.equal(ctx.bulkHealthBusy.value,true);
    assert.equal(ctx.auditing.value.has('independent'),true);
    await runBulkHealth();assert.match(ctx.bulkHealthProgress.value,/等待当前/);
    finish({ok:true});await batch;
    assert.deepEqual(calls,['0']);assert.match(ctx.bulkHealthProgress.value,/已取消/);
    assert.equal(ctx.bulkHealthBusy.value,false);
    assert.deepEqual([...ctx.auditing.value],['independent']);
  }
});

test('health batch failure releases only its marker and continues remaining checks',async()=>{
  const calls=[];
  const ctx={sources:ref([{id:'a',name:'A',enabled:true},{id:'b',name:'B',enabled:true}]),bulkHealthBusy:ref(false),bulkHealthProgress:ref(''),bulkHealthCancel:false,error:ref(''),importMessage:ref(''),audit:ref(null),health:ref([]),auditing:ref(new Set(['independent'])),window:{desktop:{source:{audit:async id=>{calls.push(id);if(id==='a')throw new Error('controlled failure');return {ok:true};},health:async()=>[]}}}};
  await functions(['runBulkHealth'],ctx).runBulkHealth();
  assert.deepEqual(calls,['a','b']);assert.match(ctx.error.value,/controlled failure/);
  assert.deepEqual([...ctx.auditing.value],['independent']);assert.equal(ctx.bulkHealthBusy.value,false);
});

test('source drag and keyboard ordering share persisted same-group moves and recover from save failure',async t=>{
  const db=new DataService(':memory:');t.after(()=>db.close());
  const items=[{id:'a',name:'A',kind:'T1_JSON'},{id:'b',name:'B',kind:'T1_JSON'},{id:'c',name:'C',kind:'T3_JS'}];
  let fail=false,writes=0;
  const ctx={sources:ref(items),sourceOrder:ref(['missing','a','a','b','c']),sourceOrderBusy:ref(false),draggedSourceId:ref(''),error:ref(''),importMessage:ref(''),computed:read=>({get value(){return read();}}),window:{desktop:{settings:{set:async(key,value)=>{writes++;if(fail)return false;db.setSetting(key,value);return true;}}}}};
  let pagerFocused=false;
  const pager={isConnected:true,focus:()=>{pagerFocused=true;}};
  const rowButton={isConnected:false,closest:()=>({querySelector:()=>pager})};
  const orderEvent={currentTarget:rowButton};
  ctx.document={activeElement:rowButton,body:{}};
  ctx.nextTick=async()=>{ctx.document.activeElement=ctx.document.body;};
  ctx.vodSourcesHeading=ref(null);
  const api=functions(['groupKey','startSourceDrag','stepSource','moveSource'],ctx);
  const declarations=source.statements.flatMap(node=>ts.isVariableStatement(node)?[...node.declarationList.declarations]:[]).filter(node=>['groupMeta','sourceGroups'].includes(node.name.getText(source)));
  assert.equal(declarations.length,2);
  vm.runInNewContext(ts.transpileModule(declarations.map(node=>'const '+node.getText(source)+';').join('\n')+'\nglobalThis.sourceGroups=sourceGroups;',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,ctx);
  const payload=[],transfer={setData:(...args)=>payload.push(args)};
  api.startSourceDrag(items[0],{dataTransfer:transfer});
  assert.equal(transfer.effectAllowed,'move');assert.deepEqual(payload,[['text/plain','a']]);
  await api.moveSource('b');assert.deepEqual(JSON.parse(db.getSetting('source.order')),['b','a','c']);assert.equal(ctx.draggedSourceId.value,'');
  await api.stepSource(items[0],-1,orderEvent);assert.deepEqual(JSON.parse(db.getSetting('source.order')),['a','b','c']);assert.equal(pagerFocused,true);
  const before=writes;await api.stepSource(items[0],-1,orderEvent);assert.equal(writes,before);
  api.startSourceDrag(items[0],{dataTransfer:transfer});await api.moveSource('c');assert.equal(writes,before);
  fail=true;api.startSourceDrag(items[1],{dataTransfer:transfer});await api.moveSource('a');
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.sourceOrder.value)),['a','b','c']);assert.match(ctx.error.value,/排序未确认保存/);assert.equal(ctx.sourceOrderBusy.value,false);
  ctx.sourceOrderBusy.value=true;let prevented=false;api.startSourceDrag(items[0],{preventDefault:()=>{prevented=true;}});await api.stepSource(items[1],-1,orderEvent);assert.equal(prevented,true);assert.equal(writes,before+1);
});

test('the global unhealthy filter applies to live groups and restores healthy and unchecked sources',()=>{
  const live=[{id:'good',origin:'local-file'},{id:'bad',origin:'remote-playlist'},{id:'unchecked',origin:'tvbox'}];
  const ctx={onlyUnhealthy:ref(false),liveSources:ref(live),healthMap:ref(new Map([['good',{ok:true}],['bad',{ok:false}]])),computed:read=>({get value(){return read();}})};
  functions(['visibleItems'],ctx);
  const declarations=source.statements.flatMap(node=>ts.isVariableStatement(node)?[...node.declarationList.declarations]:[]).filter(node=>['liveOriginMeta','liveGroups'].includes(node.name.getText(source)));
  assert.equal(declarations.length,2);
  vm.runInNewContext(ts.transpileModule(declarations.map(node=>'const '+node.getText(source)+';').join('\n')+'\nglobalThis.groups=liveGroups;', {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,ctx);
  const ids=()=>JSON.parse(JSON.stringify(ctx.groups.value.flatMap(group=>group.items.map(item=>item.id))));
  assert.deepEqual(ids(),['good','bad','unchecked']);ctx.onlyUnhealthy.value=true;assert.deepEqual(ids(),['bad']);ctx.onlyUnhealthy.value=false;assert.deepEqual(ids(),['good','bad','unchecked']);
  assert.deepEqual(live.map(item=>item.id),['good','bad','unchecked']);
});
test('all three source dialogs use the native modal layer rather than a below-fold open attribute',async()=>{
  const text=await readFile(file,'utf8');
  assert.equal((text.match(/:ref="element=>syncDialog\(element,/g)||[]).length,3);
  assert.doesNotMatch(text,/<dialog :open=/);
  class Dialog{open=false;shows=0;closes=0;showModal(){this.open=true;this.shows++;}close(){this.open=false;this.closes++;}}
  const {syncDialog}=functions(['syncDialog'],{HTMLDialogElement:Dialog});
  const dialog=new Dialog();syncDialog(dialog,true);syncDialog(dialog,true);assert.equal(dialog.shows,1);
  syncDialog(dialog,false);syncDialog(dialog,false);assert.equal(dialog.closes,1);syncDialog(dialog,true);assert.equal(dialog.shows,2);
  assert.doesNotThrow(()=>syncDialog(null,false));
});
test('live edit clears EPG and User-Agent while retaining unrelated headers',async()=>{
  for(const agent of ['','new-agent']){
    let saved;
    const ctx={error:ref(''),liveSources:ref([{id:'live',name:'Live',enabled:true,endpoint:'https://example.test/list',epg:'https://example.test/old.xml',headers:{'user-agent':'old',Authorization:'Bearer local',Referer:'https://example.test/'}}]),editLiveDraft:{id:'live',name:'Renamed',epg:'',userAgent:agent},editLiveOpen:ref(true),importMessage:ref(''),reload:async()=>{},window:{desktop:{live:{saveSource:async value=>{saved=value;}}}}};
    await functions(['saveEditLive'],ctx).saveEditLive();
    assert.equal(saved.epg,undefined);assert.equal(saved.headers.Authorization,'Bearer local');assert.equal(saved.headers.Referer,'https://example.test/');assert.equal(saved.headers['user-agent'],undefined);assert.equal(saved.headers['User-Agent'],agent||undefined);assert.equal(ctx.editLiveOpen.value,false);
  }
});
test('delete requires exact confirmation and sends only the selected source id',async()=>{
  for(const kind of ['vod','live']){
    const deleted=[],item={id:'chosen',name:'Chosen'};
    const ctx={deleteDraft:ref({kind,id:item.id,name:item.name,confirmText:'wrong'}),sources:ref([item]),liveSources:ref([item]),error:ref(''),remove:async value=>deleted.push(value.id),removeLive:async value=>deleted.push(value.id)};
    const api=functions(['deleteReady','confirmDelete'],ctx);
    await api.confirmDelete();assert.equal(deleted.length,0);
    ctx.deleteDraft.value.confirmText='Chosen';await api.confirmDelete();assert.deepEqual(deleted,['chosen']);assert.equal(ctx.deleteDraft.value,null);
  }
});

test('source buttons persist individual/bulk state, edits, ordering, and deletion through a real database',async t=>{
  const db=new DataService(':memory:');t.after(()=>db.close());
  const point={id:'point',name:'Point',kind:'T1_JSON',endpoint:'https://example.test/api',trust:'A',enabled:true};
  const live={id:'live',name:'Live',endpoint:'https://example.test/list',enabled:true};
  db.saveSource(point);db.saveLiveSource(live);
  const clipboard=[],exports=[],ctx={console,crypto:{randomUUID:()=> 'added'},isExecutable:()=>false};
  for(const [key,value]of Object.entries({sources:[],liveSources:[],health:[],executableStates:[],sourceOrder:[],sourceOrderBusy:false,loading:false,error:'',importMessage:'',bulkBusy:false,draggedSourceId:'',editOpen:false,editLiveOpen:false,onlyUnhealthy:false,audit:null}))ctx[key]=ref(value);
  ctx.healthMap={get value(){return new Map(ctx.health.value.map(item=>[item.sourceId,item]));}};
  ctx.draft={name:' Added ',endpoint:' https://example.test/added ',kind:'T1_JSON',ext:'',jar:''};
  ctx.editDraft={};ctx.editLiveDraft={};
  ctx.window={desktop:{source:{
    list:async()=>db.listSources(),save:async value=>{db.saveSource(value);return value;},remove:async id=>db.removeSource(id),health:async()=>db.listSourceHealth(),executableStatus:async()=>[],
    setEnabledBulk:async ({vodSourceIds,liveSourceIds,enabled})=>({...db.setSourcesEnabledBulk(vodSourceIds,liveSourceIds,enabled),failed:[]}),
    exportAudit:async id=>{exports.push(id);return{canceled:false,path:'test-report.md'};}
  },live:{listSources:async()=>db.listLiveSources(),saveSource:async value=>{db.saveLiveSource(value);return value;},removeSource:async id=>db.removeLiveSource(id)},settings:{list:async()=>db.listSettings(),set:async (key,value)=>{db.setSetting(key,value);return true;}},app:{action:async input=>{clipboard.push(input.copy);return true;}}}};
  const names=['reload','toggle','toggleLive','applyBulk','setAll','setPointSources','setLiveSources','setCompatibilitySources','openEdit','saveEdit','openEditLive','saveEditLive','addSource','groupKey','moveSource','copySource','exportAudit','remove','removeLive','visibleItems'];
  const api=functions(names,ctx);await api.reload();
  await api.toggle(ctx.sources.value[0]);assert.equal(db.listSources()[0].enabled,false);
  await api.toggleLive(ctx.liveSources.value[0]);assert.equal(db.listLiveSources()[0].enabled,false);
  await api.setAll(true);assert.equal(db.listSources()[0].enabled,true);assert.equal(db.listLiveSources()[0].enabled,true);
  await api.setPointSources(ctx.sources.value,false);assert.equal(db.listSources()[0].enabled,false);assert.equal(db.listLiveSources()[0].enabled,true);
  await api.setLiveSources(false);assert.equal(db.listLiveSources()[0].enabled,false);
  db.saveSourceHealth({sourceId:'point',ok:true,score:100,latencyMs:1,checkedAt:new Date().toISOString()});await api.reload();
  await api.setCompatibilitySources(true,true,'启用兼容来源');assert.equal(db.listSources()[0].enabled,true);
  await api.setCompatibilitySources(false,false,'停止不兼容来源');assert.match(ctx.importMessage.value,/没有检查失败/);
  api.openEdit(db.listSources()[0]);ctx.editDraft.name='Renamed';await api.saveEdit();assert.equal(db.listSources()[0].name,'Renamed');
  api.openEditLive(db.listLiveSources()[0]);ctx.editLiveDraft.epg='https://example.test/epg.xml';await api.saveEditLive();assert.equal(db.listLiveSources()[0].epg,'https://example.test/epg.xml');
  await api.addSource();assert.equal(db.listSources().length,2);assert.equal(db.listSources().find(item=>item.id==='added').name,'Added');
  ctx.sourceOrder.value=['point','added'];ctx.draggedSourceId.value='added';await api.moveSource('point');assert.deepEqual(JSON.parse(db.getSetting('source.order')),['added','point']);
  ctx.draggedSourceId.value='added';await api.moveSource('point');assert.deepEqual(JSON.parse(db.getSetting('source.order')),['point','added']);
  await api.copySource(point);
  await api.copySource({...live,sourceLabel:'显示名称'});
  const localPath='D:\\直播 样例\\列表.m3u';
  await api.copySource({...live,endpoint:'fnd-local://fixture',sourceLabel:localPath});
  assert.match(ctx.importMessage.value,/文件路径已复制/);
  await api.copySource({...live,endpoint:'fnd-local://missing-label'});
  assert.deepEqual(clipboard,[point.endpoint,live.endpoint,localPath]);
  ctx.window.desktop.app.action=async()=>false;
  await api.copySource(point);
  assert.match(ctx.error.value,/系统未确认/);
  assert.equal(ctx.importMessage.value,'');
  await api.exportAudit('point');assert.deepEqual(exports,['point']);
  ctx.onlyUnhealthy.value=true;assert.equal(api.visibleItems(ctx.sources.value).length,0);
  await api.remove(point);assert.equal(db.listSources().some(item=>item.id==='point'),false);assert.equal(db.listSources().length,1);
  await api.removeLive(live);assert.equal(db.listLiveSources().length,0);
});

test('application copy IPC acknowledges only text that can be read back',async()=>{
  const file=await readFile(new URL('../../apps/desktop/src/main/index.ts',import.meta.url),'utf8');
  const source=ts.createSourceFile('index.ts',file,ts.ScriptTarget.Latest,true);
  let handler;
  function visit(node){
    if(ts.isCallExpression(node)&&node.expression.getText(source)==='ipcMain.handle'&&node.arguments[0]?.text==='app:action'){
      handler=node.arguments[1]?.arguments?.[0];
    }
    ts.forEachChild(node,visit);
  }
  visit(source);
  assert.ok(handler);
  const writes=[];
  let current='https://example.invalid/old';
  const context={clipboard:{writeText:async value=>{writes.push(value);},readText:async()=>current}};
  const script=ts.transpileModule('globalThis.action='+handler.getText(source),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
  vm.runInNewContext(script,context);
  const text='https://example.invalid/点播?token=%2B';
  assert.equal(await context.action({copy:text}),false);
  current=text;
  assert.equal(await context.action({copy:text}),true);
  current='one\r\ntwo';
  assert.equal(await context.action({copy:'one\ntwo'}),true);
  assert.deepEqual(writes,[text,text,'one\ntwo']);
});

test('partial bulk failures stay visible after refresh and canceled file dialogs do not remain importing',async()=>{
  const state={error:ref(''),importMessage:ref(''),bulkBusy:ref(false),loading:ref(false),sources:ref([{id:'blocked',enabled:false}]),liveSources:ref([]),health:ref([]),executableStates:ref([]),sourceOrder:ref([])};
  state.window={desktop:{source:{list:async()=>[{id:'blocked',enabled:false}],health:async()=>[],executableStatus:async()=>[],setEnabledBulk:async()=>({changed:0,unchanged:0,failed:[{sourceId:'blocked',reason:'需要授权'}]})},live:{listSources:async()=>[],importFile:async()=>({canceled:true})},settings:{list:async()=>({})},config:{importFile:async()=>({canceled:true})}}};
  const api=functions(['reload','applyBulk','importConfigFile','importLiveFile','compatibilitySummary'],state);
  await api.applyBulk(state.sources.value,[],true,'全部启动');assert.match(state.error.value,/需要授权/);assert.equal(state.bulkBusy.value,false);
  await api.importConfigFile();assert.match(state.importMessage.value,/已取消/);await api.importLiveFile();assert.match(state.importMessage.value,/已取消/);
});

test('import, audit, group checks, export and code-review buttons report success/cancel/error and release busy flags',async()=>{
  let fail=false,canceled=false,audited=0,checked=0,reloaded=0;
  const result={sources:[{id:'new'}],liveSources:[],compatibility:[{compatible:true}],warnings:[]};
  const ctx={error:ref(''),importMessage:ref(''),importText:ref('{}'),liveDraft:{name:'test',url:'https://example.test/list',epg:'',userAgent:''},audit:ref(null),health:ref([]),auditing:ref(new Set()),checkingGroups:ref(new Set()),executableBusy:ref(new Set()),bulkHealthBusy:ref(false),bulkHealthProgress:ref(''),bulkHealthCancel:false,sources:ref([{id:'enabled',name:'Enabled',enabled:true},{id:'disabled',enabled:false}]),reload:async()=>{reloaded++;},toast:{success:()=>{},error:()=>{}}};
  const response=async value=>{if(fail)throw new Error('受控失败');return value;};
  ctx.window={desktop:{config:{importText:async()=>response(result),importFile:async()=>response({canceled,result})},live:{importFile:async()=>response({canceled,channelCount:2,compatibility:result.compatibility}),importUrl:async()=>response({channelCount:2,compatibility:result.compatibility})},source:{audit:async()=>{audited++;return response({ok:true});},health:async()=>[],checkImportGroup:async()=>{checked++;return response(result.compatibility);},exportAudit:async()=>response({canceled,path:'local.md'}),reviewExecutable:async()=>response({canceled,path:'review.md'}),approveExecutable:async()=>response({approved:true}),revokeExecutable:async()=>response(true)}}};
  const api=functions(['compatibilitySummary','importConfig','importConfigFile','importLiveFile','importLiveUrl','runAudit','checkGroup','exportAudit','executableAction','runBulkHealth'],ctx);
  await api.importConfig();assert.equal(ctx.importText.value,'');assert.match(ctx.importMessage.value,/已导入/);
  await api.importConfigFile();assert.match(ctx.importMessage.value,/本地配置已导入/);
  await api.importLiveFile();assert.match(ctx.importMessage.value,/共 2 个频道/);
  await api.importLiveUrl();assert.equal(ctx.liveDraft.url,'');
  await api.runAudit({id:'enabled'});assert.equal(ctx.audit.value.ok,true);assert.equal(ctx.auditing.value.size,0);
  await api.checkGroup({id:'group',label:'Group',pointSources:[{}],liveSources:[]});assert.equal(checked,1);assert.equal(ctx.checkingGroups.value.size,0);
  await api.runBulkHealth();assert.equal(audited,2,'disabled sources are excluded');assert.equal(ctx.bulkHealthBusy.value,false);
  for(const action of ['review','approve','revoke']){await api.executableAction({id:'code'},action);assert.equal(ctx.executableBusy.value.size,0);}
  canceled=true;await api.exportAudit('enabled');assert.match(ctx.importMessage.value,/已取消/);
  for(const operation of [()=>api.runAudit({id:'enabled'}),()=>api.checkGroup({id:'group',label:'Group',pointSources:[],liveSources:[]}),()=>api.executableAction({id:'code'},'review'),()=>api.importConfig(),()=>api.importLiveUrl()]){fail=true;await operation();assert.match(ctx.error.value,/受控失败/);}
  assert.equal(ctx.auditing.value.size+ctx.checkingGroups.value.size+ctx.executableBusy.value.size,0);assert.ok(reloaded>=6);
});

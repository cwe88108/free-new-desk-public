import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import {parse} from '@vue/compiler-sfc';
import {DatabaseSync} from 'node:sqlite';
import {DataService} from '../../services/data-service/dist/index.js';
import {PLAYLIST_CLEANUP_KEY} from '../../apps/desktop/dist/main/playlist-cleanup.js';
import {FAVORITES_MAX_BYTES,VOD_FAVORITES_KEY,VOD_FAVORITES_RECOVERY_KEY} from '../../packages/contracts/dist/index.js';

const favorite=(id,extra={})=>({sourceId:'source',sourceName:'Source',videoId:id,name:id,createdAt:'2026-10-19T00:00:00.000Z',...extra});
function memory(t){const db=new DataService(':memory:');t.after(()=>db.close());return db;}
async function disk(t){
  const base=path.resolve(os.tmpdir()),dir=await mkdtemp(path.join(base,'fnd-favorites-')),file=path.join(dir,'app.db'),stores=[];
  const open=()=>{const db=new DataService(file);stores.push(db);return db;};
  t.after(async()=>{for(const db of stores)db.close();assert.ok(path.resolve(dir).startsWith(base+path.sep));await rm(dir,{recursive:true,force:true});});
  return{file,open};
}

test('favorites reject malformed fields and mixed invalid imports before saving any item',t=>{
  const db=memory(t);db.importFavorites({version:1,vod:[favorite('original')]});const before=db.getSetting(VOD_FAVORITES_KEY);
  for(const patch of [{label:123},{createdAt:undefined},{createdAt:'not-a-date'},{name:''},{videoId:'bad\u0000id'}]){
    assert.throws(()=>db.importFavorites({vod:[favorite('good'),favorite('bad',patch)]}),/收藏数据校验失败/);
    assert.equal(db.getSetting(VOD_FAVORITES_KEY),before);
  }
  assert.throws(()=>db.importFavorites({vod:[favorite('new')],live:[{liveSourceId:'live',channelId:'missing-fields'}]}),/收藏数据校验失败/);
  assert.equal(db.getSetting(VOD_FAVORITES_KEY),before);assert.equal(db.listLiveFavorites().length,0);
});

test('legacy malformed favorites are safe to display and are preserved verbatim before cleanup',t=>{
  const db=memory(t),raw=JSON.stringify([favorite('valid'),favorite('bad-label',{label:7}),favorite('missing-date',{createdAt:undefined})]);
  db.setSetting(VOD_FAVORITES_KEY,raw);
  const state=db.vodFavoriteState();assert.equal(state.invalidCount,2);assert.equal(state.items.length,1);
  assert.doesNotThrow(()=>state.items.map(item=>(item.label??item.name).toLowerCase()).sort((a,b)=>a.localeCompare(b)));
  assert.equal(db.vodFavoriteRecovery(),raw);assert.equal(db.getSetting(VOD_FAVORITES_KEY),raw,'reading must not rewrite old data');
  db.mutateVodFavorites({kind:'toggle',item:favorite('new')});
  assert.equal(db.vodFavoriteState().invalidCount,0);assert.equal(db.vodFavoriteState().recoveryAvailable,true);
  assert.equal(db.getSetting(VOD_FAVORITES_RECOVERY_KEY),raw);assert.equal(db.vodFavoriteRecovery(),raw);
  assert.deepEqual(db.vodFavoriteState().items.map(item=>item.videoId),['new','valid']);
});

test('a database failure rolls back mixed import and recovery migration together',async t=>{
  const {file,open}=await disk(t),db=open(),raw=JSON.stringify([favorite('invalid',{createdAt:undefined})]);db.setSetting(VOD_FAVORITES_KEY,raw);
  const sql=new DatabaseSync(file);sql.exec("CREATE TRIGGER reject_live_fixture BEFORE INSERT ON live_favorites BEGIN SELECT RAISE(ABORT,'fixture write failure'); END;");sql.close();
  assert.throws(()=>db.importFavorites({vod:[favorite('new')],live:[{liveSourceId:'live',channelId:'c',channelName:'Channel',group:'Group',url:'https://media.test/live',urls:['https://media.test/live'],createdAt:'2026-10-19T00:00:00Z'}]}),/fixture write failure/);
  assert.equal(db.getSetting(VOD_FAVORITES_KEY),raw);assert.equal(db.getSetting(VOD_FAVORITES_RECOVERY_KEY),undefined);assert.equal(db.listLiveFavorites().length,0);
});

async function renderer(db){
  const source=await readFile(new URL('../../apps/desktop/src/renderer/favorites.ts',import.meta.url),'utf8'),module={exports:{}};
  const output=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
  const context={Date,window:{desktop:{vodFavorites:{list:async()=>db.vodFavoriteState(),mutate:request=>new Promise((resolve,reject)=>setImmediate(()=>{try{resolve(db.mutateVodFavorites(request));}catch(error){reject(error);}}))}}}};
  vm.runInNewContext('(function(module,exports){'+output+'\n})',context)(module,module.exports);return module.exports;
}

test('two real renderer helpers mutate current shared storage without losing another window updates',async t=>{
  const {open}=await disk(t),a=open(),b=open(),first=await renderer(a),second=await renderer(b);
  await Promise.all([first.toggleVodFavorite('source','Source',{id:'a',name:'A'}),second.toggleVodFavorite('source','Source',{id:'b',name:'B'})]);
  assert.deepEqual(a.vodFavoriteState().items.map(item=>item.videoId).sort(),['a','b']);
  await Promise.all([first.renameVodFavorite('source','a','Renamed'),second.toggleVodFavorite('source','Source',{id:'c',name:'C'})]);
  assert.equal(a.vodFavoriteState().items.find(item=>item.videoId==='a').label,'Renamed');
  await first.removeVodFavorites([{sourceId:'source',videoId:'a'}]);
  assert.deepEqual(b.vodFavoriteState().items.map(item=>item.videoId).sort(),['b','c']);
});

test('favorite limits reject the whole operation instead of truncating existing data',t=>{
  const db=memory(t),items=Array.from({length:5000},(_,i)=>favorite(String(i)));db.importFavorites({vod:items});
  const before=db.getSetting(VOD_FAVORITES_KEY);
  assert.throws(()=>db.mutateVodFavorites({kind:'toggle',item:favorite('overflow')}),/收藏数据校验失败/);
  assert.equal(db.getSetting(VOD_FAVORITES_KEY),before);
  assert.throws(()=>db.importFavorites({vod:[favorite('oversized',{name:'x'.repeat(FAVORITES_MAX_BYTES)})]}),/超过8MiB/);
  assert.equal(db.getSetting(VOD_FAVORITES_KEY),before);
});

test('source removal cleans favorites in the same database transaction and preserves other sources',t=>{
  const db=memory(t);
  for(const id of ['source','other'])db.saveSource({id,name:id,kind:'T1_JSON',endpoint:'https://source.test/api',enabled:true,trust:'A'});
  db.importFavorites({vod:[favorite('remove'),favorite('keep',{sourceId:'other'})]});
  assert.equal(db.removeSource('source'),true);
  assert.deepEqual(db.vodFavoriteState().items.map(item=>item.videoId),['keep']);
});

test('generic settings IPC cannot bypass validated favorites or authorization mutations',async()=>{
  const source=ts.createSourceFile('index.ts',await readFile(new URL('../../apps/desktop/src/main/index.ts',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true);let handler,list;
  const find=node=>{if(ts.isCallExpression(node)&&node.arguments[0]&&ts.isStringLiteral(node.arguments[0])){if(node.arguments[0].text==='settings:set')handler=node.arguments[1].arguments[0];if(node.arguments[0].text==='settings:list')list=node.arguments[1];}ts.forEachChild(node,find);};find(source);assert.ok(handler);assert.ok(list);
  const writes=[],context={GITHUB_UPDATE_CREDENTIAL_KEY:'update.credential.github',VOD_FAVORITES_KEY,VOD_FAVORITES_RECOVERY_KEY,PLAYLIST_CLEANUP_KEY,store:{setSetting:(...args)=>writes.push(args)},nativeTheme:{},cache:null,requireLocalSender:()=>{},publicUpdateSettings:()=>({theme:'light',[VOD_FAVORITES_KEY]:'large favorites',[VOD_FAVORITES_RECOVERY_KEY]:'raw backup',[PLAYLIST_CLEANUP_KEY]:'[]'})};
  const output=ts.transpileModule('globalThis.handler='+handler.getText(source)+';globalThis.listHandler='+list.getText(source),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;vm.runInNewContext(output,context);
  for(const key of [VOD_FAVORITES_KEY,VOD_FAVORITES_RECOVERY_KEY,PLAYLIST_CLEANUP_KEY,'update.credential.github'])assert.throws(()=>context.handler({key,value:'unvalidated'}),/专用入口/);
  assert.equal(writes.length,0);assert.equal(context.handler({key:'theme',value:'light'}),true);assert.equal(writes.length,1);
  assert.deepEqual(Object.keys(context.listHandler({})),['theme'],'ordinary settings must not replicate favorites or raw recovery data to every page');
});

test('actual FavoritesView imports valid mixed data and leaves both domains unchanged on invalid input',async t=>{
  const db=memory(t),code=parse(await readFile(new URL('../../apps/desktop/src/renderer/views/FavoritesView.vue',import.meta.url),'utf8')).descriptor.scriptSetup.content;
  const source=ts.createSourceFile('view.ts',code,ts.ScriptTarget.Latest,true),names=new Set(['importFavorites','reload']);
  const functions=source.statements.filter(node=>ts.isFunctionDeclaration(node)&&names.has(node.name?.text)).map(node=>node.getText(source)).join('\n');
  const context={FAVORITES_MAX_BYTES,console,error:{value:''},items:{value:[]},liveItems:{value:[]},reservations:{value:[]},favoriteRecovery:{value:null},availableSources:{value:null},sourceNames:{value:null},window:{desktop:{vodFavorites:{import:async input=>db.importFavorites(input),list:async()=>db.vodFavoriteState()},live:{favorites:async()=>db.listLiveFavorites()},reservation:{list:async()=>[]},source:{list:async()=>[]}}}};
  vm.runInNewContext(ts.transpileModule(functions+'\nglobalThis.importFile=importFavorites;',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,context);
  const live={liveSourceId:'live',channelId:'c',channelName:'Channel',group:'Group',url:'https://media.test/live',urls:['https://media.test/live'],createdAt:'2026-10-19T00:00:00Z'};
  async function importData(value){const raw=JSON.stringify(value),input={value:'selected-file',files:[{size:Buffer.byteLength(raw),text:async()=>raw}]};await context.importFile({target:input});assert.equal(input.value,'');}
  await importData({version:1,vod:[favorite('valid')],live:[live]});
  assert.equal(context.items.value.length,1);assert.equal(context.liveItems.value.length,1);assert.equal(context.error.value,'');
  const before=db.getSetting(VOD_FAVORITES_KEY);
  await importData({vod:[favorite('new')],live:[{...live,channelName:123}]});
  assert.match(context.error.value,/未保存本次内容/);assert.equal(db.getSetting(VOD_FAVORITES_KEY),before);assert.equal(db.listLiveFavorites().length,1);
  let read=false;await context.importFile({target:{value:'oversized',files:[{size:FAVORITES_MAX_BYTES+1,text:async()=>{read=true;return'';}}]}});
  assert.equal(read,false);assert.match(context.error.value,/8MiB/);
});

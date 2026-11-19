import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import {parse} from '@vue/compiler-sfc';
import {ref as vueRef,effect,stop} from 'vue';
const ref=value=>({value});
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return{promise,resolve};};
function run(code,context){vm.runInNewContext(ts.transpileModule(code,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,context);}
async function view(name,method,context){const code=parse(await readFile(new URL(`../../apps/desktop/src/renderer/views/${name}.vue`,import.meta.url),'utf8')).descriptor.scriptSetup.content;const source=ts.createSourceFile('view.ts',code,ts.ScriptTarget.Latest,true);const node=source.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name.text===method);assert.ok(node);const helpers=method==='reload'?source.statements.filter(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='retainUnchangedRows').map(n=>n.getText(source)).join('\n'):'';run(helpers+'\n'+node.getText(source)+`\nglobalThis.action=${method};`,context);return context.action;}

test('background source refresh retains identical reactive rows, applies edits and deletes, and keeps existing tables visible',async()=>{
  let data={point:[{id:'one',enabled:true,name:'One'},{id:'two',enabled:false,name:'Two'}],live:[{id:'live',headers:{Authorization:'old'}}],health:[{sourceId:'one',ok:true,audit:{version:1}}],trust:[{sourceId:'one',approved:true,fingerprint:'old'}],order:['one','two']};
  const state={reloadGeneration:0};for(const [key,value]of Object.entries({loading:false,error:'',sources:[],liveSources:[],health:[],executableStates:[],sourceOrder:[]}))state[key]=vueRef(value);
  let wait;
  const read=async get=>{if(wait)await wait.promise;return structuredClone(get());};
  state.window={desktop:{source:{list:()=>read(()=>data.point),health:()=>read(()=>data.health),executableStatus:()=>read(()=>data.trust)},live:{listSources:()=>read(()=>data.live)},settings:{list:()=>read(()=>({'source.order':JSON.stringify(data.order)}))}}};
  const reload=await view('SourcesView','reload',state);await reload();
  const refs=Object.fromEntries(['sources','liveSources','health','executableStates','sourceOrder'].map(key=>[key,state[key].value]));
  let updates=0;const watcher=effect(()=>{for(const key of Object.keys(refs))state[key].value;updates++;});
  await reload();assert.equal(updates,1);for(const key of Object.keys(refs))assert.equal(state[key].value,refs[key]);
  wait=deferred();const pending=reload();assert.equal(state.loading.value,true);assert.equal(state.sources.value,refs.sources);
  const template=parse(await readFile(new URL('../../apps/desktop/src/renderer/views/SourcesView.vue',import.meta.url),'utf8')).descriptor.template.content;
  assert.match(template,/v-if="loading&&sources.length===0" class="loading-panel">正在读取来源/);
  assert.match(template,/v-if="loading&&totalCount===0" class="loading-panel">正在读取导入源/);
  data.point=[{...data.point[0],enabled:false,name:'Edited'},data.point[1],{id:'new',enabled:true}];
  data.live[0].headers.Authorization='new';data.health[0].audit.version=2;data.trust[0].approved=false;data.trust[0].fingerprint='new';data.order=['two','one','new'];
  wait.resolve();await pending;wait=undefined;
  assert.equal(state.sources.value[1],refs.sources[1]);assert.notEqual(state.sources.value[0],refs.sources[0]);assert.equal(state.sources.value[0].name,'Edited');assert.equal(state.sources.value[0].enabled,false);
  assert.equal(state.liveSources.value[0].headers.Authorization,'new');assert.equal(state.health.value[0].audit.version,2);assert.equal(state.executableStates.value[0].approved,false);assert.equal(state.executableStates.value[0].fingerprint,'new');assert.deepEqual([...state.sourceOrder.value],['two','one','new']);
  data.point=data.point.slice(1);await reload();assert.deepEqual(state.sources.value.map(item=>item.id),['two','new']);
  data.point=[];data.live=[];data.health=[];data.trust=[];data.order=[];await reload();assert.equal(state.sources.value.length,0);assert.equal(state.liveSources.value.length,0);stop(watcher);
});

test('source list survives an auxiliary trust failure; a late refresh cannot overwrite newer imports',async()=>{
  const state={reloadGeneration:0};for(const [key,value]of Object.entries({loading:false,error:'',sources:[],liveSources:[],health:[],executableStates:[],sourceOrder:[]}))state[key]=ref(value);
  const old=deferred();let calls=0;
  state.window={desktop:{source:{list:()=>++calls===1?old.promise:Promise.resolve([{id:'new-vod'}]),health:async()=>[],executableStatus:async()=>{throw Error('trust read failed');}},live:{listSources:async()=>[{id:'new-live'}]},settings:{list:async()=>({})}}};
  const reload=await view('SourcesView','reload',state);
  const pending=reload();await reload();old.resolve([{id:'old-vod'}]);await pending;
  assert.equal(state.sources.value[0].id,'new-vod');assert.equal(state.liveSources.value[0].id,'new-live');assert.match(state.error.value,/trust read failed/);assert.equal(state.loading.value,false);
});

test('VOD imports update the picker without resetting the current catalog; deleted selection falls back',async()=>{
  let values=[{id:'current',name:'Current',enabled:true}];const loaded=[];
  const state={sourceListGeneration:0,browseGeneration:0,detailGeneration:0,sources:ref([...values]),sourceId:ref('current'),items:ref([{id:'keep'}]),homeMeta:ref({}),detail:ref(null),loading:ref(false),error:ref(''),loadSource:async()=>loaded.push(state.sourceId.value),window:{desktop:{source:{list:async()=>values}}}};
  state.enabledSources={get value(){return state.sources.value.filter(item=>item.enabled);}};
  const refresh=await view('VodView','refreshSourceList',state);
  values=[...values,{id:'imported',enabled:true}];await refresh();assert.equal(state.sources.value.length,2);assert.equal(state.items.value[0].id,'keep');assert.equal(loaded.length,0);
  values=values.slice(1);await refresh();assert.equal(state.sourceId.value,'imported');assert.deepEqual(loaded,['imported']);
  values=[];await refresh();assert.equal(state.items.value.length,0);assert.equal(state.sourceId.value,'');
});

test('live imports fill an empty view immediately and preserve an existing channel selection',async()=>{
  let values=[{id:'imported',name:'Live',enabled:true}];const loaded=[];
  const state={sourceListGeneration:0,sourceLoadGeneration:0,selectionGeneration:0,sources:ref([]),sourceId:ref(''),groups:ref([]),selected:ref(null),epg:ref([]),allEpg:ref([]),loading:ref(false),previewActive:ref(false),error:ref(''),localStorage:{getItem:()=>''},loadChannels:async()=>loaded.push(state.sourceId.value),loadFavorites:async()=>{},syncPreview:async()=>{},window:{desktop:{live:{listSources:async()=>values}}}};
  state.enabledSources={get value(){return state.sources.value.filter(item=>item.enabled);}};
  const refresh=await view('LiveView','loadSources',state);
  await refresh();assert.equal(state.sourceId.value,'imported');assert.deepEqual(loaded,['imported']);
  state.selected.value={id:'chosen-channel'};values=[...values,{id:'second',enabled:true}];await refresh();assert.equal(state.sources.value.length,2);assert.equal(state.selected.value.id,'chosen-channel');assert.equal(loaded.length,1);
  values=[];await refresh();assert.equal(state.sourceId.value,'');assert.equal(state.selected.value,null);
});

for(const channel of ['live:importFile','live:importUrl'])test(channel+' notifies saved sources before a slow compatibility check finishes',async()=>{
  const source=ts.createSourceFile('main.ts',await readFile(new URL('../../apps/desktop/src/main/index.ts',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true);
  let handler;function visit(n){if(ts.isCallExpression(n)&&n.expression.getText(source)==='ipcMain.handle'&&n.arguments[0]?.text===channel)handler=n.arguments[1];ts.forEachChild(n,visit);}visit(source);assert.ok(handler);
  const compatibility=deferred(),events=[],saved=[];
  const context={trusted:fn=>fn,requireLocalSender:()=>{},dialog:{showOpenDialog:async()=>({canceled:false,filePaths:['fixture.m3u']})},readImportFile:async(file,limit)=>{assert.equal(file,'fixture.m3u');assert.equal(limit,32*1024*1024);return Buffer.from('#EXTM3U');},fetchText:async()=>'#EXTM3U',parseLivePlaylist:()=>[{channels:[{id:'one'}]}],randomUUID:()=> 'test-id',store:{saveLiveSource:value=>saved.push(value)},mkdir:async()=>{},writeFile:async()=>{},path:{dirname:()=>'.',basename:()=> 'fixture.m3u'},managedPlaylistPath:()=> 'managed.m3u',liveGroupsCache:new Map(),notifySourcesChanged:()=>events.push('changed'),checkLiveCompatibility:()=>{events.push('check');return compatibility.promise;},cache:{put:async()=>{}},log:{info:()=>{}},recordImport:()=>{},Buffer,URL};
  run('globalThis.handler='+handler.getText(source),context);
  let finished=false;const pending=context.handler(channel.endsWith('Url')?{url:'https://example.test/list.m3u'}:{}).then(result=>{finished=true;return result;});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(saved.length,1);assert.deepEqual(events,['changed','check']);assert.equal(finished,false);
  compatibility.resolve({compatible:true});await pending;assert.equal(finished,true);
});

test('source change subscription refreshes mounted views and detaches on unmount',async()=>{
  const source=ts.createSourceFile('changes.ts',await readFile(new URL('../../apps/desktop/src/renderer/source-changes.ts',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true);
  const body=source.statements.filter(n=>!ts.isImportDeclaration(n)).map(n=>n.getText(source)).join('\n');
  const listeners=new Set();let mount,unmount,refreshes=0;
  const context={exports:{},console,onMounted:fn=>{mount=fn;},onBeforeUnmount:fn=>{unmount=fn;},window:{desktop:{source:{onChanged:fn=>{listeners.add(fn);return()=>listeners.delete(fn);}}}}};
  run(body,context);context.exports.useSourceChanges(async()=>{refreshes++;});mount();for(const listener of listeners)listener();await Promise.resolve();assert.equal(refreshes,1);unmount();assert.equal(listeners.size,0);
});

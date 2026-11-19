import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import path from 'node:path';
import {retryPlaylistCleanup} from '../../apps/desktop/dist/main/playlist-cleanup.js';

// Execute the real orchestration with service transports replaced, not a second
// implementation of startup. A permanently pending source must not block shell IPC.
const main=await readFile(new URL('../../apps/desktop/src/main/index.ts',import.meta.url),'utf8');
const startup=main.slice(main.indexOf('app.whenReady().then(async()=>{'),main.indexOf("app.on('window-all-closed'"));
async function launch(){
  let resolve,reject;const sourceReady=new Promise((yes,no)=>{resolve=yes;reject=no;}),events=[];
  const store={getSetting:()=>undefined,listSources:()=>[],setSetting:()=>{}};
  const context={
    app:{whenReady:()=>Promise.resolve(),getPath:()=>'/profile',getVersion:()=> 'test',quit:()=>events.push('quit'),on:()=>{}},
    process:{platform:'linux',arch:'x64'},path,performance,mkdirSync:()=>{},retryPlaylistCleanup,
    DataService:function(){return store;},JsonLogger:function(){return Object.fromEntries(['info','error','fatal'].map(level=>[level,(_category,message)=>events.push(message)]));},
    DiskCache:function(){return{init:async()=>{}};},ImageService:function(){},broker:{},protocol:{handle:()=>{}},
    proxy:{start:async()=>({baseUrl:'http://localhost',token:'test'})},sourceEngine:{initialize:()=>{events.push('initialize');return sourceReady;}},
    registerIpc:()=>events.push('ipc'),installRuntimeGuards:()=>{},notifySourcesChanged:()=>events.push('sources changed'),
    nativeTheme:{},refreshConfiguredEpg:async()=>{},maybeAutoCheckUpdates:async()=>{},setInterval:()=>({unref:()=>{}}),
    createTray:()=>{},createWindow:()=>events.push('window'),showMainWindow:()=>{},scheduleSourceHealth:()=>{},scheduleReservationNotifications:()=>{},
    quitting:false,activationRequested:false,startupComplete:false,
    data:undefined,logger:undefined,cache:undefined,images:undefined,epgRefreshTimer:undefined,updateCheckTimer:undefined,
  };
  await vm.runInNewContext(startup,context);return{events,resolve,reject};
}
test('actual startup creates the window and registers IPC while the source worker is pending',async()=>{
  const state=await launch();assert.deepEqual(state.events,['source engine initialization started','initialize','ipc','application ready','window']);
  state.resolve();await new Promise(setImmediate);assert.ok(state.events.includes('source engine initialization completed'));assert.ok(state.events.includes('sources changed'));
});
test('a delayed source initialization failure is logged without quitting the usable local shell',async()=>{
  const state=await launch();state.reject(new Error('worker failed'));await new Promise(setImmediate);
  assert.ok(state.events.includes('source engine initialization failed'));assert.equal(state.events.includes('quit'),false);
});

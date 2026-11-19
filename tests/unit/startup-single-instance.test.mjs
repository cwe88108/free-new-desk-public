import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import {join} from 'node:path';

const compile=source=>ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
async function bootstrap(lock,{failAt,activateDuring,customProfile=false}={}){
  const code=await readFile(new URL('../../apps/desktop/src/main/bootstrap.ts',import.meta.url),'utf8'),events=[],handlers=new Map();
  const profiles=[];
  const app={commandLine:{hasSwitch:()=>customProfile},getPath:()=>'/test-appdata',setPath:(key,value)=>{profiles.push(value);assert.equal(key,'userData');assert.equal(value,join('/test-appdata','free-new-desk-public'));assert.equal(events.length,0);},requestSingleInstanceLock:()=>{events.push('lock');return lock;},quit:()=>events.push('quit'),exit:code=>events.push('exit:'+code),on:(event,handler)=>handlers.set(event,handler)};
  const context={exports:{},console:{error:()=>events.push('error')},require:name=>{
    if(name==='node:path')return{join};
    if(name==='./distribution.js')return{profileDirectory:'free-new-desk-public'};
    if(name==='electron')return{app,protocol:{registerSchemesAsPrivileged:()=>events.push('protocol')}};
    events.push(name);if(name===activateDuring)handlers.get('second-instance')();if(name===failAt)throw new Error('fixture import failure');
    return name==='./index.js'?{showMainWindow:()=>events.push('activate')}:{};
  }};
  await vm.runInNewContext('(async()=>{'+compile(code)+'})()',context);
  return{events,handlers,profiles};
}

test('public profile is isolated before acquiring the lock and explicit test profiles are respected',async()=>{
  assert.equal((await bootstrap(true)).profiles.length,1);
  assert.equal((await bootstrap(true,{customProfile:true})).profiles.length,0);
});

test('a rejected second instance imports no features and cannot open or recover the music database',async()=>{
  const {events,handlers}=await bootstrap(false);assert.deepEqual(events,['lock','quit']);assert.equal(handlers.size,0);
});

test('primary bootstrap preserves pre-ready protocol setup and IPC guard order while retaining early activation',async()=>{
  const {events,handlers}=await bootstrap(true,{activateDuring:'./music-service.js'});
  assert.deepEqual(events,['lock','protocol','./playback-session-ipc.js','./music-service.js','./fullscreen-overlay.js','./index.js','activate']);
  handlers.get('second-instance')();assert.equal(events.at(-1),'activate');assert.equal(events.filter(event=>event==='activate').length,2);
});

test('bootstrap import failure exits unsuccessfully without starting subsequent features',async()=>{
  const {events}=await bootstrap(true,{failAt:'./music-service.js'});
  assert.deepEqual(events,['lock','protocol','./playback-session-ipc.js','./music-service.js','error','exit:1']);
});

test('activation waits for application initialization and never creates another main window during shutdown',async()=>{
  const text=await readFile(new URL('../../apps/desktop/src/main/index.ts',import.meta.url),'utf8'),source=ts.createSourceFile('index.ts',text,ts.ScriptTarget.Latest,true),method=source.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='showMainWindow');
  let created=0,restored=0,shown=0,focused=0;
  const window={isDestroyed:()=>false,isMinimized:()=>true,restore:()=>restored++,show:()=>shown++,focus:()=>focused++};
  const ctx={exports:{},logger:undefined,startupComplete:false,activationRequested:false,quitting:false,mainWindow:undefined,createWindow:()=>{created++;return window;}};
  vm.runInNewContext(compile(method.getText(source)+'\nglobalThis.activate=showMainWindow'),ctx);
  ctx.activate();assert.equal(created,0);assert.equal(ctx.activationRequested,true);
  ctx.startupComplete=true;ctx.activate();ctx.activate();assert.equal(created,1);assert.equal(restored,2);assert.equal(shown,2);assert.equal(focused,2);
  ctx.mainWindow=undefined;ctx.quitting=true;ctx.activate();assert.equal(created,1);
});

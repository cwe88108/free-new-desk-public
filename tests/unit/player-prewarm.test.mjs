import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';

async function subject(platform='win32'){
  const text=await readFile(new URL('../../apps/desktop/src/main/player-client.ts',import.meta.url),'utf8');
  const source=ts.createSourceFile('client.ts',text,ts.ScriptTarget.Latest,true);
  const cls=source.statements.find(node=>ts.isClassDeclaration(node)&&node.name.text==='PlayerClient');
  const methods=['prewarm','#ensureStarted'].map(name=>cls.members.find(node=>ts.isMethodDeclaration(node)&&node.name.getText(source)===name).getText(source)).join('\n');
  let resolve,reject,starts=0;
  const pending=new Promise((yes,no)=>{resolve=yes;reject=no;});
  const context={process:{platform},start:()=>{starts++;return pending;}};
  vm.runInNewContext(ts.transpileModule(`class Subject {#startPromise;#process;#pipeName='';#start(){return start();}${methods}}globalThis.client=new Subject();`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,context);
  return{client:context.client,resolve,reject,starts:()=>starts};
}
test('prewarm waits for transport readiness and overlapping calls share startup',async()=>{
  const s=await subject();let ready=false;
  const first=s.client.prewarm().then(()=>{ready=true;}),second=s.client.prewarm();
  await Promise.resolve();assert.equal(ready,false);assert.equal(s.starts(),1);
  s.resolve();await Promise.all([first,second]);assert.equal(ready,true);
});
test('prewarm exposes failure rather than claiming host readiness',async()=>{
  const s=await subject();const waiting=s.client.prewarm();s.reject(new Error('missing host'));
  await assert.rejects(waiting,/missing host/);
});
test('prewarm does not spawn a Windows host on other platforms',async()=>{
  const s=await subject('linux');await s.client.prewarm();assert.equal(s.starts(),0);
});

async function windowSubject(){
  const text=await readFile(new URL('../../apps/desktop/src/main/index.ts',import.meta.url),'utf8');
  const source=ts.createSourceFile('index.ts',text,ts.ScriptTarget.Latest,true);
  const create=source.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='createWindow');
  let resolve,reject;const pending=new Promise((yes,no)=>{resolve=yes;reject=no;});
  const calls=[];
  class Window{
    id=1;destroyed=false;
    webContents={setWindowOpenHandler(){},on(){},session:{setPermissionRequestHandler(){}}};
    loadFile(){calls.push('load');return Promise.resolve();}
    getNativeWindowHandle(){calls.push('handle');return Buffer.alloc(8);}
    isDestroyed(){return this.destroyed;}
    on(){}once(){}
  }
  const context={BrowserWindow:Window,data:undefined,restoreWindowBounds:()=>({}),appIconPath:()=>'',nativeTheme:{shouldUseDarkColors:false},process:{platform:'win32'},path:{join:(...parts)=>parts.join('/')},__dirname:'.',quitting:false,logger:{info(){},warn(){calls.push('warning');}},player:{setParentWindowHandle(){calls.push('parent');},prewarm(){calls.push('prewarm');return pending;}},mainWindow:undefined};
  vm.runInNewContext(ts.transpileModule(create.getText(source)+'\nglobalThis.create=createWindow;',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,context);
  return{context,calls,resolve,reject};
}
test('primary renderer loads immediately while prewarm has an explicit parent HWND',async()=>{
  const s=await windowSubject();s.context.create();assert.deepEqual(s.calls,['load','handle','parent','prewarm']);
  s.resolve();await new Promise(resolve=>setImmediate(resolve));assert.equal(s.calls.filter(call=>call==='load').length,1);
});
test('failed prewarm does not block or reload the UI',async()=>{
  const s=await windowSubject();s.context.create();s.reject(new Error('missing host'));
  await new Promise(resolve=>setImmediate(resolve));assert.equal(s.calls.at(-1),'warning');assert.equal(s.calls.filter(call=>call==='load').length,1);
});
test('secondary windows neither replace the parent nor wait on prewarm',async()=>{
  const s=await windowSubject();s.context.create('/music',false);assert.deepEqual(s.calls,['load']);
});

async function traceSubject(throws=false){
  const text=await readFile(new URL('../../apps/desktop/src/main/player-client.ts',import.meta.url),'utf8');
  const source=ts.createSourceFile('client.ts',text,ts.ScriptTarget.Latest,true);
  const cls=source.statements.find(node=>ts.isClassDeclaration(node)&&node.name.text==='PlayerClient');
  const method=cls.members.find(node=>ts.isMethodDeclaration(node)&&node.name.getText(source)==='#loadStage');
  const events=[],metrics=[];
  const context={performance,trace:event=>{events.push({...event});if(throws)throw new Error('disk full');},metric:(...args)=>metrics.push(args)};
  vm.runInNewContext(ts.transpileModule(`class Subject {#loadGeneration=7;recordLoadTrace=trace;recordMetric=metric;${method.getText(source)}run(stage,attempt,operation){return this.#loadStage(stage,attempt,operation);}}globalThis.client=new Subject();`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,context);
  return{client:context.client,events,metrics};
}
test('stage tracing reports starts before unresolved I/O and records failures and retries without payloads',async()=>{
  const s=await traceSubject();let reject;
  const pending=s.client.run('ready',1,()=>new Promise((_,no)=>{reject=no;}));
  assert.equal(s.events[0].phase,'start');assert.equal(s.events.length,1);
  reject(new Error('secret URL and credentials must not be logged'));await assert.rejects(pending,/secret/);
  assert.equal(s.events[1].phase,'failure');assert.equal(s.metrics.length,1);
  assert.equal(await s.client.run('round-trip',2,async()=>42),42);
  assert.equal(s.events.at(-1).phase,'success');assert.equal(s.events.at(-1).attempt,2);
  for(const event of s.events)assert.deepEqual(Object.keys(event).sort(),['attempt','elapsedMs','generation','phase','stage']);
  assert.equal(s.metrics.length,2);
});
test('diagnostic write failure cannot alter transport success or failure',async()=>{
  const s=await traceSubject(true);assert.equal(await s.client.run('ready',1,async()=>42),42);
  await assert.rejects(s.client.run('round-trip',2,async()=>{throw new Error('transport failed');}),/transport failed/);
});

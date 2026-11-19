import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';

const read=file=>readFile(new URL('../../'+file,import.meta.url),'utf8');
const compile=source=>ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const token='github_pat_SYNTHETIC_ONLY';
const authSource=await read('apps/desktop/src/main/github-update-auth.ts');
const mainSource=await read('apps/desktop/src/main/index.ts');
const statements=ts.createSourceFile('index.ts',mainSource,ts.ScriptTarget.Latest,true).statements;
const register=statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='registerIpc');
const authorizationHandlers=register.body.statements.filter(node=>/^ipcMain\.handle\('update:(?:authorization|authorize|forgetAuthorization|openAuthorization)'/.test(node.getText()));
assert.equal(authorizationHandlers.length,4);

function setup(privateDistribution, checkRepoUpdate=async()=>{}){
  const handlers=new Map(),settings=new Map(),opens=[];
  const store={getSetting:key=>settings.get(key),setSetting:(key,value)=>settings.set(key,value),listSettings:()=>Object.fromEntries(settings)};
  const safeStorage={isEncryptionAvailable:()=>true,encryptString:()=>Buffer.from('encrypted-fixture'),decryptString:()=>token};
  const context={Buffer, process, privateDistribution,store,ipcMain:{handle:(name,handler)=>handlers.set(name,handler)},requireLocalSender:event=>{if(!event.local)throw new Error('Untrusted IPC sender');},checkRepoUpdate,shell:{openExternal:url=>opens.push(url)},exports:{},require:name=>{assert.equal(name,'electron');return{safeStorage};}};
  vm.runInNewContext(compile(authSource),context);
  Object.assign(context,context.exports);
  vm.runInNewContext(compile('let updateAuthorizationRevision=0,updateCheckRevision=0; const trusted=handler=>(event,input)=>{requireLocalSender(event);return handler(input);};\n'+authorizationHandlers.map(node=>node.getText()).join('\n')),context);
  return {store,opens,auth:context.exports, invoke:(name,value,local=true)=>handlers.get('update:'+name)({local},value)};
}

test('public distribution rejects authorization changes and masks legacy credentials',async()=>{
  const publicApp=setup(false,async()=>assert.fail('public authorization must not use the network'));
  publicApp.store.setSetting('update.credential.github','legacy encrypted fixture');
  assert.equal(publicApp.invoke('authorization'),null);
  await assert.rejects(publicApp.invoke('authorize',token),/公开版无需授权/);
  assert.throws(()=>publicApp.invoke('forgetAuthorization'),/公开版无需授权/);
  assert.equal(publicApp.invoke('openAuthorization'),false);
  assert.equal(publicApp.opens.length,0);
  assert.equal(publicApp.auth.publicUpdateSettings(publicApp.store)['update.credential.github'],undefined);
});

test('private credential is stored encrypted and is cleared on local removal',async()=>{
  const privateApp=setup(true,async(channel,value)=>{assert.equal(channel,'daily');assert.equal(value,token);});
  assert.throws(()=>privateApp.invoke('authorization',undefined,false),/Untrusted/);
  assert.equal((await privateApp.invoke('authorize',token)).configured,true);
  assert.equal(privateApp.store.getSetting('update.credential.github'),Buffer.from('encrypted-fixture').toString('base64'));
  assert.equal(privateApp.invoke('forgetAuthorization').configured,false);
  assert.equal(privateApp.store.getSetting('update.credential.github'),'');
});

test('removing authorization invalidates an in-flight validation',async()=>{
  let finish;
  const privateApp=setup(true,()=>new Promise(resolve=>{finish=resolve;}));
  const request=privateApp.invoke('authorize',token);
  privateApp.invoke('forgetAuthorization');
  finish();
  await assert.rejects(request,/UPDATE_AUTH_CHANGED/);
  assert.equal(privateApp.store.getSetting('update.credential.github'),'');
});

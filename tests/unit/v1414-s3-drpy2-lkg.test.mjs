import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {fork} from 'node:child_process';
import {mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {DRPY2_PROFILES,resolveDrpy2Profile} from '../../services/source-engine/dist/drpy2-profile.js';
import {ValidatedEngineStore} from '../../services/source-engine/dist/validated-engine-store.js';
import {Drpy2Adapter} from '../../services/source-engine/dist/drpy2-adapter.js';

const sha=value=>createHash('sha256').update(value).digest('hex');
const controlled=new URL('../fixtures/drpy2/controlled-v1/',import.meta.url);
const engineUrl='https://203.0.113.1/engine.js';
const coreUrl='https://203.0.113.1/core.js';

function ask(child,payload,timeout=10000){
  return new Promise((resolve,reject)=>{
    const id=randomUUID(),timer=setTimeout(()=>{child.off('message',onMessage);reject(new Error('worker timeout'));},timeout);
    const onMessage=message=>{if(message?.type!=='response'||message.id!==id)return;clearTimeout(timer);child.off('message',onMessage);message.error?reject(new Error(message.error)):resolve(message.result);};
    child.on('message',onMessage);child.send({...payload,id});
  });
}
test('v1.4.14 S3 profile registry resolves pinned and controlled digests only',async()=>{
  const [engine,core]=await Promise.all([readFile(new URL('engine.js',controlled),'utf8'),readFile(new URL('core.js',controlled),'utf8')]);
  const manifest={engineUrl,family:'drpy2-esm',sha256:sha(engine),dependencies:[{url:coreUrl,sha256:sha(core)}],fetchedAt:0,lastKnownGood:false,validation:'downloaded'};
  const profile=resolveDrpy2Profile(manifest);
  assert.equal(profile.id,'fnd-controlled-drpy2-v1');assert.equal(profile.instantiation,'factory');assert.equal(profile.certification,'controlled-fixture');
  assert.ok(DRPY2_PROFILES.some(item=>item.id==='qist-drpy2-3.9.52beta3-20250801'));
  assert.throws(()=>resolveDrpy2Profile({...manifest,sha256:'0'.repeat(64)}),/PROFILE_UNVERIFIED/);
});

test('v1.4.14 S3 factory failure is not retried as a constructor',async()=>{
  const dir=path.join(os.tmpdir(),`fnd-s3-factory-${randomUUID()}`);await mkdir(dir,{recursive:true});
  const child=fork(new URL('../../services/drpy2-worker/dist/worker.js',import.meta.url),[],{stdio:['ignore','ignore','ignore','ipc'],execArgv:['--experimental-vm-modules']});
  const entry='https://example.com/factory.js';
  const code=`export default function Engine(){if(new.target)return{init(){return this},getRule(){return{ok:true}},home(){return{list:[]}}};throw new Error('factory-only-failure')}`;
  try{
    await assert.rejects(()=>ask(child,{type:'init',sourceId:'factory-fail',entryUrl:entry,modules:{[entry]:code},ruleExt:'x',bridgeDir:dir,profileId:'fixture',hostAbiVersion:'fnd-drpy2-host/3',instantiation:'factory',initContractId:'rule-ext-string-v1',requiredCapabilities:[],methodNames:['home']}),/factory-only-failure/);
  }finally{child.kill();await rm(dir,{recursive:true,force:true});}
});
test('v1.4.14 S3 validated engine store survives restart and falls back to previous digest',async()=>{
  const root=path.join(os.tmpdir(),`fnd-s3-store-${randomUUID()}`),binding={sourceId:'s',configRevision:'r1',accountProfile:'a'};
  const profile={id:'fixture-profile',hostAbiVersion:'abi/1'};
  const makeBundle=(name,code)=>{const url=`https://example.com/${name}.js`,digest=sha(code);return{entryUrl:url,modules:{[url]:code},manifest:{engineUrl:url,family:'drpy2-esm',sha256:digest,dependencies:[],fetchedAt:Date.now(),lastKnownGood:false,validation:'downloaded'},fallback:false};};
  const first=makeBundle('v1','export default {v:1}'),second=makeBundle('v2','export default {v:2}');
  try{
    const store1=new ValidatedEngineStore(root);assert.equal(await store1.saveValidated(binding,first,profile),true);assert.equal(await store1.saveValidated(binding,second,profile),true);
    const store2=new ValidatedEngineStore(root),current=await store2.load(binding);assert.equal(current?.bundle.manifest.sha256,second.manifest.sha256);assert.equal(current?.slot,'current');
    await writeFile(path.join(root,'bundles',`${second.manifest.sha256}.json`),'corrupt','utf8');
    const store3=new ValidatedEngineStore(root),fallback=await store3.load(binding);assert.equal(fallback?.bundle.manifest.sha256,first.manifest.sha256);assert.equal(fallback?.slot,'previous');
  }finally{await rm(root,{recursive:true,force:true});}
});

test('v1.4.14 S3 adapter rolls profile failure back to same-binding persisted LKG',async t=>{
  const [engine,core]=await Promise.all([readFile(new URL('engine.js',controlled),'utf8'),readFile(new URL('core.js',controlled),'utf8')]);
  const storeDir=path.join(os.tmpdir(),`fnd-s3-adapter-${randomUUID()}`),originalFetch=globalThis.fetch;
  let bad=false;
  globalThis.fetch=async input=>{const url=String(input);if(url.endsWith('/core.js'))return new Response(core,{status:200});if(url.endsWith('/engine.js'))return new Response(bad?`export default {init(){return this},getRule(){return{}},home(){return{list:[]}}}`:engine,{status:200});return new Response('missing',{status:404});};
  t.after(()=>{globalThis.fetch=originalFetch;});
  const config={id:'controlled-s3',name:'Controlled S3',kind:'T3_JS',endpoint:engineUrl,enabled:true,trust:'A',configRevision:'rev-fixed',ext:'fixture-rule'};
  const context={sourceId:config.id,configRevision:'rev-fixed',accountProfile:'default',engineStoreDir:storeDir};
  try{
    const first=new Drpy2Adapter(config);await first.init({...context});const home1=await first.getHome();assert.equal(home1.items[0]?.name,'Home One');await first.destroy();
    bad=true;
    const second=new Drpy2Adapter(config);await second.init({...context});const home2=await second.getHome();assert.equal(home2.items[0]?.name,'Home One');await second.destroy();
  }finally{await rm(storeDir,{recursive:true,force:true});}
});

test('v1.4.14 S4 concurrent sources can persist one immutable engine bundle',async()=>{
  const root=path.join(os.tmpdir(),`fnd-s4-race-${randomUUID()}`),profile={id:'fixture-profile',hostAbiVersion:'abi/1'};
  const url='https://example.com/shared.js',code='export default {v:1}',digest=sha(code);
  const bundle={entryUrl:url,modules:{[url]:code},manifest:{engineUrl:url,family:'drpy2-esm',sha256:digest,dependencies:[],fetchedAt:Date.now(),lastKnownGood:false,validation:'downloaded'},fallback:false};
  try{
    await Promise.all(Array.from({length:12},(_,i)=>new ValidatedEngineStore(root).saveValidated({sourceId:`s${i}`,configRevision:'r1',accountProfile:'a'},bundle,profile)));
    const stored=JSON.parse(await readFile(path.join(root,'bundles',`${digest}.json`),'utf8'));
    assert.equal(stored.manifest.sha256,digest);assert.equal(stored.modules[url],code);
  }finally{await rm(root,{recursive:true,force:true});}
});

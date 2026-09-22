import vm from 'node:vm';
import {existsSync,readFileSync,unlinkSync} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {AsyncLocalStorage} from 'node:async_hooks';
import {createDrpy2RuntimeShim,type Drpy2SyncResponse} from '@free-new-desk/catvod-runtime-shim';

type JsonRecord=Record<string,unknown>;
type Callable=(...args:unknown[])=>unknown|Promise<unknown>;
type Engine=Record<string,unknown>;
let sourceId='',entryUrl='',ruleExt='',bridgeDir='',proxyBaseUrl='',proxyToken='',profileId='',hostAbiVersion='';
let instantiation='',initContractId='',requiredCapabilities:string[]=[],methodNames:string[]=[];
let modules:Record<string,string>={},engine:Engine={},messageQueue=Promise.resolve();
const storage=new Map<string,string>();
const sleeper=new Int32Array(new SharedArrayBuffer(4));
const callStore=new AsyncLocalStorage<string>();
const supportedCapabilities=new Set(['req-sync','local-namespaced','pdfh','pdfa','pd','crypto-basic']);
const send=(message:unknown)=>{if(process.send)process.send(message);};
function safeTimeout(value:unknown):number{const n=Number(value);return Math.max(1000,Math.min(30_000,Number.isFinite(n)?n:15_000));}
function responsePath(id:string):string{return path.join(bridgeDir,`${id}.json`);}
function syncReq(url:string,request:JsonRecord={}):Drpy2SyncResponse{
  const id=randomUUID(),file=responsePath(id),timeout=safeTimeout(request.timeout),deadline=Date.now()+timeout;
  send({type:'broker.request',id,callId:callStore.getStore()??'',sourceId,url,options:{...request,timeoutMs:timeout},sync:true});
  while(Date.now()<deadline){
    if(existsSync(file)){
      const raw=readFileSync(file,'utf8');try{unlinkSync(file);}catch{}
      const parsed=JSON.parse(raw) as{result?:Drpy2SyncResponse;error?:string};
      if(parsed.error)throw new Error(parsed.error);if(parsed.result)return parsed.result;throw new Error('DRPY_RESULT_INVALID');
    }
    Atomics.wait(sleeper,0,0,20);
  }
  throw new Error('DRPY_REQ_TIMEOUT');
}
function diagnostic(requestId:string,stage:string,started:number,extra:JsonRecord={}):void{
  send({type:'diagnostic',sourceId,requestId,runtimeFlavor:'drpy2-esm',profileId,hostAbiVersion,stage,elapsedMs:Math.round(performance.now()-started),...extra});
}
function makeContext():vm.Context{
  const safeConsole={log:(...args:unknown[])=>send({type:'log',level:'info',args:args.map(String).slice(0,8)}),warn:(...args:unknown[])=>send({type:'log',level:'warn',args:args.map(String).slice(0,8)}),error:(...args:unknown[])=>send({type:'log',level:'error',args:args.map(String).slice(0,8)})};
  const shim=createDrpy2RuntimeShim({sourceId,store:storage,reqSync:syncReq,proxyResolver:url=>proxyBaseUrl?`${proxyBaseUrl}/proxy?u=${encodeURIComponent(url)}`:url});
  return vm.createContext({console:safeConsole,URL,URLSearchParams,TextEncoder,TextDecoder,setTimeout,clearTimeout,...shim});
}
function resolveSpecifier(specifier:string,parent:string):string{
  if(!/^\.\.?\//.test(specifier))throw new Error(`DRPY_ENGINE_IMPORT_BLOCKED: ${specifier}`);
  const resolved=new URL(specifier,parent).toString(),entryOrigin=new URL(entryUrl).origin;
  if(new URL(resolved).origin!==entryOrigin)throw new Error(`DRPY_ENGINE_IMPORT_BLOCKED: cross-origin ${resolved}`);
  if(!(resolved in modules))throw new Error(`DRPY_ENGINE_LINK_FAILED: module missing ${resolved}`);return resolved;
}
function instantiate(candidate:unknown):Promise<unknown>|unknown{
  if(instantiation==='object')return candidate;
  if(instantiation==='factory'){
    if(typeof candidate!=='function')throw new Error('DRPY_ENGINE_EXPORT_MISSING: factory');
    return Promise.resolve((candidate as Callable)());
  }
  if(instantiation==='constructor'){
    if(typeof candidate!=='function')throw new Error('DRPY_ENGINE_EXPORT_MISSING: constructor');
    return new (candidate as unknown as new()=>unknown)();
  }
  throw new Error(`DRPY_PROFILE_INSTANTIATION_UNKNOWN: ${instantiation}`);
}
function validateHostContract():void{
  for(const capability of requiredCapabilities)if(!supportedCapabilities.has(capability))throw new Error(`DRPY_HOST_CAPABILITY_MISSING: ${capability}`);
  if(initContractId!=='rule-ext-string-v1')throw new Error(`DRPY_INIT_CONTRACT_UNKNOWN: ${initContractId}`);
}
async function loadEngine(requestId:string):Promise<void>{
  validateHostContract();const context=makeContext(),cache=new Map<string,vm.SourceTextModule>();
  const load=async(url:string):Promise<vm.SourceTextModule>=>{
    const existing=cache.get(url);if(existing)return existing;const code=modules[url];
    if(typeof code!=='string')throw new Error(`DRPY_ENGINE_LINK_FAILED: module missing ${url}`);
    const mod=new vm.SourceTextModule(code,{context,identifier:url,initializeImportMeta:meta=>{meta.url=url;},importModuleDynamically:async(specifier,referencing)=>{
      const child=await load(resolveSpecifier(specifier,referencing.identifier));
      if(child.status==='unlinked')await child.link(linker);if(child.status==='linked')await child.evaluate({timeout:8000});return child;
    }});cache.set(url,mod);return mod;
  };
  const linker=async(specifier:string,referencing:vm.Module)=>load(resolveSpecifier(specifier,referencing.identifier));
  const root=await load(entryUrl);let started=performance.now();
  try{await root.link(linker);diagnostic(requestId,'link',started);}catch(error){throw new Error(`DRPY_ENGINE_LINK_FAILED: ${error instanceof Error?error.message:String(error)}`);}
  started=performance.now();try{await root.evaluate({timeout:8000});diagnostic(requestId,'engine-evaluate',started);}catch(error){throw new Error(`DRPY_ENGINE_EVALUATE_FAILED: ${error instanceof Error?error.message:String(error)}`);}
  const namespace=root.namespace as unknown as Record<string,unknown>,candidate=await instantiate(namespace.default??namespace);
  if(!candidate||typeof candidate!=='object')throw new Error('DRPY_ENGINE_EXPORT_MISSING');engine=candidate as Engine;
  const init=engine.init;if(typeof init!=='function')throw new Error('DRPY_ENGINE_EXPORT_MISSING: init');
  started=performance.now();
  try{
    const initialized=await Promise.race([Promise.resolve((init as Callable).call(engine,ruleExt)),new Promise((_,reject)=>setTimeout(()=>reject(new Error('timeout')),20_000))]);
    if(initialized&&typeof initialized==='object')engine=initialized as Engine;diagnostic(requestId,'rule-init',started);
  }catch(error){throw new Error(`DRPY_RULE_INIT_FAILED: ${error instanceof Error?error.message:String(error)}`);}
  const getRule=engine.getRule;if(typeof getRule!=='function')throw new Error('DRPY_RULE_INIT_NOT_READY: getRule missing');
  let rule:unknown;try{rule=await Promise.resolve((getRule as Callable).call(engine));}
  catch(error){throw new Error(`DRPY_RULE_INIT_NOT_READY: ${error instanceof Error?error.message:String(error)}`);}
  if(ruleExt&&(!rule||typeof rule!=='object'||Object.keys(rule as JsonRecord).length===0))throw new Error('DRPY_RULE_INIT_NOT_READY: empty rule');
  for(const method of methodNames)if(typeof engine[method]!=='function')throw new Error(`DRPY_PROFILE_METHOD_MISSING: ${method}`);
  diagnostic(requestId,'profile-contract',performance.now(),{methodCount:methodNames.length,capabilityCount:requiredCapabilities.length});
}
async function call(method:string,args:unknown[],requestId:string):Promise<unknown>{
  const fn=engine[method];if(typeof fn!=='function')throw new Error(`DRPY_API_NOT_IMPLEMENTED: ${method}`);const started=performance.now();
  try{
    const result=await callStore.run(requestId,()=>Promise.race([Promise.resolve((fn as Callable).apply(engine,args)),new Promise((_,reject)=>setTimeout(()=>reject(new Error('timeout')),30_000))]));
    diagnostic(requestId,method,started,{method});return result;
  }catch(error){throw new Error(`DRPY_API_FAILED:${method}: ${error instanceof Error?error.message:String(error)}`);}
}
async function handleMessage(message:unknown):Promise<void>{
  if(!message||typeof message!=='object')return;const data=message as JsonRecord,id=String(data.id??'');
  try{
    if(data.type==='init'){
      sourceId=String(data.sourceId??'');entryUrl=String(data.entryUrl??'');ruleExt=String(data.ruleExt??'');bridgeDir=String(data.bridgeDir??'');
      proxyBaseUrl=String(data.proxyBaseUrl??'');proxyToken=String(data.proxyToken??'');profileId=String(data.profileId??'');hostAbiVersion=String(data.hostAbiVersion??'');
      instantiation=String(data.instantiation??'');initContractId=String(data.initContractId??'');
      requiredCapabilities=Array.isArray(data.requiredCapabilities)?data.requiredCapabilities.filter((item):item is string=>typeof item==='string'):[];
      methodNames=Array.isArray(data.methodNames)?data.methodNames.filter((item):item is string=>typeof item==='string'):[];
      modules=data.modules&&typeof data.modules==='object'?data.modules as Record<string,string>:{};storage.clear();engine={};
      if(!sourceId||!entryUrl||!bridgeDir||!profileId||!hostAbiVersion||!instantiation||!initContractId)throw new Error('DRPY_RULE_INIT_FAILED: invalid init payload');
      await loadEngine(id);send({type:'response',id,result:{ok:true,profileId,hostAbiVersion}});return;
    }
    if(data.type==='call'){
      const method=String(data.method??''),result=await call(method,Array.isArray(data.args)?data.args:[],id);
      if(result&&typeof result==='object'&&proxyBaseUrl&&typeof(result as JsonRecord).url==='string'&&String((result as JsonRecord).url).startsWith(proxyBaseUrl)){
        const value=result as JsonRecord;value.headers={...((value.headers&&typeof value.headers==='object')?value.headers as JsonRecord:{}),Authorization:`Bearer ${proxyToken}`};
      }
      send({type:'response',id,result});return;
    }
    throw new Error('Unsupported drpy2 worker message');
  }catch(error){
    const messageText=error instanceof Error?error.message:String(error);diagnostic(id,'failed',performance.now(),{errorCode:messageText.split(':',1)[0]});send({type:'response',id,error:messageText});
  }
}
process.on('message',message=>{messageQueue=messageQueue.then(()=>handleMessage(message)).catch(error=>send({type:'log',level:'error',args:[error instanceof Error?error.message:String(error)]}));});
process.on('disconnect',()=>process.exit(0));

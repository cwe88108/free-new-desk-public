import type {SourceConfig,SourceEngineResponse} from '@free-new-desk/contracts';
import {SourceEngine} from './index.js';
import {sourceFailure} from './source-failure.js';
interface ParentPortLike{on(event:'message',listener:(event:{data:unknown})=>void):void;postMessage(message:unknown):void;}
interface IncomingRequest{id?:unknown;method?:unknown;params?:unknown;}
const maybeParentPort=(process as typeof process&{parentPort?:ParentPortLike}).parentPort;if(!maybeParentPort)throw new Error('Source Engine must run as an Electron utility process');
const parentPort:ParentPortLike=maybeParentPort,engine=new SourceEngine(),controllers=new Map<string,AbortController>();
const idleTimer=setInterval(()=>{void engine.pruneIdle();},30_000);idleTimer.unref();
function objectParams(value:unknown):Record<string,unknown>{return typeof value==='object'&&value!==null?value as Record<string,unknown>:{};}
function stringParam(params:Record<string,unknown>,key:string):string{const value=params[key];if(typeof value!=='string'||value.length===0)throw new Error(`Invalid ${key}`);return value;}
function stringRecord(value:unknown):Record<string,string>{if(!value||typeof value!=='object'||Array.isArray(value))return{};return Object.fromEntries(Object.entries(value as Record<string,unknown>).filter((entry):entry is [string,string]=>typeof entry[1]==='string'));}

async function handle(data:unknown):Promise<void>{
  const incoming=(typeof data==='object'&&data!==null?data:{}) as IncomingRequest,id=typeof incoming.id==='string'&&incoming.id.length>0?incoming.id:'invalid-request',method=typeof incoming.method==='string'?incoming.method:'',params=objectParams(incoming.params);
  if(method==='source.cancel'){const callId=typeof params.callId==='string'?params.callId:'';controllers.get(callId)?.abort(new DOMException('Source call cancelled','AbortError'));parentPort.postMessage({id,result:{ok:true}} satisfies SourceEngineResponse);return;}
  const controller=new AbortController();controllers.set(id,controller);let response:SourceEngineResponse;
  try{
    if(method==='source.ping')response={id,result:{ok:true,version:'1.4.16-s5'}};
    else if(method==='source.configure'){engine.configureRuntime({...(typeof params.proxyBaseUrl==='string'?{proxyBaseUrl:params.proxyBaseUrl}:{}),...(typeof params.proxyToken==='string'?{proxyToken:params.proxyToken}:{}),...(typeof params.engineStoreDir==='string'?{engineStoreDir:params.engineStoreDir}:{})});response={id,result:{ok:true}};}
    else if(method==='source.replaceAll'){await engine.replaceSources(Array.isArray(params.sources)?params.sources as SourceConfig[]:[]);response={id,result:{ok:true}};}
    else if(method==='source.list')response={id,result:engine.listSources()};
    else if(method==='source.home')response={id,result:await engine.getHome(stringParam(params,'sourceId'),controller.signal)};
    else if(method==='source.category')response={id,result:await engine.getCategory(stringParam(params,'sourceId'),stringParam(params,'categoryId'),typeof params.page==='number'?params.page:1,stringRecord(params.filters),controller.signal)};
    else if(method==='source.search')response={id,result:await engine.search(stringParam(params,'sourceId'),stringParam(params,'keyword'),typeof params.page==='number'?params.page:1,controller.signal)};
    else if(method==='source.detail'){const ids=Array.isArray(params.ids)?params.ids.filter((value):value is string=>typeof value==='string'&&value.length>0):[];if(ids.length===0)throw new Error('Invalid ids');response={id,result:await engine.getDetail(stringParam(params,'sourceId'),ids,controller.signal)};}
    else if(method==='source.play')response={id,result:await engine.getPlay(stringParam(params,'sourceId'),typeof params.flag==='string'?params.flag:'',stringParam(params,'episodeId'),controller.signal)};
    else if(method==='source.playV2')response={id,result:await engine.getPlayV2(stringParam(params,'sourceId'),typeof params.flag==='string'?params.flag:'',stringParam(params,'episodeId'),controller.signal)};
    else if(method==='source.audit')response={id,result:await engine.audit(stringParam(params,'sourceId'))};
    else if(method==='source.releaseLease'){await engine.releaseLease(stringParam(params,'leaseId'));response={id,result:{ok:true}};}
    else response={id,error:{code:'SOURCE_METHOD_UNSUPPORTED',message:'Unsupported source method',recoverable:true}};
  }catch(error){response={id,error:sourceFailure(error)};
  }finally{controllers.delete(id);}
  parentPort.postMessage(response);
}
parentPort.on('message',event=>{void handle(event.data);});
process.on('exit',()=>{clearInterval(idleTimer);for(const controller of controllers.values())controller.abort();controllers.clear();void engine.destroy();});

import type { AppError,SourceConfig,SourceEngineResponse } from '@free-new-desk/contracts';
import { SourceEngine } from './index.js';
interface ParentPortLike{on(event:'message',listener:(event:{data:unknown})=>void):void;postMessage(message:unknown):void;}
interface IncomingRequest{id?:unknown;method?:unknown;params?:unknown;}
const maybeParentPort=(process as typeof process&{parentPort?:ParentPortLike}).parentPort;
if(!maybeParentPort)throw new Error('Source Engine must run as an Electron utility process');
const parentPort:ParentPortLike=maybeParentPort;
const engine=new SourceEngine();
const idleTimer=setInterval(()=>{void engine.pruneIdle();},30_000);idleTimer.unref();
function appError(error:unknown):AppError{return{code:'SOURCE_ENGINE_ERROR',message:error instanceof Error?error.message:String(error),recoverable:true};}
function objectParams(value:unknown):Record<string,unknown>{return typeof value==='object'&&value!==null?value as Record<string,unknown>:{};}
function stringParam(params:Record<string,unknown>,key:string):string{const value=params[key];if(typeof value!=='string'||value.length===0)throw new Error(`Invalid ${key}`);return value;}
function stringRecord(value:unknown):Record<string,string>{if(!value||typeof value!=='object'||Array.isArray(value))return{};return Object.fromEntries(Object.entries(value as Record<string,unknown>).filter((entry):entry is [string,string]=>typeof entry[1]==='string'));}
async function handle(data:unknown):Promise<void>{
  const incoming=(typeof data==='object'&&data!==null?data:{}) as IncomingRequest;const id=typeof incoming.id==='string'&&incoming.id.length>0?incoming.id:'invalid-request';const method=typeof incoming.method==='string'?incoming.method:'';const params=objectParams(incoming.params);let response:SourceEngineResponse;
  try{
    if(method==='source.ping')response={id,result:{ok:true,version:'1.3.8'}};
    else if(method==='source.configure'){engine.configureRuntime({...(typeof params.proxyBaseUrl==='string'?{proxyBaseUrl:params.proxyBaseUrl}:{}),...(typeof params.proxyToken==='string'?{proxyToken:params.proxyToken}:{})});response={id,result:{ok:true}};}
    else if(method==='source.replaceAll'){await engine.replaceSources(Array.isArray(params.sources)?params.sources as SourceConfig[]:[]);response={id,result:{ok:true}};}
    else if(method==='source.list')response={id,result:engine.listSources()};
    else if(method==='source.home')response={id,result:await engine.getHome(stringParam(params,'sourceId'))};
    else if(method==='source.category')response={id,result:await engine.getCategory(stringParam(params,'sourceId'),stringParam(params,'categoryId'),typeof params.page==='number'?params.page:1,stringRecord(params.filters))};
    else if(method==='source.search')response={id,result:await engine.search(stringParam(params,'sourceId'),stringParam(params,'keyword'),typeof params.page==='number'?params.page:1)};
    else if(method==='source.detail'){const ids=Array.isArray(params.ids)?params.ids.filter((value):value is string=>typeof value==='string'&&value.length>0):[];if(ids.length===0)throw new Error('Invalid ids');response={id,result:await engine.getDetail(stringParam(params,'sourceId'),ids)};}
    else if(method==='source.play')response={id,result:await engine.getPlay(stringParam(params,'sourceId'),typeof params.flag==='string'?params.flag:'',stringParam(params,'episodeId'))};
    else if(method==='source.audit')response={id,result:await engine.audit(stringParam(params,'sourceId'))};
    else response={id,error:{code:'SOURCE_METHOD_UNSUPPORTED',message:'Unsupported source method',recoverable:true}};
  }catch(error){response={id,error:appError(error)};}
  parentPort.postMessage(response);
}
parentPort.on('message',event=>{void handle(event.data);});
process.on('exit',()=>{clearInterval(idleTimer);void engine.destroy();});

import {app,utilityProcess,type UtilityProcess} from 'electron';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import type {ExecutableReview,CategoryResult,DetailResult,HomeResult,PlaybackDescriptorV2,PlayResult,SearchResult,SourceAuditResult,SourceConfig,SourceEngineRequest,SourceEngineResponse,SourceEngineResult,SourceSummary} from '@free-new-desk/contracts';

interface PendingCall{child:UtilityProcess;resolve:(value:SourceEngineResponse)=>void;reject:(reason:Error)=>void;timer:NodeJS.Timeout;abort?:()=>void;}
type RuntimeConfig={proxyBaseUrl?:string;proxyToken?:string;engineStoreDir?:string;executableTrustStoreDir?:string};
class SourceProcessError extends Error{constructor(message:string,readonly child:UtilityProcess){super(message);}}
export class SourceEngineClient{
  #child:UtilityProcess|undefined;#stderrTail='';#utilityError='';readonly #pending=new Map<string,PendingCall>();
  #runtimeConfig:RuntimeConfig|undefined;#sources:SourceConfig[]|undefined;#ready:Promise<void>|undefined;
  #closed=false;
  #configSequence=0;#savedConfigSequence=0;#sourceSequence=0;#savedSourceSequence=0;
  // Seed the first restore before starting the worker. Every request shares #ready,
  // so the window can mount while configure -> replaceAll is still in flight.
  initialize(config:RuntimeConfig,sources:SourceConfig[]):Promise<void>{
    if(this.#child)throw new Error('Source Engine is already started');
    this.#runtimeConfig=structuredClone(config);this.#sources=structuredClone(sources);
    this.start();return this.#ready!;
  }
  start():void{
    if(this.#closed)throw new Error('Source Engine is shut down');
    if(this.#child)return;this.#stderrTail='';this.#utilityError='';const entry=path.join(app.getAppPath(),'services','source-engine','dist','worker.js');
    const child=utilityProcess.fork(entry,[],{serviceName:'Free New Desk Source Engine',stdio:['ignore','ignore','pipe']});child.stderr?.setEncoding('utf8');
    child.stderr?.on('data',chunk=>{if(this.#child===child)this.#stderrTail=(this.#stderrTail+String(chunk)).slice(-4000);});child.on('error',(type,location,report)=>{if(this.#child===child)this.#utilityError=`${type} at ${location}: ${report}`.slice(-4000);});
    child.on('message',message=>{const response=message as SourceEngineResponse,pending=this.#pending.get(response.id);if(!pending||pending.child!==child)return;clearTimeout(pending.timer);pending.abort?.();this.#pending.delete(response.id);pending.resolve(response);});
    child.on('exit',code=>{if(this.#child!==child)return;const detail=[`Source Engine exited (code ${code})`,this.#utilityError,this.#stderrTail.trim()].filter(Boolean).join(' | ');this.#child=undefined;this.#ready=undefined;this.#rejectChild(child,new SourceProcessError(detail,child));});this.#child=child;
    this.#ready=this.#restore(child).catch(error=>{if(this.#child===child)this.stop();throw error;});void this.#ready.catch(()=>undefined);
  }
  #rejectChild(child:UtilityProcess,error:Error):void{for(const[id,pending]of this.#pending)if(pending.child===child){clearTimeout(pending.timer);pending.abort?.();this.#pending.delete(id);pending.reject(error);}}
  shutdown():void{this.#closed=true;this.stop();}
  stop():void{const child=this.#child;this.#child=undefined;this.#ready=undefined;if(child){this.#rejectChild(child,new SourceProcessError('Source Engine stopped',child));child.kill();}}
  #cancel(callId:string,child:UtilityProcess):void{try{child.postMessage({id:randomUUID(),method:'source.cancel',params:{callId}} satisfies SourceEngineRequest);}catch{/* a disconnected child cannot accept cancellation */}}
  async #restore(child:UtilityProcess):Promise<void>{
    const config=this.#runtimeConfig,sources=this.#sources;
    for(const request of [...(config?[{id:randomUUID(),method:'source.configure' as const,params:config}]:[]),...(sources?[{id:randomUUID(),method:'source.replaceAll' as const,params:{sources}}]:[])]){
      const response=await this.#send(child,request);if('error'in response)throw new SourceProcessError(`Source Engine restore failed [${response.error.code}] ${response.error.message}`,child);
    }
  }
  async info():Promise<any>{const result=await this.#result({id:randomUUID(),method:'source.ping'});return !Array.isArray(result)&&'ok'in result?result:{ok:false};}
  async ping():Promise<boolean>{return Boolean((await this.info()).ok);}
  async configure(config:RuntimeConfig):Promise<void>{const snapshot=structuredClone(config),sequence=++this.#configSequence;await this.#result({id:randomUUID(),method:'source.configure',params:snapshot});if(sequence>this.#savedConfigSequence){this.#runtimeConfig=snapshot;this.#savedConfigSequence=sequence;}}
  async prepareExecutable(config:SourceConfig):Promise<ExecutableReview>{return await this.#result({id:randomUUID(),method:'source.prepareExecutable',params:{config}}) as ExecutableReview;}
  async resetExecutable(sourceId:string):Promise<void>{await this.#result({id:randomUUID(),method:'source.resetExecutable',params:{sourceId}});}
  async replaceAll(sources:SourceConfig[]):Promise<void>{const snapshot=structuredClone(sources),sequence=++this.#sourceSequence;if(sequence>this.#savedSourceSequence){this.#sources=snapshot;this.#savedSourceSequence=sequence;}await this.#result({id:randomUUID(),method:'source.replaceAll',params:{sources:snapshot}});}
  async list():Promise<SourceSummary[]>{const result=await this.#result({id:randomUUID(),method:'source.list'});return Array.isArray(result)?result:[];}
  async home(sourceId:string,signal?:AbortSignal):Promise<HomeResult>{return await this.#result({id:randomUUID(),method:'source.home',params:{sourceId}},signal) as HomeResult;}
  async category(sourceId:string,categoryId:string,page=1,filters:Record<string,string>={},signal?:AbortSignal):Promise<CategoryResult>{return await this.#result({id:randomUUID(),method:'source.category',params:{sourceId,categoryId,page,filters}},signal) as CategoryResult;}
  async search(sourceId:string,keyword:string,page=1,signal?:AbortSignal):Promise<SearchResult>{return await this.#result({id:randomUUID(),method:'source.search',params:{sourceId,keyword,page}},signal) as SearchResult;}
  async detail(sourceId:string,ids:string[],signal?:AbortSignal):Promise<DetailResult>{return await this.#result({id:randomUUID(),method:'source.detail',params:{sourceId,ids}},signal) as DetailResult;}
  async play(sourceId:string,flag:string,episodeId:string,signal?:AbortSignal):Promise<PlayResult>{return await this.#result({id:randomUUID(),method:'source.play',params:{sourceId,flag,episodeId}},signal) as PlayResult;}
  async playV2(sourceId:string,flag:string,episodeId:string,signal?:AbortSignal):Promise<PlaybackDescriptorV2>{return await this.#result({id:randomUUID(),method:'source.playV2',params:{sourceId,flag,episodeId}},signal) as PlaybackDescriptorV2;}
  async audit(sourceId:string):Promise<SourceAuditResult>{return await this.#result({id:randomUUID(),method:'source.audit',params:{sourceId}}) as SourceAuditResult;}
  async releaseLease(leaseId:string):Promise<void>{await this.#result({id:randomUUID(),method:'source.releaseLease',params:{leaseId}});}
  async #result(request:SourceEngineRequest,signal?:AbortSignal,retry=true):Promise<SourceEngineResult>{
    let response:SourceEngineResponse;try{response=await this.#request(request,signal);}catch(error){const message=error instanceof Error?error.message:String(error);if(retry&&!this.#closed&&!signal?.aborted&&/exited|destroyed|closed|channel|ipc|pipe/i.test(message)){if(!(error instanceof SourceProcessError)||this.#child===error.child)this.stop();const next={...request,id:randomUUID()} as SourceEngineRequest;return this.#result(next,signal,false);}throw error;}
    if('error'in response)throw new Error('['+response.error.code+'] '+response.error.message);return response.result;
  }
  async #request(request:SourceEngineRequest,signal?:AbortSignal):Promise<SourceEngineResponse>{
    if(signal?.aborted)throw signal.reason??new DOMException('Aborted','AbortError');this.start();const child=this.#child,ready=this.#ready;if(!child||!ready)throw new Error('Source Engine is not started');
    if(signal){await new Promise<void>((resolve,reject)=>{const abort=()=>reject(signal.reason??new DOMException('Aborted','AbortError'));signal.addEventListener('abort',abort,{once:true});void ready.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));if(signal.aborted)abort();});}else await ready;
    if(this.#child!==child)throw new SourceProcessError('Source Engine exited during restore',child);return this.#send(child,request,signal);
  }
  #send(child:UtilityProcess,request:SourceEngineRequest,signal?:AbortSignal):Promise<SourceEngineResponse>{
    return new Promise((resolve,reject)=>{
      if(this.#child!==child){reject(new SourceProcessError('Source Engine exited before request',child));return;}
      if(signal?.aborted){reject(signal.reason??new DOMException('Aborted','AbortError'));return;}
      const finishLocal=(reason:Error)=>{const pending=this.#pending.get(request.id);if(!pending)return;clearTimeout(pending.timer);pending.abort?.();this.#pending.delete(request.id);this.#cancel(request.id,child);reject(reason);};
      const timer=setTimeout(()=>finishLocal(new Error(`Source Engine timeout: ${request.method}`)),35_000);
      const onAbort=()=>finishLocal(signal?.reason instanceof Error?signal.reason:new DOMException('Aborted','AbortError'));
      if(signal)signal.addEventListener('abort',onAbort,{once:true});
      this.#pending.set(request.id,{child,resolve,reject,timer,...(signal?{abort:()=>signal.removeEventListener('abort',onAbort)}:{})});try{child.postMessage(request);}catch(error){finishLocal(new SourceProcessError(error instanceof Error?error.message:String(error),child));}
    });
  }
}

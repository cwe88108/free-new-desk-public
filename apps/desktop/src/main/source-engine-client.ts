import {app,utilityProcess,type UtilityProcess} from 'electron';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import type {CategoryResult,DetailResult,HomeResult,PlaybackDescriptorV2,PlayResult,SearchResult,SourceAuditResult,SourceConfig,SourceEngineRequest,SourceEngineResponse,SourceEngineResult,SourceSummary} from '@free-new-desk/contracts';

interface PendingCall{resolve:(value:SourceEngineResponse)=>void;reject:(reason:Error)=>void;timer:NodeJS.Timeout;abort?:()=>void;}
export class SourceEngineClient{
  #child:UtilityProcess|undefined;#stderrTail='';#utilityError='';readonly #pending=new Map<string,PendingCall>();
  start():void{
    if(this.#child)return;this.#stderrTail='';this.#utilityError='';const entry=path.join(app.getAppPath(),'services','source-engine','dist','worker.js');
    const child=utilityProcess.fork(entry,[],{serviceName:'Free New Desk Source Engine',stdio:['ignore','ignore','pipe']});child.stderr?.setEncoding('utf8');
    child.stderr?.on('data',chunk=>{this.#stderrTail=(this.#stderrTail+String(chunk)).slice(-4000);});child.on('error',(type,location,report)=>{this.#utilityError=`${type} at ${location}: ${report}`.slice(-4000);});
    child.on('message',message=>{const response=message as SourceEngineResponse,pending=this.#pending.get(response.id);if(!pending)return;clearTimeout(pending.timer);pending.abort?.();this.#pending.delete(response.id);pending.resolve(response);});
    child.on('exit',code=>{const detail=[`Source Engine exited (code ${code})`,this.#utilityError,this.#stderrTail.trim()].filter(Boolean).join(' | ');for(const pending of this.#pending.values()){clearTimeout(pending.timer);pending.abort?.();pending.reject(new Error(detail));}this.#pending.clear();this.#child=undefined;});this.#child=child;
  }
  stop():void{this.#child?.kill();this.#child=undefined;}
  #cancel(callId:string):void{this.#child?.postMessage({id:randomUUID(),method:'source.cancel',params:{callId}} satisfies SourceEngineRequest);}
  async info():Promise<any>{const result=await this.#result({id:randomUUID(),method:'source.ping'});return !Array.isArray(result)&&'ok'in result?result:{ok:false};}
  async ping():Promise<boolean>{return Boolean((await this.info()).ok);}
  async configure(config:{proxyBaseUrl?:string;proxyToken?:string;engineStoreDir?:string}):Promise<void>{await this.#result({id:randomUUID(),method:'source.configure',params:config});}
  async replaceAll(sources:SourceConfig[]):Promise<void>{await this.#result({id:randomUUID(),method:'source.replaceAll',params:{sources}});}
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
    let response:SourceEngineResponse;try{response=await this.#request(request,signal);}catch(error){const message=error instanceof Error?error.message:String(error);if(retry&&!signal?.aborted&&/exited|destroyed|closed|channel|ipc|pipe/i.test(message)){this.stop();const next={...request,id:randomUUID()} as SourceEngineRequest;return this.#result(next,signal,false);}throw error;}
    if('error'in response)throw new Error('['+response.error.code+'] '+response.error.message);return response.result;
  }
  #request(request:SourceEngineRequest,signal?:AbortSignal):Promise<SourceEngineResponse>{
    this.start();return new Promise((resolve,reject)=>{
      if(signal?.aborted){reject(signal.reason??new DOMException('Aborted','AbortError'));return;}
      const finishLocal=(reason:Error)=>{const pending=this.#pending.get(request.id);if(!pending)return;clearTimeout(pending.timer);pending.abort?.();this.#pending.delete(request.id);this.#cancel(request.id);reject(reason);};
      const timer=setTimeout(()=>finishLocal(new Error(`Source Engine timeout: ${request.method}`)),35_000);
      const onAbort=()=>finishLocal(signal?.reason instanceof Error?signal.reason:new DOMException('Aborted','AbortError'));
      if(signal)signal.addEventListener('abort',onAbort,{once:true});
      this.#pending.set(request.id,{resolve,reject,timer,...(signal?{abort:()=>signal.removeEventListener('abort',onAbort)}:{})});this.#child?.postMessage(request);
    });
  }
}

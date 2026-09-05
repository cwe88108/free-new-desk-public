import { app,utilityProcess,type UtilityProcess } from 'electron';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { CategoryResult,DetailResult,HomeResult,PlayResult,SearchResult,SourceAuditResult,SourceConfig,SourceEngineRequest,SourceEngineResponse,SourceEngineResult,SourceSummary } from '@free-new-desk/contracts';

export class SourceEngineClient{
  #child:UtilityProcess|undefined;
  #pending=new Map<string,{resolve:(value:SourceEngineResponse)=>void;reject:(reason:Error)=>void;timer:NodeJS.Timeout;abort?:()=>void}>();
  start():void{if(this.#child)return;const entry=path.join(app.getAppPath(),'services','source-engine','dist','worker.js');const child=utilityProcess.fork(entry,[],{serviceName:'Free New Desk Source Engine'});child.on('message',message=>{const response=message as SourceEngineResponse;const pending=this.#pending.get(response.id);if(!pending)return;clearTimeout(pending.timer);pending.abort?.();this.#pending.delete(response.id);pending.resolve(response);});child.on('exit',()=>{for(const pending of this.#pending.values()){clearTimeout(pending.timer);pending.abort?.();pending.reject(new Error('Source Engine exited'));}this.#pending.clear();this.#child=undefined;});this.#child=child;}
  stop():void{this.#child?.kill();this.#child=undefined;}
  async info():Promise<any>{const result=await this.#result({id:randomUUID(),method:'source.ping'});return !Array.isArray(result)&&'ok'in result?result:{ok:false};}
  async ping():Promise<boolean>{return Boolean((await this.info()).ok);}
  async configure(config:{proxyBaseUrl?:string;proxyToken?:string}):Promise<void>{await this.#result({id:randomUUID(),method:'source.configure',params:config});}
  async replaceAll(sources:SourceConfig[]):Promise<void>{await this.#result({id:randomUUID(),method:'source.replaceAll',params:{sources}});}
  async list():Promise<SourceSummary[]>{const result=await this.#result({id:randomUUID(),method:'source.list'});return Array.isArray(result)?result:[];}
  async home(sourceId:string):Promise<HomeResult>{return await this.#result({id:randomUUID(),method:'source.home',params:{sourceId}}) as HomeResult;}
  async category(sourceId:string,categoryId:string,page=1,filters:Record<string,string>={}):Promise<CategoryResult>{return await this.#result({id:randomUUID(),method:'source.category',params:{sourceId,categoryId,page,filters}}) as CategoryResult;}
  async search(sourceId:string,keyword:string,page=1,signal?:AbortSignal):Promise<SearchResult>{return await this.#result({id:randomUUID(),method:'source.search',params:{sourceId,keyword,page}},signal) as SearchResult;}
  async detail(sourceId:string,ids:string[]):Promise<DetailResult>{return await this.#result({id:randomUUID(),method:'source.detail',params:{sourceId,ids}}) as DetailResult;}
  async play(sourceId:string,flag:string,episodeId:string):Promise<PlayResult>{return await this.#result({id:randomUUID(),method:'source.play',params:{sourceId,flag,episodeId}}) as PlayResult;}
  async audit(sourceId:string):Promise<SourceAuditResult>{return await this.#result({id:randomUUID(),method:'source.audit',params:{sourceId}}) as SourceAuditResult;}
  async #result(request:SourceEngineRequest,signal?:AbortSignal,retry=true):Promise<SourceEngineResult>{let response:SourceEngineResponse;try{response=await this.#request(request,signal);}catch(error){const message=error instanceof Error?error.message:String(error);if(retry&&!signal?.aborted&&/exited|destroyed|closed|channel|ipc|pipe/i.test(message)){this.stop();const next={...request,id:randomUUID()} as SourceEngineRequest;return this.#result(next,signal,false);}throw error;}if('error'in response)throw new Error(response.error.message);return response.result;}
  #request(request:SourceEngineRequest,signal?:AbortSignal):Promise<SourceEngineResponse>{this.start();return new Promise((resolve,reject)=>{if(signal?.aborted){reject(signal.reason??new DOMException('Aborted','AbortError'));return;}const timer=setTimeout(()=>{this.#pending.delete(request.id);reject(new Error(`Source Engine timeout: ${request.method}`));},25_000);const onAbort=()=>{const pending=this.#pending.get(request.id);if(!pending)return;clearTimeout(pending.timer);this.#pending.delete(request.id);reject(signal?.reason??new DOMException('Aborted','AbortError'));};if(signal)signal.addEventListener('abort',onAbort,{once:true});this.#pending.set(request.id,{resolve,reject,timer,...(signal?{abort:()=>signal.removeEventListener('abort',onAbort)}:{})});this.#child?.postMessage(request);});}
}

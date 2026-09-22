import {fork,type ChildProcess} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import type {CategoryResult,DetailResult,HomeResult,PlaybackDescriptorV2,PlayResult,SearchResult,SourceAdapter,SourceConfig,SourceContext} from '@free-new-desk/contracts';
import {RequestBroker} from '@free-new-desk/source-sdk';
import {normalizeSpiderCategory,normalizeSpiderDetail,normalizeSpiderHome,normalizeSpiderPlay,normalizeSpiderSearch} from './result-normalizer.js';
import {legacyPlayResultToDescriptorV2} from './playback-descriptor.js';

type JsonRecord=Record<string,unknown>;
interface Pending{resolve:(value:unknown)=>void;reject:(error:Error)=>void;timer:NodeJS.Timeout;signal?:AbortSignal;abort?:()=>void;}
function parseResult(value:unknown):unknown{if(typeof value==='string'){const text=value.trim();if(!text)return{};try{return JSON.parse(text) as unknown;}catch{return text;}}return value;}

export class SpiderAdapter implements SourceAdapter{
  readonly #broker=new RequestBroker();
  readonly #pending=new Map<string,Pending>();
  readonly #config:SourceConfig;
  #child:ChildProcess|undefined;
  #context:SourceContext|undefined;
  constructor(config:SourceConfig){this.#config=config;}

  async init(ctx:SourceContext):Promise<void>{
    this.#context=ctx;const defaultHeaders=ctx.requestHeaders??this.#config.headers;
    this.#broker.bindContext(ctx.sourceId,{configRevision:ctx.configRevision??this.#config.configRevision??'legacy',accountProfile:ctx.accountProfile??'default',...(defaultHeaders?{defaultHeaders}:{})});
    const location=this.#scriptLocation(),code=await this.#broker.text({sourceId:ctx.sourceId,url:location,timeoutMs:10_000});
    const entry=fileURLToPath(new URL('../../spider-worker/dist/worker.js',import.meta.url));
    const child=fork(entry,[],{stdio:['ignore','ignore','ignore','ipc'],execArgv:['--max-old-space-size=128'],env:{...process.env,ELECTRON_RUN_AS_NODE:'1'}});    child.on('message',message=>{void this.#onMessage(message);});
    child.on('exit',()=>{for(const pending of this.#pending.values()){clearTimeout(pending.timer);pending.abort?.();pending.reject(new Error('Spider Worker exited'));}this.#pending.clear();this.#child=undefined;});
    this.#child=child;await this.#request({type:'init',sourceId:ctx.sourceId,code,proxyBaseUrl:ctx.proxyBaseUrl??'',proxyToken:ctx.proxyToken??''});
  }
  #scriptLocation():string{
    const candidates=[this.#config.ext,this.#config.endpoint].filter((value):value is string=>typeof value==='string'&&/^https?:\/\//i.test(value));
    const location=candidates[0];if(!location)throw new Error('JS Spider requires a remote HTTP(S) script URL in ext or endpoint');return location;
  }
  async #onMessage(message:unknown):Promise<void>{
    if(!message||typeof message!=='object')return;const data=message as JsonRecord;
    if(data.type==='broker.request'){
      const id=String(data.id??''),callId=String(data.callId??''),callPending=callId?this.#pending.get(callId):undefined;
      try{
        if(callId&&!callPending)throw new DOMException('Aborted','AbortError');
        const options=data.options&&typeof data.options==='object'?data.options as JsonRecord:{};
        const method=typeof options.method==='string'?options.method:undefined;
        const headers=options.headers&&typeof options.headers==='object'?options.headers as Record<string,string>:undefined;
        const body=typeof options.body==='string'?options.body:undefined;
        const result=await this.#broker.text({sourceId:String(data.sourceId??this.#config.id),url:String(data.url??''),...(method?{method}:{}),...(headers?{headers}:{}),...(body!==undefined?{body}:{}),...(callPending?.signal?{signal:callPending.signal}:{})});
        this.#child?.send({type:'broker.response',id,result});
      }catch(error){this.#child?.send({type:'broker.response',id,error:error instanceof Error?error.message:String(error)});}return;
    }
    if(data.type==='response'){
      const id=String(data.id??''),pending=this.#pending.get(id);if(!pending)return;
      clearTimeout(pending.timer);pending.abort?.();this.#pending.delete(id);if(data.error)pending.reject(new Error(String(data.error)));else pending.resolve(data.result);
    }
  }  #request(payload:JsonRecord,signal?:AbortSignal):Promise<unknown>{
    if(!this.#child)throw new Error('Spider Worker is not running');
    if(signal?.aborted)return Promise.reject(signal.reason??new DOMException('Aborted','AbortError'));
    const id=randomUUID(),child=this.#child;
    return new Promise((resolve,reject)=>{
      const cleanup=()=>signal?.removeEventListener('abort',onAbort);
      const onAbort=()=>{const pending=this.#pending.get(id);if(!pending)return;clearTimeout(pending.timer);this.#pending.delete(id);cleanup();child.send({type:'cancel',id});reject(signal?.reason??new DOMException('Aborted','AbortError'));};
      const timer=setTimeout(()=>{this.#pending.delete(id);cleanup();reject(new Error('Spider Worker request timeout'));if(this.#child===child)child.kill();},15_000);
      if(signal)signal.addEventListener('abort',onAbort,{once:true});
      this.#pending.set(id,{resolve,reject,timer,...(signal?{signal,abort:cleanup}:{})});child.send({...payload,id});
    });
  }
  #call(method:string,args:unknown[],signal?:AbortSignal):Promise<unknown>{return this.#request({type:'call',method,args},signal).then(parseResult);}
  async #callFallback(attempts:Array<[string,unknown[]]>,signal?:AbortSignal):Promise<unknown>{
    let last:unknown;for(const[method,args]of attempts){try{return await this.#call(method,args,signal);}catch(error){if(signal?.aborted)throw error;last=error;}}
    throw last instanceof Error?last:new Error('JS Spider method failed');
  }

  async getHome(signal?:AbortSignal):Promise<HomeResult>{
    let home=normalizeSpiderHome(await this.#callFallback([['homeContent',[true]],['home',[true]],['home',[]]],signal));
    if(home.items.length===0)try{const video=normalizeSpiderHome(await this.#callFallback([['homeVideoContent',[]],['homeVod',[]],['homeVideo',[]]],signal));home={...home,items:video.items};}catch{if(signal?.aborted)throw signal.reason??new DOMException('Aborted','AbortError');}
    return home;
  }
  async getCategory(categoryId:string,page:number,filters:Record<string,string>={},signal?:AbortSignal):Promise<CategoryResult>{
    const result=await this.#callFallback([['categoryContent',[categoryId,String(page),true,filters]],['category',[categoryId,page,filters]],['category',[categoryId,String(page),filters]]],signal);return normalizeSpiderCategory(result,page);
  }  async getDetail(ids:string[],signal?:AbortSignal):Promise<DetailResult>{return normalizeSpiderDetail(await this.#callFallback([['detailContent',[ids]],['detail',[ids]]],signal));}
  async search(keyword:string,page=1,signal?:AbortSignal):Promise<SearchResult>{
    const result=await this.#callFallback([['searchContent',[keyword,false,String(page)]],['searchContent',[keyword,false]],['search',[keyword,page]],['search',[keyword,String(page)]]],signal);return normalizeSpiderSearch(result,page);
  }
  async #rawPlay(flag:string,id:string,signal?:AbortSignal):Promise<unknown>{return this.#callFallback([['playerContent',[flag,id,[]]],['play',[flag,id]],['player',[flag,id]]],signal);}
  async getPlay(flag:string,id:string,signal?:AbortSignal):Promise<PlayResult>{return normalizeSpiderPlay(await this.#rawPlay(flag,id,signal));}
  async getPlayV2(flag:string,id:string,signal?:AbortSignal):Promise<PlaybackDescriptorV2>{
    const raw=await this.#rawPlay(flag,id,signal),result=normalizeSpiderPlay(raw);
    return legacyPlayResultToDescriptorV2({sourceId:this.#config.id,configRevision:this.#config.configRevision??'legacy',originProfileId:'legacy-js-spider-v1',flag,rawValue:raw,result});
  }
  async destroy():Promise<void>{
    const child=this.#child;this.#child=undefined;child?.kill();
    for(const pending of this.#pending.values()){clearTimeout(pending.timer);pending.abort?.();pending.reject(new Error('Spider Worker destroyed'));}this.#pending.clear();
    if(this.#context)this.#broker.clearCookies(this.#context.sourceId);this.#context=undefined;
  }
}

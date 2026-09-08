import { fork,type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir,rename,rm,writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CategoryResult,DetailResult,HomeResult,PlayResult,SearchResult,SourceAdapter,SourceConfig,SourceContext } from '@free-new-desk/contracts';
import { RequestBroker } from '@free-new-desk/source-sdk';
import { DrpyEngineManager,assertSafeDrpyNetworkUrl,assertSafeDrpyUrl } from './drpy-engine-manager.js';
import { resolveDrpy2Profile,type Drpy2Profile } from './drpy2-profile.js';
import { normalizeSpiderCategory,normalizeSpiderDetail,normalizeSpiderHome,normalizeSpiderPlay,normalizeSpiderSearch } from './result-normalizer.js';

type JsonRecord=Record<string,unknown>;
interface Pending{resolve:(value:unknown)=>void;reject:(error:Error)=>void;timer:NodeJS.Timeout;generation:number;}
function parseResult(value:unknown):unknown{if(typeof value==='string'){const text=value.trim();if(!text)return{};try{return JSON.parse(text) as unknown;}catch{return text;}}return value;}
function cleanHeaders(value:unknown):Record<string,string>|undefined{if(!value||typeof value!=='object')return;const out:Record<string,string>={};for(const[key,item]of Object.entries(value as JsonRecord))if(typeof item==='string')out[key]=item;return Object.keys(out).length?out:undefined;}
function headerValue(headers:Record<string,string>|undefined,name:string):string{const found=Object.entries(headers??{}).find(([key])=>key.toLowerCase()===name.toLowerCase());return found?.[1]??'';}
function requestBody(options:JsonRecord,headers:Record<string,string>|undefined):string|undefined{if(typeof options.body==='string')return options.body;const data=options.data??options.body;if(data===undefined||data===null)return;const type=headerValue(headers,'content-type').toLowerCase();if(typeof data==='object'){if(type.includes('application/json'))return JSON.stringify(data);const params=new URLSearchParams();for(const[key,value]of Object.entries(data as JsonRecord))params.set(key,String(value??''));return params.toString();}return String(data);}
function decodeResponse(bytes:Buffer,options:JsonRecord,contentType:string):string{if(Number(options.buffer)===2||options.toBase64===true)return bytes.toString('base64');const requested=typeof options.encoding==='string'?options.encoding:contentType.match(/charset=([^;\s]+)/i)?.[1]?.replace(/["']/g,'');try{return new TextDecoder(requested||'utf-8').decode(bytes);}catch{return new TextDecoder('utf-8').decode(bytes);}}
export class Drpy2Adapter implements SourceAdapter{
  readonly #broker=new RequestBroker();readonly #manager=new DrpyEngineManager(this.#broker);readonly #pending=new Map<string,Pending>();readonly #config:SourceConfig;readonly #diagnostics:JsonRecord[]=[];
  #child:ChildProcess|undefined;#context:SourceContext|undefined;#bridgeDir='';#generation=0;#profile:Drpy2Profile|undefined;
  constructor(config:SourceConfig){this.#config=config;}
  #engineUrl():string{const url=this.#config.endpoint;if(!/^https?:\/\//i.test(url))throw new Error('DRPY_UNSUPPORTED_ENGINE: engine URL must be HTTP(S)');return assertSafeDrpyUrl(url).toString();}
  async init(ctx:SourceContext):Promise<void>{
    this.#context=ctx;this.#broker.setDefaultHeaders(ctx.sourceId,ctx.requestHeaders??this.#config.headers);const bundle=await this.#manager.load(ctx.sourceId,this.#engineUrl()),profile=resolveDrpy2Profile(bundle.manifest);this.#profile=profile;
    this.#bridgeDir=path.join(os.tmpdir(),'free-new-desk-drpy2',`${process.pid}-${ctx.sourceId.replace(/[^a-z0-9_.-]/gi,'_')}-${randomUUID()}`);await mkdir(this.#bridgeDir,{recursive:true});
    const entry=fileURLToPath(new URL('../../drpy2-worker/dist/worker.js',import.meta.url)),generation=++this.#generation;
    const env:{[key:string]:string|undefined}={ELECTRON_RUN_AS_NODE:'1',SystemRoot:process.env.SystemRoot,PATH:process.env.PATH,TEMP:process.env.TEMP,TMP:process.env.TMP};
    const child=fork(entry,[],{stdio:['ignore','ignore','ignore','ipc'],execArgv:['--experimental-vm-modules','--max-old-space-size=192'],env});
    child.on('message',message=>{void this.#onMessage(message,generation);});child.on('exit',()=>{if(generation!==this.#generation||this.#child!==child)return;for(const pending of this.#pending.values())if(pending.generation===generation){clearTimeout(pending.timer);pending.reject(new Error('Drpy2 Worker exited'));}for(const[id,pending]of this.#pending)if(pending.generation===generation)this.#pending.delete(id);this.#child=undefined;});this.#child=child;
    await this.#request({type:'init',sourceId:ctx.sourceId,entryUrl:bundle.entryUrl,modules:bundle.modules,ruleExt:this.#config.ext??'',bridgeDir:this.#bridgeDir,proxyBaseUrl:ctx.proxyBaseUrl??'',proxyToken:ctx.proxyToken??'',profileId:profile.id,hostAbiVersion:profile.hostAbiVersion},25_000);this.#manager.markValidated(bundle.entryUrl,'rule-validated');
  }
  async #writeSyncResponse(id:string,payload:unknown):Promise<void>{if(!/^[0-9a-f-]{36}$/i.test(id))throw new Error('DRPY_BRIDGE_ID_INVALID');const target=path.join(this.#bridgeDir,`${id}.json`),temp=`${target}.${randomUUID()}.tmp`;await writeFile(temp,JSON.stringify(payload),'utf8');await rename(temp,target);}
  async #safeBrokerRequest(url:string,options:JsonRecord,method:string|undefined,headers:Record<string,string>|undefined,body:string|undefined,timeoutMs:number):Promise<Response>{
    let current=assertSafeDrpyUrl(url).toString(),currentMethod=method,currentBody=body,currentHeaders=headers;const follow=options.redirect!==0&&options.redirect!==false;
    for(let redirects=0;redirects<=8;redirects+=1){await assertSafeDrpyNetworkUrl(current);const response=await this.#broker.request({sourceId:this.#context?.sourceId??this.#config.id,url:current,...(currentMethod?{method:currentMethod}:{}),...(currentHeaders?{headers:currentHeaders}:{}),...(currentBody!==undefined?{body:currentBody}:{}),timeoutMs,retries:0,maxBytes:8*1024*1024,redirect:'manual'});if(!follow||![301,302,303,307,308].includes(response.status))return response;const location=response.headers.get('location');if(!location)return response;const next=new URL(location,current).toString(),crossOrigin=new URL(next).origin!==new URL(current).origin;await response.body?.cancel();if(crossOrigin&&currentHeaders)currentHeaders=Object.fromEntries(Object.entries(currentHeaders).filter(([key])=>!/^(authorization|cookie|proxy-authorization|host)$/i.test(key)));if(response.status===303||((response.status===301||response.status===302)&&String(currentMethod??'GET').toUpperCase()==='POST')){currentMethod='GET';currentBody=undefined;}current=next;}throw new Error('DRPY_REQ_REDIRECT_LIMIT');
  }
  async #onMessage(message:unknown,generation:number):Promise<void>{
    if(generation!==this.#generation||!message||typeof message!=='object')return;const data=message as JsonRecord;
    if(data.type==='diagnostic'){this.#diagnostics.push({...data});if(this.#diagnostics.length>100)this.#diagnostics.splice(0,this.#diagnostics.length-100);return;}
    if(data.type==='broker.request'){
      const id=String(data.id??'');try{
        const url=assertSafeDrpyUrl(String(data.url??'')).toString(),options=data.options&&typeof data.options==='object'?data.options as JsonRecord:{},method=typeof options.method==='string'?options.method:undefined,headers=cleanHeaders(options.headers),body=requestBody(options,headers),timeoutMs=Math.max(1000,Math.min(30_000,Number(options.timeoutMs??options.timeout??15_000)));
        const response=await this.#safeBrokerRequest(url,options,method,headers,body,timeoutMs),bytes=Buffer.from(await response.arrayBuffer()),content=decodeResponse(bytes,options,response.headers.get('content-type')??'');
        const responseHeaders:Record<string,string|string[]>=Object.fromEntries(response.headers.entries());const setCookie=(response.headers as Headers&{getSetCookie?:()=>string[]}).getSetCookie?.();if(setCookie?.length)responseHeaders['set-cookie']=setCookie;
        await this.#writeSyncResponse(id,{result:{content,headers:responseHeaders,code:response.status,url:response.url||url}});
      }catch(error){await this.#writeSyncResponse(id,{error:error instanceof Error?error.message:String(error)}).catch(()=>undefined);}return;
    }
    if(data.type==='response'){const id=String(data.id??''),pending=this.#pending.get(id);if(!pending||pending.generation!==generation)return;clearTimeout(pending.timer);this.#pending.delete(id);if(data.error)pending.reject(new Error(String(data.error)));else pending.resolve(data.result);}
  }
  #request(payload:JsonRecord,timeoutMs=35_000):Promise<unknown>{if(!this.#child)throw new Error('Drpy2 Worker is not running');const id=randomUUID(),generation=this.#generation,child=this.#child;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.#pending.delete(id);reject(new Error('DRPY_WORKER_HARD_TIMEOUT'));if(this.#child===child&&this.#generation===generation)child.kill();},timeoutMs);this.#pending.set(id,{resolve,reject,timer,generation});child.send({...payload,id});});}
  #call(method:string,args:unknown[]):Promise<unknown>{return this.#request({type:'call',method,args}).then(parseResult);}
  #method(name:keyof Drpy2Profile['methods']):string{const profile=this.#profile;if(!profile)throw new Error('DRPY_PROFILE_NOT_INITIALIZED');return profile.methods[name];}
  async getHome():Promise<HomeResult>{let home=normalizeSpiderHome(await this.#call(this.#method('home'),[true]));if(!home.items.length)try{const video=normalizeSpiderHome(await this.#call(this.#method('homeVod'),[]));home={...home,items:video.items};}catch{}return home;}
  async getCategory(categoryId:string,page:number,filters:Record<string,string>={}):Promise<CategoryResult>{return normalizeSpiderCategory(await this.#call(this.#method('category'),[categoryId,String(page),true,filters]),page);}
  async getDetail(ids:string[]):Promise<DetailResult>{const id=ids[0]??'';if(!id)throw new Error('DRPY_DETAIL_ID_MISSING');return normalizeSpiderDetail(await this.#call(this.#method('detail'),[id]));}
  async search(keyword:string,page=1):Promise<SearchResult>{return normalizeSpiderSearch(await this.#call(this.#method('search'),[keyword,false,String(page)]),page);}
  async getPlay(flag:string,id:string):Promise<PlayResult>{return normalizeSpiderPlay(await this.#call(this.#method('play'),[flag,id,[]]));}
  async destroy():Promise<void>{this.#generation+=1;const child=this.#child;this.#child=undefined;child?.kill();for(const pending of this.#pending.values()){clearTimeout(pending.timer);pending.reject(new Error('Drpy2 Worker destroyed'));}this.#pending.clear();if(this.#bridgeDir)await rm(this.#bridgeDir,{recursive:true,force:true}).catch(()=>undefined);if(this.#context){this.#broker.clearCookies(this.#context.sourceId);this.#broker.clearDefaultHeaders(this.#context.sourceId);}this.#manager.clear();this.#context=undefined;this.#profile=undefined;this.#diagnostics.length=0;}
}

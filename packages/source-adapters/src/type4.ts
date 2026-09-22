import type { CategoryResult,DetailResult,HomeResult,PlaybackDescriptorV2,PlayResult,SearchResult } from '@free-new-desk/contracts';
import { BaseAdapter } from './base.js';
import { buildUrl,jsonDetail,jsonList,parseCmsCategories,parseCmsFilters,parseCmsJson,type CmsJsonPayload } from './common.js';
import {resolveType4Dialect,type4FallbackAllowed,type Type4DialectProfile,type Type4Operation,type Type4RequestMode} from './type4-dialects.js';

type JsonRecord=Record<string,unknown>;
const directProtocol=/^(?:https?|rtmp|rtsp|udp):/i;
function record(value:unknown):JsonRecord{return value&&typeof value==='object'&&!Array.isArray(value)?value as JsonRecord:{};}
function stringValue(value:unknown):string{return typeof value==='string'||typeof value==='number'?String(value).trim():'';}
function boolValue(value:unknown):boolean{return value===true||value===1||value==='1'||value==='true'||value==='yes';}
function parseHeaders(value:unknown):Record<string,string>|undefined{
  let input=value;if(typeof value==='string')try{input=JSON.parse(value) as unknown;}catch{return undefined;}
  const pairs=Object.entries(record(input)).filter(([,item])=>typeof item==='string'||typeof item==='number').map(([key,item])=>[key,String(item)] as [string,string]);
  return pairs.length?Object.fromEntries(pairs):undefined;
}
function normalizePlayPayload(value:unknown):{result:PlayResult;raw:JsonRecord}{
  if(typeof value==='string'){
    const text=value.trim();if(!text)throw new Error('[TYPE4_RESULT_SHAPE_UNSUPPORTED] Empty play response');
    try{return normalizePlayPayload(JSON.parse(text) as unknown);}catch(error){if(directProtocol.test(text))return{result:{url:text,parse:false},raw:{url:text}};if(error instanceof Error&&error.message.startsWith('[TYPE4_'))throw error;throw new Error('[TYPE4_RESULT_SHAPE_UNSUPPORTED] Play response is not JSON or a media URL');}
  }
  const outer=record(value),nested=record(outer.data),raw=stringValue(outer.url??outer.playUrl??outer.play_url)?outer:nested;
  const url=stringValue(raw.url??raw.playUrl??raw.play_url);if(!url)throw new Error('[TYPE4_RESULT_SHAPE_UNSUPPORTED] Play response has no URL');
  const headers=parseHeaders(raw.headers??raw.header),userAgent=stringValue(raw.userAgent??raw.ua),referer=stringValue(raw.referer??raw.ref),parse=boolValue(raw.parse)||boolValue(raw.jx);
  return{result:{url,parse,...(headers?{headers}:{}),...(userAgent?{userAgent}:{}),...(referer?{referer}:{})},raw};
}
export class Type4Adapter extends BaseAdapter{
  readonly #ext:string|undefined;readonly #dialect:Type4DialectProfile;readonly #configRevision:string;
  constructor(endpoint:string,ext?:string,dialectId?:string,configRevision='legacy'){super(endpoint);this.#ext=ext;this.#dialect=resolveType4Dialect(dialectId);this.#configRevision=configRevision;}
  #encodedExt():string|undefined{return this.#ext?Buffer.from(this.#ext,'utf8').toString('base64'):undefined;}
  async #get<T>(params:Record<string,string|number|undefined>,signal?:AbortSignal):Promise<T>{return this.broker.json<T>({sourceId:this.sourceId(),url:buildUrl(this.endpoint,{...params,...(this.#encodedExt()?{ext:this.#encodedExt()}:{})}),retries:1,...(signal?{signal}:{})});}
  async #post<T>(method:string,payload:Record<string,unknown>,signal?:AbortSignal):Promise<T>{return this.broker.jsonPost<T>({sourceId:this.sourceId(),url:this.endpoint,retries:1,...(signal?{signal}:{})},{method,action:method,...payload,...(this.#ext?{ext:this.#ext}:{})});}
  async #request<T>(operation:Type4Operation,getParams:Record<string,string|number|undefined>,postPayload:Record<string,unknown>,signal?:AbortSignal):Promise<T>{
    const primary=operation==='play'?this.#dialect.playPrimary:this.#dialect.metadataPrimary;
    const invoke=(mode:Type4RequestMode)=>mode==='get'?this.#get<T>(getParams,signal):this.#post<T>(operation,postPayload,signal);
    try{return await invoke(primary);}catch(error){if(!type4FallbackAllowed(error,this.#dialect))throw error;return invoke(primary==='get'?'post-json':'get');}
  }
  async getHome(signal?:AbortSignal):Promise<HomeResult>{const payload=await this.#request<CmsJsonPayload>('home',{ac:'detail'},{},signal);const categories=parseCmsCategories(payload),filters=parseCmsFilters(payload);return{items:parseCmsJson(payload),...(categories.length?{categories}:{}),...(Object.keys(filters).length?{filters}:{})};}
  async getCategory(categoryId:string,page:number,filters:Record<string,string>={},signal?:AbortSignal):Promise<CategoryResult>{const result=await this.#request<CmsJsonPayload>('category',{ac:'detail',t:categoryId,pg:page,...(Object.keys(filters).length?{f:JSON.stringify(filters)}:{})},{tid:categoryId,page,extend:filters},signal);const totalPages=Math.max(page,Number(result.pagecount??page)||page),totalItems=Math.max(0,Number(result.total??result.recordcount??0)||0);return{page,hasMore:page<totalPages,totalPages,...(totalItems?{totalItems}:{}),items:parseCmsJson(result)};}
  async search(keyword:string,page=1,signal?:AbortSignal):Promise<SearchResult>{const payload=await this.#request<CmsJsonPayload>('search',{ac:'detail',wd:keyword,pg:page},{wd:keyword,page},signal);return{page,items:parseCmsJson(payload)};}
  async getDetail(ids:string[],signal?:AbortSignal):Promise<DetailResult>{const payload=await this.#request<CmsJsonPayload>('detail',{ac:'detail',ids:ids.join(',')},{ids},signal);const item=jsonList(payload)[0];if(!item)throw new Error('[TYPE4_RESULT_SHAPE_UNSUPPORTED] Detail returned no video');return jsonDetail(item);}
  async #rawPlay(flag:string,id:string,signal?:AbortSignal):Promise<unknown>{return this.#request<unknown>('play',{ac:'play',flag,id},{flag,id},signal);}
  override async getPlay(flag:string,id:string,signal?:AbortSignal):Promise<PlayResult>{return normalizePlayPayload(await this.#rawPlay(flag,id,signal)).result;}
  async getPlayV2(flag:string,id:string,signal?:AbortSignal):Promise<PlaybackDescriptorV2>{
    const{result,raw}=normalizePlayPayload(await this.#rawPlay(flag,id,signal)),requiresParser=boolValue(raw.parse)||boolValue(raw.jx);
    return{schemaVersion:2,sourceId:this.sourceId(),configRevision:this.#configRevision,originProfileId:this.#dialect.id,rawHints:{...(raw.parse!==undefined?{parse:raw.parse}:{}),...(raw.jx!==undefined?{jx:raw.jx}:{}),...(flag?{flag}:{})},resolutionIntent:requiresParser?'parser':'direct',candidates:[{id:'primary',target:requiresParser?{kind:'parser-input',value:result.url,parserIds:[]}:{kind:'media',url:result.url},seekability:'unknown',...(result.headers?{headers:result.headers}:{})}],drmStatus:'none'};
  }
}

import type { CategoryResult,DetailResult,HomeResult,PlayResult,SearchResult } from '@free-new-desk/contracts';
import { BaseAdapter } from './base.js';
import { buildUrl,jsonDetail,jsonList,parseCmsCategories,parseCmsFilters,parseCmsJson,type CmsJsonPayload } from './common.js';

export class Type4Adapter extends BaseAdapter{
  readonly #ext:string|undefined;
  constructor(endpoint:string,ext?:string){super(endpoint);this.#ext=ext;}
  #encodedExt():string|undefined{return this.#ext?Buffer.from(this.#ext,'utf8').toString('base64'):undefined;}
  async #get(params:Record<string,string|number|undefined>):Promise<CmsJsonPayload>{return this.broker.json<CmsJsonPayload>({sourceId:this.sourceId(),url:buildUrl(this.endpoint,{...params,...(this.#encodedExt()?{ext:this.#encodedExt()}:{})}),retries:1});}
  async #post<T>(method:string,payload:Record<string,unknown>):Promise<T>{return this.broker.jsonPost<T>({sourceId:this.sourceId(),url:this.endpoint,retries:1},{method,action:method,...payload,...(this.#ext?{ext:this.#ext}:{})});}
  async getHome():Promise<HomeResult>{let payload:CmsJsonPayload;try{payload=await this.#get({ac:'detail'});}catch{payload=await this.#post<CmsJsonPayload>('home',{});}const categories=parseCmsCategories(payload),filters=parseCmsFilters(payload);return{items:parseCmsJson(payload),...(categories.length?{categories}:{}),...(Object.keys(filters).length?{filters}:{})};}
  async getCategory(categoryId:string,page:number,filters:Record<string,string>={}):Promise<CategoryResult>{let result:CmsJsonPayload;try{result=await this.#get({ac:'detail',t:categoryId,pg:page,...(Object.keys(filters).length?{f:JSON.stringify(filters)}:{})});}catch{result=await this.#post<CmsJsonPayload>('category',{tid:categoryId,page,extend:filters});}const totalPages=Math.max(page,Number(result.pagecount??page)||page),totalItems=Math.max(0,Number(result.total??result.recordcount??0)||0);return{page,hasMore:page<totalPages,totalPages,...(totalItems?{totalItems}:{}),items:parseCmsJson(result)};}
  async search(keyword:string,page=1):Promise<SearchResult>{let payload:CmsJsonPayload;try{payload=await this.#get({ac:'detail',wd:keyword,pg:page});}catch{payload=await this.#post<CmsJsonPayload>('search',{wd:keyword,page});}return{page,items:parseCmsJson(payload)};}
  async getDetail(ids:string[]):Promise<DetailResult>{let payload:CmsJsonPayload;try{payload=await this.#get({ac:'detail',ids:ids.join(',')});}catch{payload=await this.#post<CmsJsonPayload>('detail',{ids});}const item=jsonList(payload)[0];if(!item)throw new Error('Type4 detail returned no video');return jsonDetail(item);}
  override async getPlay(flag:string,id:string):Promise<PlayResult>{try{return await this.#post<PlayResult>('play',{flag,id});}catch{return super.getPlay(flag,id);}}
}

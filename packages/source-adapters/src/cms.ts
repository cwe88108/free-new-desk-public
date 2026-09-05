import type { CategoryResult,DetailResult,HomeResult,SearchResult } from '@free-new-desk/contracts';
import { BaseAdapter } from './base.js';
import { buildUrl,jsonDetail,jsonList,numberValue,parseCmsCategories,parseCmsFilters,parseCmsJson,parseCmsXml,parseCmsXmlCategories,videoBlocks,xmlDetail,type CmsJsonPayload } from './common.js';
export{parseCmsCategories,parseCmsFilters,parseCmsJson,parseCmsXml,parseCmsXmlCategories};
export type{CmsJsonPayload};

function jsonPagination(payload:CmsJsonPayload,page:number,itemCount:number):{totalPages:number;totalItems?:number;hasMore:boolean}{
  const declaredPages=Math.max(0,numberValue(payload.pagecount,0));
  const total=Math.max(0,numberValue(payload.total??payload.recordcount,0));
  const declaredLimit=Math.max(0,numberValue(payload.limit??payload.pagesize??payload.page_size??payload.pageSize,0));
  const effectiveLimit=declaredLimit||itemCount||20;
  const inferredPages=total>0&&effectiveLimit>0?Math.ceil(total/effectiveLimit):0;
  const totalPages=Math.max(page,declaredPages,inferredPages);
  const hasMetadata=declaredPages>0||total>0||declaredLimit>0;
  const hasMore=page<totalPages||(!hasMetadata&&itemCount>=20);
  return{totalPages:hasMore&&totalPages===page?page+1:totalPages,...(total>0?{totalItems:total}:{}),hasMore};
}
function xmlPagination(xml:string,page:number,itemCount:number):{totalPages:number;totalItems?:number;hasMore:boolean}{
  const listTag=xml.match(/<list\b([^>]*)>/i)?.[1]??'';
  const declaredPages=Math.max(0,Number(listTag.match(/pagecount=["'](\d+)["']/i)?.[1]??0));
  const total=Math.max(0,Number(listTag.match(/(?:recordcount|total)=["'](\d+)["']/i)?.[1]??0));
  const declaredLimit=Math.max(0,Number(listTag.match(/(?:pagesize|limit)=["'](\d+)["']/i)?.[1]??0));
  const effectiveLimit=declaredLimit||itemCount||20;
  const inferredPages=total>0&&effectiveLimit>0?Math.ceil(total/effectiveLimit):0;
  const totalPages=Math.max(page,declaredPages,inferredPages);
  const hasMetadata=declaredPages>0||total>0||declaredLimit>0;
  const hasMore=page<totalPages||(!hasMetadata&&itemCount>=20);
  return{totalPages:hasMore&&totalPages===page?page+1:totalPages,...(total>0?{totalItems:total}:{}),hasMore};
}
function categoryParams(categoryId:string,page:number,filters:Record<string,string>):Record<string,string|number|undefined>{
  const clean=Object.fromEntries(Object.entries(filters).filter(([,value])=>value!==''));
  return{...clean,ac:'detail',t:categoryId,pg:page,...(Object.keys(clean).length?{f:JSON.stringify(clean)}:{})};
}

export class CmsJsonAdapter extends BaseAdapter{
  async #load(params:Record<string,string|number|undefined>):Promise<CmsJsonPayload>{return this.broker.json<CmsJsonPayload>({sourceId:this.sourceId(),url:buildUrl(this.endpoint,params),retries:1});}
  async getHome():Promise<HomeResult>{
    const payload=await this.#load({ac:'detail'});
    let categories=parseCmsCategories(payload),filters=parseCmsFilters(payload);
    if(categories.length===0){
      for(const params of [{ac:'list'} as Record<string,string|number|undefined>,{}]){
        try{
          const metadata=await this.#load(params);
          if(categories.length===0)categories=parseCmsCategories(metadata);
          if(Object.keys(filters).length===0)filters=parseCmsFilters(metadata);
          if(categories.length>0)break;
        }catch{/* metadata endpoints vary; keep the valid home payload */}
      }
    }
    return{items:parseCmsJson(payload),...(categories.length?{categories}:{}),...(Object.keys(filters).length?{filters}:{})};
  }
  async getCategory(categoryId:string,page:number,filters:Record<string,string>={}):Promise<CategoryResult>{
    const payload=await this.#load(categoryParams(categoryId,page,filters));
    const items=parseCmsJson(payload),pagination=jsonPagination(payload,page,items.length);
    return{page,hasMore:pagination.hasMore,totalPages:pagination.totalPages,...(pagination.totalItems?{totalItems:pagination.totalItems}:{}),items};
  }
  async search(keyword:string,page=1):Promise<SearchResult>{return{page,items:parseCmsJson(await this.#load({ac:'detail',wd:keyword,pg:page}))};}
  async getDetail(ids:string[]):Promise<DetailResult>{const item=jsonList(await this.#load({ac:'detail',ids:ids.join(',')}))[0];if(!item)throw new Error('CMS JSON detail returned no video');return jsonDetail(item);}
}

export class CmsXmlAdapter extends BaseAdapter{
  async #load(params:Record<string,string|number|undefined>):Promise<string>{return this.broker.text({sourceId:this.sourceId(),url:buildUrl(this.endpoint,params),retries:1});}
  async getHome():Promise<HomeResult>{
    const xml=await this.#load({ac:'videolist'});
    let categories=parseCmsXmlCategories(xml);
    if(categories.length===0){
      for(const params of [{ac:'list'} as Record<string,string|number|undefined>,{}]){
        try{categories=parseCmsXmlCategories(await this.#load(params));if(categories.length)break;}catch{/* metadata endpoints vary */}
      }
    }
    return{items:parseCmsXml(xml),...(categories.length?{categories}:{})};
  }
  async getCategory(categoryId:string,page:number,filters:Record<string,string>={}):Promise<CategoryResult>{
    const xml=await this.#load({...filters,ac:'videolist',t:categoryId,pg:page,...(Object.keys(filters).length?{f:JSON.stringify(filters)}:{})});
    const items=parseCmsXml(xml),pagination=xmlPagination(xml,page,items.length);
    return{page,hasMore:pagination.hasMore,totalPages:pagination.totalPages,...(pagination.totalItems?{totalItems:pagination.totalItems}:{}),items};
  }
  async search(keyword:string,page=1):Promise<SearchResult>{return{page,items:parseCmsXml(await this.#load({ac:'videolist',wd:keyword,pg:page}))};}
  async getDetail(ids:string[]):Promise<DetailResult>{const block=videoBlocks(await this.#load({ac:'videolist',ids:ids.join(',')}))[0];if(!block)throw new Error('CMS XML detail returned no video');return xmlDetail(block);}
}

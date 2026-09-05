import type { DetailResult,Episode,SourceCategory,SourceFilter,VideoCard } from '@free-new-desk/contracts';

export type JsonRecord=Record<string,unknown>;
export interface CmsJsonPayload{
  list?:JsonRecord[];
  class?:unknown;
  filter?:Record<string,unknown>;
  filters?:Record<string,unknown>;
  data?:{list?:JsonRecord[];content?:JsonRecord[];raw_url?:string;class?:unknown;filter?:Record<string,unknown>;filters?:Record<string,unknown>};
  page?:number|string;
  pagecount?:number|string;
  total?:number|string;
  recordcount?:number|string;
  limit?:number|string;
  pagesize?:number|string;
  page_size?:number|string;
  pageSize?:number|string;
}
export const stringValue=(value:unknown):string=>typeof value==='string'||typeof value==='number'?String(value).trim():'';
export const numberValue=(value:unknown,fallback:number):number=>{const parsed=Number(value);return Number.isFinite(parsed)?parsed:fallback;};
export function buildUrl(endpoint:string,params:Record<string,string|number|undefined>):string{const url=new URL(endpoint);for(const[key,value]of Object.entries(params))if(value!==undefined&&value!=='')url.searchParams.set(key,String(value));return url.toString();}
export function jsonList(payload:CmsJsonPayload):JsonRecord[]{return payload.list??payload.data?.list??payload.data?.content??[];}
export function parseCmsJson(payload:CmsJsonPayload):VideoCard[]{return jsonList(payload).map(item=>({id:stringValue(item.vod_id??item.id??item.path),name:stringValue(item.vod_name??item.name),...(stringValue(item.vod_pic??item.pic??item.thumb)?{poster:stringValue(item.vod_pic??item.pic??item.thumb)}:{}),...(stringValue(item.vod_remarks??item.remarks??item.type)?{remark:stringValue(item.vod_remarks??item.remarks??item.type)}:{}),...(stringValue(item.vod_score??item.score??item.rating)?{rating:stringValue(item.vod_score??item.score??item.rating)}:{})})).filter(item=>item.id&&item.name);}

function categoryRecords(value:unknown):JsonRecord[]{
  if(Array.isArray(value))return value.filter((item):item is JsonRecord=>Boolean(item)&&typeof item==='object'&&!Array.isArray(item));
  if(!value||typeof value!=='object')return[];
  return Object.entries(value as Record<string,unknown>).map(([id,item])=>{
    if(item&&typeof item==='object'&&!Array.isArray(item))return{id,...item as JsonRecord};
    return{id,name:item};
  });
}
export function parseCmsCategories(payload:CmsJsonPayload):SourceCategory[]{
  const rows=categoryRecords(payload.class??payload.data?.class);
  const seen=new Set<string>();
  const output:SourceCategory[]=[];
  for(const row of rows){const id=stringValue(row.type_id??row.id??row.tid),name=stringValue(row.type_name??row.name??row.title);if(!id||!name||seen.has(id))continue;seen.add(id);output.push({id,name});}
  return output;
}
function recordArray(value:unknown):JsonRecord[]{return Array.isArray(value)?value.filter((item):item is JsonRecord=>Boolean(item)&&typeof item==='object'&&!Array.isArray(item)):[];}
export function parseCmsFilters(payload:CmsJsonPayload):Record<string,SourceFilter[]>{
  const root=payload.filters??payload.filter??payload.data?.filters??payload.data?.filter;
  if(!root||typeof root!=='object'||Array.isArray(root))return{};
  const output:Record<string,SourceFilter[]>={};
  for(const[categoryId,raw]of Object.entries(root)){
    const filters:SourceFilter[]=[];
    for(const item of recordArray(raw)){
      const key=stringValue(item.key??item.id??item.field),name=stringValue(item.name??item.title??key);
      if(!key)continue;
      const options=recordArray(item.value??item.values??item.options).map(option=>{const value=stringValue(option.v??option.value??option.id),label=stringValue(option.n??option.name??option.label??value);return{label,value};}).filter(option=>option.value);
      if(options.length)filters.push({key,name:name||key,options});
    }
    if(filters.length)output[categoryId]=filters;
  }
  return output;
}

export function decodeXml(value:string):string{return value.replace(/^<!\[CDATA\[/,'').replace(/\]\]>$/,'').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").trim();}
export function extractTag(block:string,tag:string):string{return decodeXml(block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`,'i'))?.[1]??'');}
export function videoBlocks(xml:string):string[]{return[...xml.matchAll(/<video[^>]*>([\s\S]*?)<\/video>/gi)].map(match=>match[1]??'');}
export function parseCmsXml(xml:string):VideoCard[]{return videoBlocks(xml).map(block=>{const id=extractTag(block,'id')||extractTag(block,'vod_id');const name=extractTag(block,'name')||extractTag(block,'vod_name');const poster=extractTag(block,'pic')||extractTag(block,'vod_pic');const remark=extractTag(block,'note')||extractTag(block,'vod_remarks');const rating=extractTag(block,'score')||extractTag(block,'vod_score');return{id,name,...(poster?{poster}:{}),...(remark?{remark}:{}),...(rating?{rating}:{})};}).filter(item=>item.id&&item.name);}
export function parseCmsXmlCategories(xml:string):SourceCategory[]{
  const classBlock=xml.match(/<class\b[^>]*>([\s\S]*?)<\/class>/i)?.[1]??'';
  if(!classBlock)return[];
  const seen=new Set<string>();
  const output:SourceCategory[]=[];
  for(const match of classBlock.matchAll(/<ty\b([^>]*)>([\s\S]*?)<\/ty>/gi)){
    const attrs=match[1]??'';const id=attrs.match(/(?:id|type_id)=["']([^"']+)["']/i)?.[1]?.trim()??'';const name=decodeXml(match[2]??'');
    if(!id||!name||seen.has(id))continue;seen.add(id);output.push({id,name});
  }
  return output;
}

export function parseEpisodeLines(flagsRaw:string,urlsRaw:string):Episode[]{const flags=flagsRaw.split('$$$'),lines=urlsRaw.split('$$$'),episodes:Episode[]=[];for(let index=0;index<lines.length;index+=1){const line=lines[index]?.trim();if(!line)continue;const flag=flags[index]?.trim()||`线路${index+1}`;for(const entry of line.split('#')){const trimmed=entry.trim();if(!trimmed)continue;const split=trimmed.indexOf('$');const name=split>=0?trimmed.slice(0,split).trim():`播放 ${episodes.length+1}`;const id=split>=0?trimmed.slice(split+1).trim():trimmed;if(id)episodes.push({flag,id,name:name||`播放 ${episodes.length+1}`});}}return episodes;}
function people(value:string):string[]{return value.split(/[,，/|]/).map(item=>item.trim()).filter(Boolean).slice(0,24);}
export function jsonDetail(item:JsonRecord):DetailResult{const id=stringValue(item.vod_id??item.id??item.path),name=stringValue(item.vod_name??item.name),poster=stringValue(item.vod_pic??item.pic??item.thumb),remark=stringValue(item.vod_remarks??item.remarks??item.type),description=stringValue(item.vod_content??item.content??item.vod_blurb),rating=stringValue(item.vod_score??item.score??item.rating),year=stringValue(item.vod_year??item.year),area=stringValue(item.vod_area??item.area),type=stringValue(item.type_name??item.vod_class??item.type),director=stringValue(item.vod_director??item.director),actors=people(stringValue(item.vod_actor??item.actor??item.actors)),episodes=parseEpisodeLines(stringValue(item.vod_play_from??item.play_from),stringValue(item.vod_play_url??item.play_url));return{id,name,episodes,...(poster?{poster}:{}),...(remark?{remark}:{}),...(description?{description}:{}),...(rating?{rating}:{}),...(year?{year}:{}),...(area?{area}:{}),...(type?{type}:{}),...(director?{director}:{}),...(actors.length?{actors}:{})};}
export function xmlDetail(block:string):DetailResult{const id=extractTag(block,'id')||extractTag(block,'vod_id'),name=extractTag(block,'name')||extractTag(block,'vod_name'),poster=extractTag(block,'pic')||extractTag(block,'vod_pic'),remark=extractTag(block,'note')||extractTag(block,'vod_remarks'),description=extractTag(block,'des')||extractTag(block,'vod_content'),rating=extractTag(block,'score')||extractTag(block,'vod_score'),year=extractTag(block,'year')||extractTag(block,'vod_year'),area=extractTag(block,'area')||extractTag(block,'vod_area'),type=extractTag(block,'type')||extractTag(block,'vod_class'),director=extractTag(block,'director')||extractTag(block,'vod_director'),actor=extractTag(block,'actor')||extractTag(block,'vod_actor'),actors=people(actor),episodes:Episode[]=[];for(const match of block.matchAll(/<dd\b([^>]*)>([\s\S]*?)<\/dd>/gi)){const attrs=match[1]??'';episodes.push(...parseEpisodeLines(attrs.match(/flag=["']([^"']+)["']/i)?.[1]?.trim()||`线路${episodes.length+1}`,decodeXml(match[2]??'')));}return{id,name,episodes,...(poster?{poster}:{}),...(remark?{remark}:{}),...(description?{description}:{}),...(rating?{rating}:{}),...(year?{year}:{}),...(area?{area}:{}),...(type?{type}:{}),...(director?{director}:{}),...(actors.length?{actors}:{})};}
export function pathValue(value:unknown,path:string):unknown{let current=value;for(const segment of path.split('.').filter(Boolean)){if(Array.isArray(current)){const index=Number(segment);current=Number.isInteger(index)?current[index]:undefined;}else if(current&&typeof current==='object')current=(current as JsonRecord)[segment];else return undefined;}return current;}
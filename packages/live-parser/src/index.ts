import { createHash } from 'node:crypto';
import type { LiveChannel,LiveGroup } from '@free-new-desk/contracts';

const protocol=/^(?:https?|rtmp|rtsp|udp):/i;
const idFor=(value:string)=>createHash('sha1').update(value).digest('hex').slice(0,20);
const attrs=(line:string):Record<string,string>=>{const out:Record<string,string>={};for(const match of line.matchAll(/([\w-]+)="([^"]*)"/g))out[match[1]??'']=match[2]??'';return out;};

function canonicalHeaderName(value:string):string{
  const lower=value.trim().toLowerCase().replace(/_/g,'-');
  if(lower==='user-agent'||lower==='useragent'||lower==='ua')return'User-Agent';
  if(lower==='referer'||lower==='referrer'||lower==='http-referer'||lower==='http-referrer')return'Referer';
  if(lower==='origin')return'Origin';
  if(lower==='cookie')return'Cookie';
  return value.trim();
}

function headerRecord(value:unknown):Record<string,string>{
  if(!value||typeof value!=='object'||Array.isArray(value))return{};
  const out:Record<string,string>={};
  for(const[key,item]of Object.entries(value as Record<string,unknown>))if(typeof item==='string'||typeof item==='number')out[canonicalHeaderName(key)]=String(item);
  return out;
}

function parseRoute(raw:string):{url:string;headers:Record<string,string>}{
  const value=raw.trim();
  const pipe=value.indexOf('|');
  if(pipe<0)return{url:value,headers:{}};
  const url=value.slice(0,pipe).trim();
  const suffix=value.slice(pipe+1).trim();
  const headers:Record<string,string>={};
  for(const pair of suffix.split('&')){
    const equal=pair.indexOf('=');
    if(equal<=0)continue;
    const rawKey=pair.slice(0,equal).trim();
    const rawValue=pair.slice(equal+1).trim();
    try{headers[canonicalHeaderName(decodeURIComponent(rawKey))]=decodeURIComponent(rawValue.replace(/\+/g,'%20'));}
    catch{headers[canonicalHeaderName(rawKey)]=rawValue;}
  }
  return{url,headers};
}

function expandRoutes(raw:string):Array<{url:string;headers:Record<string,string>}>{
  const value=raw.trim();
  const parts=value.split('#').map(item=>item.trim()).filter(Boolean);
  const routeParts=parts.length>1&&parts.every(item=>protocol.test(item.split('|',1)[0]??''))?parts:value?[value]:[];
  return routeParts.map(parseRoute).filter(route=>protocol.test(route.url));
}

function mergeChannels(channels:LiveChannel[]):LiveChannel[]{
  const map=new Map<string,LiveChannel>();
  for(const channel of channels){
    const key=channel.tvgId?`id:${channel.tvgId}`:`name:${channel.group}\u0000${channel.name}`;
    const existing=map.get(key);
    if(!existing){
      const urls=[...new Set([channel.url,...(channel.urls??[])])];
      map.set(key,{...channel,id:idFor(key),url:urls[0]??channel.url,...(urls.length>1?{urls}:{}),...(channel.headers&&Object.keys(channel.headers).length?{headers:channel.headers}:{})});
      continue;
    }
    const urls=[...new Set([existing.url,...(existing.urls??[]),channel.url,...(channel.urls??[])])];
    const headers={...(existing.headers??{}),...(channel.headers??{})};
    map.set(key,{...existing,url:urls[0]??existing.url,...(urls.length>1?{urls}:{}),...(Object.keys(headers).length?{headers}:{}),...(existing.logo?{}:channel.logo?{logo:channel.logo}:{}),...(existing.tvgId?{}:channel.tvgId?{tvgId:channel.tvgId}:{})});
  }
  return[...map.values()];
}

function groupChannels(channels:LiveChannel[]):LiveGroup[]{
  const map=new Map<string,LiveChannel[]>();
  for(const channel of mergeChannels(channels)){const items=map.get(channel.group)??[];items.push(channel);map.set(channel.group,items);}
  return[...map].map(([name,items])=>({name,channels:items}));
}

function addChannel(channels:LiveChannel[],name:string,rawUrls:string[],group:string,meta:Record<string,string>={},extraHeaders:Record<string,string>={}):void{
  const routes=rawUrls.flatMap(expandRoutes);
  const urls=[...new Set(routes.map(route=>route.url))];
  if(!name||urls.length===0)return;
  const headers={...extraHeaders};
  for(const route of routes)Object.assign(headers,route.headers);
  channels.push({id:idFor(`${group}\u0000${name}\u0000${urls[0]}`),name,url:urls[0] as string,...(urls.length>1?{urls}:{}),group,...(Object.keys(headers).length?{headers}:{}),...(meta.logo?{logo:meta.logo}:{}),...(meta.tvgId?{tvgId:meta.tvgId}:{})});
}

export function parseM3U(input:string):LiveGroup[]{
  const lines=input.replace(/^\uFEFF/,'').split(/\r?\n/);
  const channels:LiveChannel[]=[];
  let meta:Record<string,string>={};
  let headers:Record<string,string>={};
  let title='';
  for(const raw of lines){
    const line=raw.trim();
    if(!line)continue;
    if(line.startsWith('#EXTINF:')){meta=attrs(line);title=(line.match(/,([^,]*)$/)?.[1]??'').trim();continue;}
    const vlc=line.match(/^#EXTVLCOPT:http-(user-agent|referr?er)=(.*)$/i);
    if(vlc){headers[vlc[1]?.toLowerCase()==='user-agent'?'User-Agent':'Referer']=vlc[2]?.trim()??'';continue;}
    const extHttp=line.match(/^#EXTHTTP:\s*(\{.*\})$/i);
    if(extHttp){try{Object.assign(headers,headerRecord(JSON.parse(extHttp[1]??'{}')));}catch{/* malformed optional header hint */}continue;}
    if(line.startsWith('#'))continue;
    if(protocol.test(line)){
      const name=title||meta['tvg-name']||`频道 ${channels.length+1}`;
      addChannel(channels,name,[line],meta['group-title']||'未分组',{...(meta['tvg-logo']?{logo:meta['tvg-logo']}:{}),...(meta['tvg-id']?{tvgId:meta['tvg-id']}:{})},headers);
      meta={};headers={};title='';
    }
  }
  return groupChannels(channels);
}

export function parseTxt(input:string):LiveGroup[]{
  const channels:LiveChannel[]=[];
  let group='未分组';
  for(const raw of input.replace(/^\uFEFF/,'').split(/\r?\n/)){
    const line=raw.trim();
    if(!line||line.startsWith('#'))continue;
    if(/,#genre#$/i.test(line)){group=line.replace(/,#genre#$/i,'').trim()||'未分组';continue;}
    const comma=line.indexOf(',');
    if(comma<=0)continue;
    const name=line.slice(0,comma).trim();
    const rawUrl=line.slice(comma+1).trim();
    addChannel(channels,name,[rawUrl],group);
  }
  return groupChannels(channels);
}

export function parseJson(input:string):LiveGroup[]{
  const value=JSON.parse(input) as unknown;
  const channels:LiveChannel[]=[];
  const add=(item:unknown,group='未分组')=>{
    if(!item||typeof item!=='object')return;
    const row=item as Record<string,unknown>;
    const name=String(row.name??row.title??'').trim();
    const rawUrls=[...(Array.isArray(row.urls)?row.urls.filter((item):item is string=>typeof item==='string'):[]),...(typeof row.url==='string'?[row.url]:typeof row.playUrl==='string'?[row.playUrl]:[])];
    const headers={...headerRecord(row.header??row.headers)};
    const userAgent=typeof row.ua==='string'?row.ua:typeof row.userAgent==='string'?row.userAgent:'';
    const referer=typeof row.referer==='string'?row.referer:typeof row.referrer==='string'?row.referrer:'';
    if(userAgent)headers['User-Agent']=userAgent;
    if(referer)headers.Referer=referer;
    addChannel(channels,name,rawUrls,String(row.group??group),{...(typeof row.logo==='string'?{logo:row.logo}:{}),...(typeof row.tvgId==='string'?{tvgId:row.tvgId}:{})},headers);
  };
  if(Array.isArray(value))for(const item of value)add(item);
  else if(value&&typeof value==='object'){
    const root=value as Record<string,unknown>;
    if(Array.isArray(root.groups))for(const group of root.groups){if(!group||typeof group!=='object')continue;const g=group as Record<string,unknown>;const name=String(g.name??'未分组');if(Array.isArray(g.channels))for(const item of g.channels)add(item,name);}
    else if(Array.isArray(root.channels))for(const item of root.channels)add(item);
  }
  return groupChannels(channels);
}

export function parseLivePlaylist(input:string):LiveGroup[]{
  const trimmed=input.trim();
  if(trimmed.startsWith('{')||trimmed.startsWith('['))return parseJson(trimmed);
  if(/^#EXTM3U/i.test(trimmed)||/#EXTINF:/i.test(trimmed))return parseM3U(trimmed);
  return parseTxt(trimmed);
}

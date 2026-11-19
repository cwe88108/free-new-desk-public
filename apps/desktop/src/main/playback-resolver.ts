import type {PlaybackDescriptorV2,PlayResult,SourceKind} from '@free-new-desk/contracts';
import { mergeHeaders,RequestBroker,stripSensitiveRedirectHeaders,type BrokerRequest } from '@free-new-desk/source-sdk';
import type { SniffingService } from './sniffing-service.js';
const MEDIA_URL=/\.(?:m3u8|mp4|m4v|flv|mpd|ts|mkv|webm|aac|m4a)(?:[?#]|$)/i;
const MANIFEST_URL=/\.(?:m3u8|mpd)(?:[?#]|$)/i;
const DIRECT_PROTOCOL=/^(?:rtmp|rtsp|udp):/i;
const PROVIDER_FLAG=/^(?:qq|qiyi|iqiyi|youku|mgtv|bilibili|pptv|sohu)$/i;
const MEDIA_TYPE=/^(?:video\/|audio\/|application\/(?:vnd\.apple\.mpegurl|x-mpegurl|dash\+xml))/i;
const NON_MEDIA_TYPE=/^(?:text\/html|application\/(?:json|problem\+json)|text\/(?:plain|json))/i;
const GENERIC_BINARY_TYPE=/^application\/octet-stream(?:\s*;|$)/i;
export type PlaybackMode='direct'|'sniff'|'parser';
export interface PlaybackResolution{url:string;headers:Record<string,string>;mode:PlaybackMode;contentType?:string|undefined;httpStatus?:number|undefined;inputHost?:string|undefined;finalHost?:string|undefined;fallbackAttempted:boolean;}
export interface PlaybackResolveInput{sourceId:string;sourceKind:SourceKind;flag:string;resolved:PlayResult;sourceHeaders?:Record<string,string>|undefined;playUrl?:string|undefined;playerType?:number|undefined;forceSniff?:boolean|undefined;signal?:AbortSignal|undefined;}
export function isLikelyMediaUrl(value:string):boolean{return MEDIA_URL.test(value);}
export function isMediaContentType(value:string):boolean{return MEDIA_TYPE.test(value.trim());}
export function isClearlyNonMediaContentType(value:string):boolean{return NON_MEDIA_TYPE.test(value.trim());}
export function shouldRetryPlayerFailure(detail:string|undefined):boolean{return /(?:unrecognized file format|mpv\s*-17|\(-17\))/i.test(detail??'');}
function host(value:string):string|undefined{try{return new URL(value).host;}catch{return undefined;}}
function parserTarget(playUrl:string,inputUrl:string):string{const raw=playUrl.trim();if(raw.includes('{url}'))return raw.replaceAll('{url}',encodeURIComponent(inputUrl));return raw+encodeURIComponent(inputUrl);}
function validateMediaUrl(value:string):void{
  let url:URL;try{url=new URL(value);}catch{throw new Error('[PLAY_DIRECT_INVALID] 播放目标不是有效的 HTTP(S) 地址');}
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new Error('[PLAY_DIRECT_INVALID] 播放目标必须是无内嵌凭据的 HTTP(S) 地址');
}
function scopedHeaders(headers:Record<string,string>,from:string,to:string):Record<string,string>{
  const scoped=new Headers(headers);stripSensitiveRedirectHeaders(scoped,from,to);return Object.fromEntries(scoped.entries());
}
export class PlaybackResolver{constructor(private readonly broker:RequestBroker,private readonly sniffing:SniffingService){}
  // Keep stripping across every redirect, including A → B → A and HEAD → GET fallback.
  async #request(request:BrokerRequest,headers:Record<string,string>):Promise<Response>{
    let previous=request.url;
    return this.broker.request({...request,headers:mergeHeaders(headers,request.headers),allowSensitiveDefaults:false,validateUrl:url=>{
      validateMediaUrl(url);const scoped=scopedHeaders(headers,previous,url);
      for(const key of Object.keys(headers))delete headers[key];Object.assign(headers,scoped);previous=url;request.validateUrl?.(url);
    }});
  }
  async #manifestLooksValid(sourceId:string,url:string,headers:Record<string,string>,signal?:AbortSignal):Promise<boolean>{if(!MANIFEST_URL.test(url))return false;const response=await this.#request({sourceId,url,timeoutMs:7_000,retries:0,...(signal?{signal}:{}),maxBytes:256*1024},headers);if(!response.ok){await response.body?.cancel();return false;}const text=await response.text();return /\.m3u8(?:[?#]|$)/i.test(url)?/^\s*#EXTM3U/m.test(text):/<MPD(?:\s|>)/i.test(text);}
  async #probe(sourceId:string,url:string,headers:Record<string,string>,signal?:AbortSignal):Promise<{url:string;status:number;contentType:string}>{
    let response:Response|undefined;
    let fallbackUrl=url;
    try{
      response=await this.#request({sourceId,url,method:'HEAD',validateUrl:next=>{fallbackUrl=next;},timeoutMs:6_000,retries:0,...(signal?{signal}:{})},headers);
      fallbackUrl=response.url||url;
      if(!response.ok||!response.headers.get('content-type')){
        await response.body?.cancel();
        response=undefined;
      }
    }catch(error){
      if(signal?.aborted)throw error;
    }
    if(!response){
      // Some CDNs ignore Range and advertise the full file. This probe cancels the body without reading it.
      response=await this.#request({sourceId,url:fallbackUrl,headers:{Range:'bytes=0-65535'},timeoutMs:7_000,retries:0,...(signal?{signal}:{})},headers);
    }
    const result={url:response.url||url,status:response.status,contentType:response.headers.get('content-type')??''};
    await response.body?.cancel();
    return result;
  }
  async #sniff(input:PlaybackResolveInput,url:string,headers:Record<string,string>,mode:PlaybackMode):Promise<PlaybackResolution>{validateMediaUrl(url);const found=await this.sniffing.resolve(input.sourceId,url,headers,12_000,input.signal);validateMediaUrl(found.url);const candidateHeaders=mergeHeaders(scopedHeaders(headers,url,found.url),found.headers);const verified=await this.#probe(input.sourceId,found.url,candidateHeaders,input.signal);const manifestText=verified.contentType.trim().toLowerCase().startsWith('text/plain')&&MANIFEST_URL.test(verified.url)?await this.#manifestLooksValid(input.sourceId,verified.url,candidateHeaders,input.signal):false;if(verified.status<200||verified.status>=400)throw new Error(`[PLAY_SNIFF_HTTP_REJECTED] 嗅探候选 HTTP ${verified.status}`);if(isClearlyNonMediaContentType(verified.contentType)&&!manifestText)throw new Error(`[PLAY_SNIFF_NON_MEDIA_RESPONSE] 嗅探候选返回 ${verified.contentType||'未知类型'}`);return{url:verified.url,headers:candidateHeaders,mode,contentType:verified.contentType,httpStatus:verified.status,inputHost:host(input.resolved.url),finalHost:host(verified.url),fallbackAttempted:Boolean(input.forceSniff)};}
  async #playUrl(input:PlaybackResolveInput,headers:Record<string,string>):Promise<PlaybackResolution|null>{
    const playUrl=input.playUrl?.trim();if(!playUrl)return null;
    if(/^json:/i.test(playUrl)){
      const endpoint=parserTarget(playUrl.slice(5),input.resolved.url);validateMediaUrl(endpoint);
      const parserHeaders=scopedHeaders(headers,input.resolved.url,endpoint);
      const response=await this.#request({sourceId:input.sourceId,url:endpoint,timeoutMs:10_000,retries:0,...(input.signal?{signal:input.signal}:{}),maxBytes:1024*1024},parserHeaders);
      const body=await response.text();if(!response.ok)throw new Error(`[PLAY_PARSER_FAILED] Parser HTTP ${response.status}`);
      let json:Record<string,unknown>;try{json=JSON.parse(body) as Record<string,unknown>;}catch{throw new Error('[PLAY_PARSER_FAILED] JSON parser did not return a media URL');}
      const url=typeof json?.url==='string'?json.url.trim():'';validateMediaUrl(url);
      const extra=json.header??json.headers??{};
      if(!extra||typeof extra!=='object'||Array.isArray(extra)||Object.values(extra).some(value=>typeof value!=='string'))throw new Error('[PLAY_PARSER_FAILED] Invalid parser headers');
      const candidateHeaders=mergeHeaders(scopedHeaders(parserHeaders,response.url||endpoint,url),extra as Record<string,string>);
      const verified=await this.#probe(input.sourceId,url,candidateHeaders,input.signal);
      const manifestText=verified.contentType.trim().toLowerCase().startsWith('text/plain')&&MANIFEST_URL.test(verified.url)?await this.#manifestLooksValid(input.sourceId,verified.url,candidateHeaders,input.signal):false;
      if(verified.status<200||verified.status>=400||isClearlyNonMediaContentType(verified.contentType)&&!manifestText)throw new Error('[PLAY_PARSER_FAILED] Parser target is not a successful media response');
      return{url:verified.url,headers:candidateHeaders,mode:'parser',contentType:verified.contentType,httpStatus:verified.status,inputHost:host(input.resolved.url),finalHost:host(verified.url),fallbackAttempted:Boolean(input.forceSniff)};
    }
    if(/^https?:\/\//i.test(playUrl)){const endpoint=parserTarget(playUrl,input.resolved.url);validateMediaUrl(endpoint);return this.#sniff(input,endpoint,scopedHeaders(headers,input.resolved.url,endpoint),'parser');}
    return null;
  }
  async resolve(input:PlaybackResolveInput):Promise<PlaybackResolution>{const url=input.resolved.url.trim();if(!url)throw new Error('[PLAY_DIRECT_INVALID] 播放地址为空');const headers=mergeHeaders(input.sourceHeaders,input.resolved.headers,input.resolved.userAgent?{'User-Agent':input.resolved.userAgent}:undefined,input.resolved.referer?{Referer:input.resolved.referer}:undefined);if(DIRECT_PROTOCOL.test(url))return{url,headers,mode:'direct',inputHost:host(url),finalHost:host(url),fallbackAttempted:Boolean(input.forceSniff)};if(!/^https?:\/\//i.test(url))throw new Error('[PLAY_PARSER_FAILED] 来源返回了无法直接解析的非 HTTP 播放标识');validateMediaUrl(url);if(!input.forceSniff&&input.playUrl){const parsed=await this.#playUrl(input,headers);if(parsed)return parsed;}let probe:{url:string;status:number;contentType:string}|undefined;try{probe=await this.#probe(input.sourceId,url,headers,input.signal);}catch(error){if(input.signal?.aborted)throw error;/* inaccessible probe still may work in browser sniff */}if(!input.forceSniff&&probe?.status&&probe.status>=200&&probe.status<400){const manifestText=probe.contentType.trim().toLowerCase().startsWith('text/plain')&&MANIFEST_URL.test(probe.url)?await this.#manifestLooksValid(input.sourceId,probe.url,headers,input.signal):false;if(isMediaContentType(probe.contentType)||manifestText||(isLikelyMediaUrl(probe.url)&&(!probe.contentType||GENERIC_BINARY_TYPE.test(probe.contentType))))return{url:probe.url,headers,mode:'direct',contentType:probe.contentType,httpStatus:probe.status,inputHost:host(url),finalHost:host(probe.url),fallbackAttempted:false};}const shouldSniff=Boolean(input.forceSniff||input.resolved.parse||PROVIDER_FLAG.test(input.flag)||isClearlyNonMediaContentType(probe?.contentType??'')||!probe?.contentType||input.playerType!==undefined);if(shouldSniff)return this.#sniff(input,probe?.url??url,headers,input.playUrl?'parser':'sniff');return this.#sniff(input,probe?.url??url,headers,'sniff');}
}

export interface PlaybackDescriptorProjection{resolved:PlayResult;playUrl?:string;candidateId:string;}
export function projectPlaybackDescriptorV2(descriptor:PlaybackDescriptorV2):PlaybackDescriptorProjection{
  if(descriptor.schemaVersion!==2)throw new Error('[PLAY_V2_SCHEMA_UNSUPPORTED] 不支持的播放描述版本');
  if(descriptor.drmStatus==='declared-unsupported')throw new Error('[PLAY_DRM_UNSUPPORTED] 当前播放内核不支持此 DRM 媒体');
  const candidate=descriptor.candidates.find(item=>item.target.kind==='media'||item.target.kind==='web-page'||item.target.kind==='parser-input');
  if(!candidate){const kind=descriptor.candidates[0]?.target.kind??'missing';throw new Error(`[PLAY_V2_RUNTIME_TARGET_UNSUPPORTED] 当前桌面播放器尚不能直接消费 ${kind} 目标`);}
  let url:string,parse:boolean;
  if(candidate.target.kind==='media'){url=candidate.target.url;parse=descriptor.resolutionIntent!=='direct';}
  else if(candidate.target.kind==='web-page'){url=candidate.target.url;parse=true;}
  else if(candidate.target.kind==='parser-input'){url=candidate.target.value;parse=true;}else throw new Error('[PLAY_V2_RUNTIME_TARGET_UNSUPPORTED] 当前桌面播放器不能消费不透明运行时目标');
  const subtitles=descriptor.subtitles?.map(item=>({url:item.url,...(item.name?{name:item.name}:{})}));
  const resolved:PlayResult={url,parse,...(candidate.headers?{headers:candidate.headers}:{}),...(subtitles?.length?{subtitles}:{})};
  const playUrl=typeof descriptor.rawHints.playUrl==='string'&&descriptor.rawHints.playUrl.trim()?descriptor.rawHints.playUrl.trim():undefined;
  return{resolved,...(playUrl?{playUrl}:{}),candidateId:candidate.id};
}

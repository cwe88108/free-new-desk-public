import {managedResponse} from './managed-response.js';
import {RequestContextStore,stripSensitiveRedirectHeaders,type RequestContextSpec} from './request-context-store.js';

export interface BrokerRequest{
  sourceId:string;url:string;method?:string;headers?:Record<string,string>;body?:string;
  timeoutMs?:number;retries?:number;signal?:AbortSignal;maxBytes?:number;redirect?:RequestRedirect;
  configRevision?:string;accountProfile?:string;contextRef?:string;allowSensitiveDefaults?:boolean;
}
export type RequestOptions=BrokerRequest;
export interface BrokerMetric{ok:boolean;status:number;latencyMs:number;bytes:number;}
export {RequestContextStore} from './request-context-store.js';
export type {RequestContextSpec} from './request-context-store.js';

export function resolveUrl(base:string,value:string):string{return new URL(value,base).toString();}
export function mergeHeaders(...sets:Array<Record<string,string>|undefined>):Record<string,string>{
  const result=new Headers();for(const set of sets)for(const[key,value]of Object.entries(set??{}))result.set(key,value);
  return Object.fromEntries(result.entries());
}
const transportHeaders=new Set(['host','content-length','connection','transfer-encoding','proxy-connection']);
const sensitiveHeaders=new Set(['authorization','cookie','proxy-authorization','origin','referer']);
function requestHeaders(defaults:Record<string,string>,explicit:Record<string,string>|undefined,allowSensitiveDefaults:boolean):Headers{
  const result=new Headers();
  for(const[key,value]of Object.entries(defaults)){const lower=key.toLowerCase();if(transportHeaders.has(lower)||(!allowSensitiveDefaults&&sensitiveHeaders.has(lower)))continue;result.set(key,value);}
  for(const[key,value]of Object.entries(explicit??{})){if(!transportHeaders.has(key.toLowerCase()))result.set(key,value);}
  return result;
}
function linkedSignal(timeoutMs:number,external?:AbortSignal):{signal:AbortSignal;dispose:()=>void}{
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(new DOMException('Request timeout','TimeoutError')),timeoutMs);
  const abort=()=>controller.abort(external?.reason??new DOMException('Aborted','AbortError'));
  if(external?.aborted)abort();else external?.addEventListener('abort',abort,{once:true});
  let disposed=false;return{signal:controller.signal,dispose:()=>{if(disposed)return;disposed=true;clearTimeout(timer);external?.removeEventListener('abort',abort);}};
}
function retryable(error:unknown):boolean{
  if(error instanceof TypeError)return true;
  return error instanceof DOMException&&error.name==='TimeoutError';
}
function wait(ms:number,signal?:AbortSignal):Promise<void>{
  return new Promise((resolve,reject)=>{
    if(signal?.aborted){reject(signal.reason??new DOMException('Aborted','AbortError'));return;}
    const timer=setTimeout(()=>{signal?.removeEventListener('abort',onAbort);resolve();},ms);
    const onAbort=()=>{clearTimeout(timer);signal?.removeEventListener('abort',onAbort);reject(signal?.reason??new DOMException('Aborted','AbortError'));};
    signal?.addEventListener('abort',onAbort,{once:true});
  });
}
const browserUserAgent='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';
const liveCompatibilityUserAgents=['okhttp/3.15','bingcha/1.1 (mianfeifenxiang) ','Goiptv/8.8.8'];
const CONFIG_MAX_BYTES=8*1024*1024;
const LIVE_PROBE_BUDGET_MS=2500;
const LIVE_PROBE_BYTES=64*1024;
const MAX_REDIRECTS=8;
const redirectStatuses=new Set([301,302,303,307,308]);
function hasHeader(headers:Record<string,string>|undefined,name:string):boolean{return Object.keys(headers??{}).some(key=>key.toLowerCase()===name.toLowerCase());}
function withoutHeader(headers:Record<string,string>|undefined,name:string):Record<string,string>|undefined{if(!headers)return undefined;const output=Object.fromEntries(Object.entries(headers).filter(([key])=>key.toLowerCase()!==name.toLowerCase()));return Object.keys(output).length?output:undefined;}
function firstPlaylistUri(text:string):string|undefined{return text.split(/\r?\n/).map(line=>line.trim()).find(line=>Boolean(line)&&!line.startsWith('#'));}
async function decodeText(response:Response):Promise<string>{
  const bytes=await response.arrayBuffer();
  const charset=response.headers.get('content-type')?.match(/charset=([^;\s]+)/i)?.[1]?.replace(/["']/g,'')||'utf-8';
  try{return new TextDecoder(charset).decode(bytes);}catch{return new TextDecoder('utf-8').decode(bytes);}
}
interface FetchResult{response:Response;url:string;redirected:boolean;}

export class RequestBroker{
  readonly #contexts=new RequestContextStore();
  bindContext(sourceId:string,spec:RequestContextSpec={}):string{return this.#contexts.bind(sourceId,spec);}
  setDefaultHeaders(sourceId:string,headers?:Record<string,string>):void{this.#contexts.setDefaultHeaders(sourceId,headers);}
  clearDefaultHeaders(sourceId:string):void{this.#contexts.clearDefaultHeaders(sourceId);}
  clearCookies(sourceId:string):void{this.#contexts.clearSource(sourceId);}
  contextRef(sourceId:string):string{return this.#contexts.activeRef(sourceId);}

  async #fetchAttempt(request:BrokerRequest,signal:AbortSignal,contextRef:string):Promise<FetchResult>{
    let currentUrl=request.url,currentMethod=(request.method??(request.body?'POST':'GET')).toUpperCase(),currentBody=request.body;
    const defaults=this.#contexts.defaultHeadersFor(contextRef);
    const baseHeaders=requestHeaders(defaults,request.headers,request.allowSensitiveDefaults!==false);let redirected=false;
    for(let redirects=0;redirects<=MAX_REDIRECTS;redirects+=1){
      const headers=new Headers(baseHeaders),cookie=await this.#contexts.cookieHeaderFor(contextRef,currentUrl);
      if(cookie&&!headers.has('cookie'))headers.set('cookie',cookie);
      if(!headers.has('user-agent'))headers.set('user-agent',browserUserAgent);
      const response=await fetch(currentUrl,{method:currentMethod,headers,redirect:'manual',signal,...(currentBody!==undefined?{body:currentBody}:{})});
      const responseUrl=response.url||currentUrl;await this.#contexts.captureFor(contextRef,responseUrl,response.headers);
      if(!redirectStatuses.has(response.status))return{response,url:responseUrl,redirected};
      if(request.redirect==='manual')return{response,url:responseUrl,redirected};
      if(request.redirect==='error'){await response.body?.cancel();throw new TypeError('Redirect is not allowed for this request');}
      const location=response.headers.get('location');
      if(!location)return{response,url:responseUrl,redirected};
      if(redirects===MAX_REDIRECTS){await response.body?.cancel();throw new Error('SOURCE_REDIRECT_LIMIT');}
      const nextUrl=new URL(location,currentUrl).toString();
      await response.body?.cancel();stripSensitiveRedirectHeaders(baseHeaders,currentUrl,nextUrl);
      if(response.status===303||((response.status===301||response.status===302)&&currentMethod==='POST')){
        currentMethod='GET';currentBody=undefined;baseHeaders.delete('content-length');baseHeaders.delete('content-type');
      }
      currentUrl=nextUrl;redirected=true;
    }
    throw new Error('SOURCE_REDIRECT_LIMIT');
  }

  async request(request:BrokerRequest):Promise<Response>{
    const contextRef=this.#contexts.resolveRef(request.sourceId,request.contextRef,{
      ...(request.configRevision!==undefined?{configRevision:request.configRevision}:{}),
      ...(request.accountProfile!==undefined?{accountProfile:request.accountProfile}:{})
    });
    const method=(request.method??(request.body?'POST':'GET')).toUpperCase();
    const safeMethod=method==='GET'||method==='HEAD';
    const attempts=Math.max(1,(safeMethod?(request.retries??1):(request.retries??0))+1);let last:unknown;
    for(let attempt=0;attempt<attempts;attempt+=1){
      if(request.signal?.aborted)throw request.signal.reason??new DOMException('Aborted','AbortError');
      const linked=linkedSignal(request.timeoutMs??15_000,request.signal);let handedOff=false;
      try{
        const fetched=await this.#fetchAttempt(request,linked.signal,contextRef),response=fetched.response;
        if(response.status>=500&&attempt+1<attempts){
          await response.body?.cancel();linked.dispose();await wait(150*(attempt+1),request.signal);continue;
        }
        const maxBytes=request.maxBytes??(request.sourceId==='config-import'?CONFIG_MAX_BYTES:undefined);
        handedOff=true;
        return managedResponse(response,{signal:linked.signal,finalize:linked.dispose,...(maxBytes!==undefined?{maxBytes}:{}),url:fetched.url,redirected:fetched.redirected});
      }catch(error){
        last=error;linked.dispose();
        if(request.signal?.aborted)throw request.signal.reason??new DOMException('Aborted','AbortError');
        if(attempt+1>=attempts||!retryable(error))throw error;
        await wait(150*(attempt+1),request.signal);
      }finally{if(!handedOff)linked.dispose();}
    }
    throw last instanceof Error?last:new Error('Request failed');
  }

  async text(request:BrokerRequest):Promise<string>{
    let response=await this.request(request);if(response.ok)return decodeText(response);
    const canTryLiveUa=request.sourceId.startsWith('live:')&&!hasHeader(request.headers,'User-Agent')&&(response.status===401||response.status===403);
    if(canTryLiveUa){
      await response.body?.cancel();
      for(const userAgent of liveCompatibilityUserAgents){
        response=await this.request({...request,headers:{...(request.headers??{}),'User-Agent':userAgent},retries:0});
        if(response.ok)return decodeText(response);await response.body?.cancel();if(response.status!==401&&response.status!==403)break;
      }
    }
    throw new Error(`HTTP ${response.status} for source request`);
  }
  async json<T>(request:BrokerRequest):Promise<T>{return JSON.parse(await this.text(request)) as T;}
  async jsonPost<T>(request:BrokerRequest,payload:unknown):Promise<T>{
    return this.json<T>({...request,method:'POST',headers:{'content-type':'application/json',...(request.headers??{})},body:JSON.stringify(payload),retries:request.retries??0});
  }
  async #readProbeBytes(response:Response,maxBytes=LIVE_PROBE_BYTES):Promise<number>{
    let bytes=0;if(!response.body)return bytes;const reader=response.body.getReader();
    while(true){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>=maxBytes){await reader.cancel();break;}}
    return bytes;
  }
  async #measureHls(request:BrokerRequest,started:number):Promise<BrokerMetric>{
    const deadline=Date.now()+LIVE_PROBE_BUDGET_MS,remaining=()=>Math.max(100,deadline-Date.now());
    const playlistHeaders=withoutHeader(request.headers,'Range');
    const playlistRequest:BrokerRequest={...request,...(playlistHeaders?{headers:playlistHeaders}:{})};if(!playlistHeaders)delete playlistRequest.headers;playlistRequest.retries=0;
    let response=await this.request({...playlistRequest,timeoutMs:remaining(),maxBytes:512*1024});
    if(!response.ok)return{ok:false,status:response.status,latencyMs:Math.round(performance.now()-started),bytes:0};
    let base=response.url||request.url,text=await response.text(),media=firstPlaylistUri(text);
    if(!media)return{ok:true,status:response.status,latencyMs:Math.round(performance.now()-started),bytes:Buffer.byteLength(text)};
    let mediaUrl=resolveUrl(base,media);
    if(/\.m3u8(?:$|[?#])/i.test(mediaUrl)&&remaining()>150){
      response=await this.request({...playlistRequest,url:mediaUrl,timeoutMs:remaining(),maxBytes:512*1024});
      if(!response.ok)return{ok:false,status:response.status,latencyMs:Math.round(performance.now()-started),bytes:0};
      base=response.url||mediaUrl;text=await response.text();media=firstPlaylistUri(text);
      if(!media)return{ok:true,status:response.status,latencyMs:Math.round(performance.now()-started),bytes:Buffer.byteLength(text)};
      mediaUrl=resolveUrl(base,media);
    }
    response=await this.request({...request,url:mediaUrl,headers:{...(request.headers??{}),Range:`bytes=0-${LIVE_PROBE_BYTES-1}`},timeoutMs:remaining(),retries:0});
    const bytes=await this.#readProbeBytes(response);
    return{ok:response.ok,status:response.status,latencyMs:Math.round(performance.now()-started),bytes};
  }
  async measure(request:BrokerRequest):Promise<BrokerMetric>{
    const started=performance.now();try{
      const liveProbe=request.sourceId==='live-speed';
      if(liveProbe&&/\.m3u8(?:$|[?#])/i.test(request.url))return await this.#measureHls(request,started);
      const timeoutMs=liveProbe?Math.min(request.timeoutMs??LIVE_PROBE_BUDGET_MS,LIVE_PROBE_BUDGET_MS):(request.timeoutMs??8_000);
      const probeRequest:BrokerRequest={...request,timeoutMs,...(liveProbe?{retries:0}:{})};
      const response=await this.request(probeRequest),contentType=(response.headers.get('content-type')??'').toLowerCase();
      if(liveProbe&&(contentType.includes('mpegurl')||contentType.includes('vnd.apple.mpegurl'))){await response.body?.cancel();return this.#measureHls(request,started);}
      const bytes=await this.#readProbeBytes(response,liveProbe?LIVE_PROBE_BYTES:256*1024);
      return{ok:response.ok,status:response.status,latencyMs:Math.round(performance.now()-started),bytes};
    }catch{return{ok:false,status:0,latencyMs:Math.round(performance.now()-started),bytes:0};}
  }
}

export function redactSecrets(headers:Record<string,string>):Record<string,string>{
  const output:Record<string,string>={};for(const[key,value]of Object.entries(headers))output[key]=/cookie|authorization|token|password/i.test(key)?'<redacted>':value;return output;
}

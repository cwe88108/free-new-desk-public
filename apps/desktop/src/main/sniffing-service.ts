import { BrowserWindow } from 'electron';
import { createHash,randomUUID } from 'node:crypto';

const MEDIA_URL=/\.(?:m3u8|mp4|m4v|flv|mpd|ts|mkv|webm|aac|m4a)(?:[?#]|$)/i;
const MEDIA_TYPE=/(?:^|\s)(?:video\/|audio\/|application\/(?:vnd\.apple\.mpegurl|x-mpegurl|dash\+xml|octet-stream))/i;
const NON_MEDIA_TYPE=/(?:^|\s)(?:text\/html|application\/(?:json|problem\+json)|text\/json)/i;
const KEEP_HEADERS=new Set(['user-agent','referer','origin','cookie']);
const REQUEST_FILTER={urls:['http://*/*','https://*/*']};

export interface SniffedMedia{url:string;headers?:Record<string,string>;}

function selectHeaders(input:Record<string,string>):Record<string,string>{
  const output:Record<string,string>={};
  for(const[key,value]of Object.entries(input))if(KEEP_HEADERS.has(key.toLowerCase()))output[key]=value;
  return output;
}

function headerValue(headers:Record<string,string[]|string>|undefined,name:string):string{
  const entry=Object.entries(headers??{}).find(([key])=>key.toLowerCase()===name);
  if(!entry)return'';
  return Array.isArray(entry[1])?entry[1].join(';'):entry[1];
}

function isPlayableResponse(url:string,statusCode:number,responseHeaders:Record<string,string[]|string>|undefined):boolean{
  const contentType=headerValue(responseHeaders,'content-type'),success=statusCode>=200&&statusCode<300;
  if(!success||NON_MEDIA_TYPE.test(contentType))return false;
  return MEDIA_TYPE.test(contentType)||MEDIA_URL.test(url);
}

export class SniffingService {
  async resolve(sourceId:string,pageUrl:string,headers:Record<string,string>={},timeoutMs=12_000,signal?:AbortSignal):Promise<SniffedMedia>{
    const sourceHash=createHash('sha256').update(sourceId).digest('hex').slice(0,12);
    const partition=`sniff_${sourceHash}_${randomUUID()}`;
    const window=new BrowserWindow({show:false,width:800,height:600,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,partition}});
    const session=window.webContents.session;
    return new Promise<SniffedMedia>((resolve,reject)=>{
      let settled=false;
      let timer:ReturnType<typeof setTimeout>|undefined;
      const capturedHeaders=new Map<number,Record<string,string>>();
      const finish=(error:Error|null,value?:SniffedMedia)=>{
        if(settled)return;
        settled=true;
        if(timer)clearTimeout(timer);
        signal?.removeEventListener('abort',abort);
        session.webRequest.onBeforeSendHeaders(REQUEST_FILTER,null);
        session.webRequest.onHeadersReceived(REQUEST_FILTER,null);
        capturedHeaders.clear();
        if(!window.isDestroyed())window.destroy();
        if(error)reject(error);else resolve(value as SniffedMedia);
      };
      const abort=()=>finish(new Error('[PLAY_SNIFF_ABORTED] Media sniffing cancelled'));
      if(signal?.aborted){abort();return;}
      signal?.addEventListener('abort',abort,{once:true});
      timer=setTimeout(()=>finish(new Error('[PLAY_SNIFF_TIMEOUT] Media sniffing timed out')),timeoutMs);
      session.webRequest.onBeforeSendHeaders(REQUEST_FILTER,(details,callback)=>{
        capturedHeaders.set(details.id,selectHeaders(details.requestHeaders as Record<string,string>));
        callback({requestHeaders:details.requestHeaders});
      });
      session.webRequest.onHeadersReceived(REQUEST_FILTER,(details,callback)=>{
        if(!settled&&isPlayableResponse(details.url,details.statusCode,details.responseHeaders as Record<string,string[]|string>|undefined)){
          const captured=capturedHeaders.get(details.id)??{};
          finish(null,{url:details.url,...(Object.keys(captured).length?{headers:captured}:{})});
        }
        capturedHeaders.delete(details.id);
        callback(details.responseHeaders?{responseHeaders:details.responseHeaders}:{});
      });
      window.webContents.once('did-fail-load',(_event,code,description)=>{if(!settled&&code!==-3)finish(new Error(`[PLAY_PARSER_FAILED] Sniff page failed: ${description}`));});
      const extraHeaders=Object.entries(headers).map(([key,value])=>`${key}: ${value}`).join('\n');
      void window.loadURL(pageUrl,extraHeaders?{extraHeaders}:undefined).catch(error=>finish(error instanceof Error?error:new Error(String(error))));
    });
  }
}

import http,{type IncomingMessage,type ServerResponse} from 'node:http';
import {once} from 'node:events';
import {randomBytes} from 'node:crypto';

export interface ProxyDescriptor{baseUrl:string;token:string;}

function mediaPlaylist(type:string,url:string):boolean{return/mpegurl/i.test(type)||/\.m3u8(?:\?|$)/i.test(url);}
const enc=(value:string)=>Buffer.from(value,'utf8').toString('base64url');
const dec=(value:string)=>Buffer.from(value,'base64url').toString('utf8');

function headersFrom(url:URL):Record<string,string>{
  const raw=url.searchParams.get('h');if(!raw)return{};
  try{const value=JSON.parse(dec(raw)) as Record<string,unknown>;return Object.fromEntries(Object.entries(value).filter(([,v])=>typeof v==='string') as Array<[string,string]>);}catch{return{};}
}
function requestHeaders(request:IncomingMessage):Record<string,string>{
  const output:Record<string,string>={};
  for(const name of ['range','if-range','if-none-match','if-modified-since','accept'] as const){const value=request.headers[name];if(typeof value==='string'&&value)output[name]=value;}
  return output;
}
function srtToVtt(value:string):string{return`WEBVTT\n\n${value.replace(/^\uFEFF/,'').replace(/(\d{2}:\d{2}:\d{2}),([0-9]{3})/g,'$1.$2')}`;}
function responseHeaders(upstream:Response,type:string,includeLength=true):Record<string,string>{
  const output:Record<string,string>={'content-type':type,'cache-control':'no-store'};
  for(const name of ['content-range','accept-ranges','etag','last-modified'] as const){const value=upstream.headers.get(name);if(value)output[name]=value;}
  const length=includeLength?upstream.headers.get('content-length'):null;if(length)output['content-length']=length;
  return output;
}
export class ProxyService{
  #server:http.Server|undefined;#token='';#baseUrl='';
  async start():Promise<ProxyDescriptor>{
    if(this.#server)return{baseUrl:this.#baseUrl,token:this.#token};
    this.#token=randomBytes(32).toString('base64url');this.#server=http.createServer((request,response)=>{void this.#handle(request,response);});
    await new Promise<void>((resolve,reject)=>{this.#server?.once('error',reject);this.#server?.listen(0,'127.0.0.1',()=>resolve());});
    const address=this.#server.address();if(!address||typeof address==='string')throw new Error('Proxy failed to bind TCP port');
    this.#baseUrl=`http://127.0.0.1:${address.port}`;return{baseUrl:this.#baseUrl,token:this.#token};
  }
  url(target:string,headers:Record<string,string>={}):string{
    if(!this.#baseUrl)throw new Error('Proxy is not running');const h=Object.keys(headers).length?`&h=${encodeURIComponent(enc(JSON.stringify(headers)))}`:'';
    return`${this.#baseUrl}/proxy?u=${encodeURIComponent(target)}${h}`;
  }
  subtitleUrl(target:string,headers:Record<string,string>={}):string{
    if(!this.#baseUrl)throw new Error('Proxy is not running');const h=Object.keys(headers).length?`&h=${encodeURIComponent(enc(JSON.stringify(headers)))}`:'';
    return`${this.#baseUrl}/subtitle?u=${encodeURIComponent(target)}${h}`;
  }
  stop():Promise<void>{const server=this.#server;this.#server=undefined;this.#baseUrl='';this.#token='';if(!server)return Promise.resolve();return new Promise(resolve=>server.close(()=>resolve()));}
  #rewriteManifest(body:string,target:string,headers:Record<string,string>):string{
    const base=new URL(target);
    return body.split(/\r?\n/).map(line=>{if(!line.trim())return line;if(line.startsWith('#'))return line.replace(/URI="([^"]+)"/g,(_all,uri:string)=>{try{return`URI="${this.url(new URL(uri,base).toString(),headers)}"`;}catch{return`URI="${uri}"`;}});try{return this.url(new URL(line.trim(),base).toString(),headers);}catch{return line;}}).join('\n');
  }
  async #handle(request:IncomingMessage,response:ServerResponse):Promise<void>{
    const method=(request.method??'GET').toUpperCase();
    if(method!=='GET'&&method!=='HEAD'){response.writeHead(405,{allow:'GET, HEAD'});response.end();return;}
    const controller=new AbortController();let completed=false;
    const abort=()=>{if(!completed&&!controller.signal.aborted)controller.abort(new DOMException('Proxy client disconnected','AbortError'));};
    request.once('aborted',abort);response.once('close',()=>{if(!response.writableEnded)abort();});
    try{
      if(request.headers.authorization!==`Bearer ${this.#token}`){response.writeHead(401,{'content-type':'text/plain'});response.end('Unauthorized');return;}
      const incoming=new URL(request.url??'/',this.#baseUrl||'http://127.0.0.1');
      if(incoming.pathname!=='/proxy'&&incoming.pathname!=='/subtitle'){response.writeHead(404);response.end();return;}
      const target=incoming.searchParams.get('u');if(!target||!/^https?:\/\//i.test(target)){response.writeHead(400);response.end('Invalid target');return;}
      const forwarded={...headersFrom(incoming),...requestHeaders(request)};
      const headerTimer=setTimeout(()=>controller.abort(new DOMException('Proxy upstream header timeout','TimeoutError')),20_000);
      let upstream:Response;
      try{upstream=await fetch(target,{redirect:'follow',signal:controller.signal,method,headers:{'user-agent':'FreeNewDesk/1.4.16',...forwarded}});}finally{clearTimeout(headerTimer);}
      const type=upstream.headers.get('content-type')??'application/octet-stream';
      if(method==='HEAD'){response.writeHead(upstream.status,responseHeaders(upstream,type,true));response.end();completed=true;return;}
      if(incoming.pathname==='/subtitle'){
        const text=await upstream.text();const body=/\.srt(?:\?|$)/i.test(upstream.url||target)||/subrip/i.test(type)?srtToVtt(text):text;
        response.writeHead(upstream.status,{'content-type':body.startsWith('WEBVTT')?'text/vtt; charset=utf-8':type,'cache-control':'no-store'});response.end(body);completed=true;return;
      }
      if(mediaPlaylist(type,upstream.url||target)){
        const body=this.#rewriteManifest(await upstream.text(),upstream.url||target,forwarded);
        response.writeHead(upstream.status,responseHeaders(upstream,type,false));response.end(body);completed=true;return;
      }
      response.writeHead(upstream.status,responseHeaders(upstream,type,true));
      if(upstream.body){
        const idle=()=>setTimeout(()=>controller.abort(new DOMException('Proxy upstream body stalled','TimeoutError')),30_000);let idleTimer=idle();
        try{for await(const chunk of upstream.body as AsyncIterable<Uint8Array>){clearTimeout(idleTimer);if(!response.write(chunk))await once(response,'drain');idleTimer=idle();}}finally{clearTimeout(idleTimer);}
      }
      response.end();completed=true;
    }catch(error){
      if(response.destroyed||controller.signal.aborted&&request.destroyed)return;
      const message=error instanceof Error?error.message:String(error);
      if(response.headersSent){response.destroy(error instanceof Error?error:new Error(message));return;}
      response.writeHead(502,{'content-type':'application/json'});response.end(JSON.stringify({error:message}));
    }finally{completed=true;request.removeListener('aborted',abort);}
  }
}

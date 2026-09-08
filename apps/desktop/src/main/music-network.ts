import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createServer,type Server } from 'node:http';

export interface MusicCredentials{username?:string;password?:string;}
export interface RemoteMusicFile{url:string;relativePath:string;size?:number;modifiedAt?:string;etag?:string;}
const DAV_TIMEOUT_MS=15_000;
const MAX_DAV_XML_BYTES=8*1024*1024;

export function musicRequestHeaders(credentials?:MusicCredentials):Record<string,string>{if(!credentials?.username)return{};return{Authorization:`Basic ${Buffer.from(`${credentials.username}:${credentials.password??''}`,'utf8').toString('base64')}`};}
function xmlDecode(value:string):string{return value.replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,'&');}
function tag(block:string,name:string):string{const match=new RegExp(`<[^>]*:?${name}[^>]*>([\\s\\S]*?)<\\/[^>]*:?${name}>`,'i').exec(block);return match?.[1]?xmlDecode(match[1].trim()):'';}
function responseBlocks(xml:string):string[]{return[...xml.matchAll(/<[^>]*:?response(?:\s[^>]*)?>([\s\S]*?)<\/[^>]*:?response>/gi)].map(match=>match[1]??'');}
function safeRemoteUrl(root:URL,href:string):URL|undefined{try{const value=new URL(href,root);if(value.protocol!==root.protocol||value.host!==root.host)return;const base=decodeURIComponent(root.pathname).replace(/\/$/,'')+'/',full=decodeURIComponent(value.pathname);if(full!==base.slice(0,-1)&&!full.startsWith(base))return;return value;}catch{return;}}
function relativeRemotePath(root:URL,value:URL):string|undefined{const rootPath=decodeURIComponent(root.pathname).replace(/\/$/,'')+'/',full=decodeURIComponent(value.pathname);if(!full.startsWith(rootPath))return;const relative=full.slice(rootPath.length);if(!relative||relative.split('/').some(segment=>segment==='..'))return;return relative;}

async function fetchDav(url:string,init:RequestInit,signal:AbortSignal):Promise<{status:number;ok:boolean;text:string}>{
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(new Error('WebDAV 请求超时')),DAV_TIMEOUT_MS),abort=()=>controller.abort(signal.reason);
  if(signal.aborted)abort();else signal.addEventListener('abort',abort,{once:true});
  try{
    const response=await fetch(url,{...init,redirect:'error',signal:controller.signal});
    const reader=response.body?.getReader(),chunks:Uint8Array[]=[];let size=0;
    if(reader)try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>MAX_DAV_XML_BYTES){await reader.cancel();throw new Error('WebDAV 目录响应超过 8 MiB 安全上限');}chunks.push(part.value);}}finally{reader.releaseLock();}
    return{status:response.status,ok:response.ok,text:Buffer.concat(chunks).toString('utf8')};
  }finally{clearTimeout(timer);signal.removeEventListener('abort',abort);}
}

export async function scanWebDav(rootValue:string,credentials:MusicCredentials|undefined,signal:AbortSignal,maxFiles:number,accept:(relativePath:string)=>boolean):Promise<RemoteMusicFile[]>{
  const root=new URL(rootValue);if(root.protocol!=='http:'&&root.protocol!=='https:')throw new Error('WebDAV 地址必须使用 http:// 或 https://');if(!root.pathname.endsWith('/'))root.pathname+='/';const pending=[root],seen=new Set<string>(),files:RemoteMusicFile[]=[];
  while(pending.length&&files.length<maxFiles){if(signal.aborted)throw signal.reason;const directory=pending.shift();if(!directory)break;const key=directory.toString();if(seen.has(key))continue;seen.add(key);
    const response=await fetchDav(directory.toString(),{method:'PROPFIND',headers:{Depth:'1','Content-Type':'application/xml; charset=utf-8',...musicRequestHeaders(credentials)},body:'<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/><d:getlastmodified/><d:getetag/></d:prop></d:propfind>'},signal);
    if(response.status===401||response.status===403)throw new Error('WebDAV 身份验证失败');if(!response.ok&&response.status!==207)throw new Error(`WebDAV PROPFIND 失败：HTTP ${response.status}`);
    for(const block of responseBlocks(response.text)){const href=tag(block,'href');if(!href)continue;const url=safeRemoteUrl(root,href);if(!url||url.toString()===directory.toString())continue;const relative=relativeRemotePath(root,url);if(!relative)continue;const collection=/<[^>]*:?collection(?:\s[^>]*)?\s*\/>/i.test(block)||/<[^>]*:?collection(?:\s[^>]*)?>/i.test(block);if(collection){if(!url.pathname.endsWith('/'))url.pathname+='/';if(!seen.has(url.toString()))pending.push(url);continue;}if(!accept(relative))continue;const size=Number(tag(block,'getcontentlength')),modified=tag(block,'getlastmodified'),etag=tag(block,'getetag');files.push({url:url.toString(),relativePath:relative,...(Number.isFinite(size)&&size>=0?{size}:{}),...(modified&&Number.isFinite(Date.parse(modified))?{modifiedAt:new Date(modified).toISOString()}:{}),...(etag?{etag}:{})});if(files.length>=maxFiles)break;}
  }
  return files;
}

export interface SmbSession{server:string;share:string;username:string;}
export interface SmbConnectionOptions{disconnectConflicts?:boolean;}

function collectProcess(command:string,args:string[]):Promise<{exitCode:number|null;stdout:Buffer;stderr:Buffer}>{return new Promise((resolve,reject)=>{const child=spawn(command,args,{windowsHide:true,stdio:['ignore','pipe','pipe']}),stdout:Buffer[]=[],stderr:Buffer[]=[];child.stdout.on('data',chunk=>stdout.push(Buffer.from(chunk)));child.stderr.on('data',chunk=>stderr.push(Buffer.from(chunk)));child.once('error',reject);child.once('exit',exitCode=>resolve({exitCode,stdout:Buffer.concat(stdout),stderr:Buffer.concat(stderr)}));});}
export function parseNetErrorCode(...chunks:Array<Buffer|string>):number|undefined{const text=chunks.map(value=>Buffer.isBuffer(value)?value.toString('latin1'):value).join('\n');for(const code of [1219,1326,86,67,53,5])if(new RegExp(`(?:^|\\D)${code}(?:\\D|$)`).test(text))return code;return;}
function netErrorMessage(code:number|undefined,exitCode:number|null):string{if(code===1219)return'Windows å·²å­˜åœ¨åŒæœåŠ¡å™¨çš„å…¶ä»–å‡­æ®è¿žæŽ¥';if(code===1326||code===86)return'SMB ç”¨æˆ·åæˆ–å¯†ç ä¸æ­£ç¡®';if(code===53)return'æ‰¾ä¸åˆ° SMB æœåŠ¡å™¨æˆ–ç½‘ç»œè·¯å¾„';if(code===67)return'æ‰¾ä¸åˆ°æŒ‡å®šçš„ SMB å…±äº«';if(code===5)return'SMB è®¿é—®è¢«æ‹’ç»';return`SMB Windows å‘½ä»¤å¤±è´¥ï¼ˆé€€å‡ºä»£ç  ${exitCode??'unknown'}ï¼‰`;}
class SmbCommandError extends Error{constructor(readonly windowsCode:number|undefined,readonly exitCode:number|null){super(`[SMB_NET_ERROR:${windowsCode??'UNKNOWN'}] ${netErrorMessage(windowsCode,exitCode)}`);this.name='SmbCommandError';}}
async function runNet(args:string[]):Promise<void>{const result=await collectProcess('net.exe',args);if(result.exitCode===0)return;throw new SmbCommandError(parseNetErrorCode(result.stdout,result.stderr),result.exitCode);}

export function smbShareRoot(root:string):string|undefined{const normalized=root.replaceAll('/','\\'),match=/^\\\\([^\\]+)\\([^\\]+)/.exec(normalized);return match?`\\\\${match[1]}\\${match[2]}`:undefined;}
export function smbServerRoot(root:string):string|undefined{const normalized=root.replaceAll('/','\\'),match=/^\\\\([^\\]+)/.exec(normalized);return match?`\\\\${match[1]}`:undefined;}
function serverKey(value:string):string{return value.replace(/^\\\\/,'').replace(/\\+$/,'').toLocaleLowerCase('en-US');}
function usernameCompatible(existing:string,requested:string):boolean{const a=existing.trim().replaceAll('/','\\').toLocaleLowerCase('en-US'),b=requested.trim().replaceAll('/','\\').toLocaleLowerCase('en-US');return a===b||(!b.includes('\\')&&a.endsWith(`\\${b}`));}
export function classifySmbSessions(root:string,credentials:MusicCredentials|undefined,sessions:SmbSession[]):{server:string;sameServer:SmbSession[];compatible:boolean;conflict:boolean}{const server=smbServerRoot(root)??'',sameServer=sessions.filter(item=>serverKey(item.server)===serverKey(server)),requested=credentials?.username??'',compatible=Boolean(requested&&sameServer.some(item=>usernameCompatible(item.username,requested))),conflict=Boolean(requested&&sameServer.length&&!compatible);return{server,sameServer,compatible,conflict};}

export async function listSmbConnections():Promise<SmbSession[]>{
  if(process.platform!=='win32')return[];
  const script="[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); @(Get-SmbConnection -ErrorAction Stop | Select-Object ServerName,ShareName,UserName) | ConvertTo-Json -Compress";
  const result=await collectProcess('powershell.exe',['-NoProfile','-NonInteractive','-Command',script]);if(result.exitCode!==0)return[];
  const text=result.stdout.toString('utf8').replace(/^\uFEFF/,'').trim();if(!text)return[];
  try{const parsed=JSON.parse(text) as unknown,rows=Array.isArray(parsed)?parsed:[parsed];return rows.flatMap(value=>{if(!value||typeof value!=='object')return[];const row=value as Record<string,unknown>,server=String(row.ServerName??'').trim(),share=String(row.ShareName??'').trim(),username=String(row.UserName??'').trim();return server&&share?[{server:`\\\\${server.replace(/^\\+/, '')}`,share,username}]:[];});}catch{return[];}
}

export class SmbCredentialConflictError extends Error{readonly code=1219;constructor(readonly server:string,readonly sessions:SmbSession[]){const shares=[...new Set(sessions.map(item=>item.share))].join('ã€')||'çŽ°æœ‰å…±äº«';super(`[SMB_CREDENTIAL_CONFLICT:1219] Windows å·²ä½¿ç”¨å…¶ä»–è´¦å·è¿žæŽ¥ ${server}ï¼ˆ${shares}ï¼‰ã€‚å¦‚éœ€ä½¿ç”¨å½“å‰è´¦å·ï¼Œè¯·ç¡®è®¤åŽåªæ–­å¼€è¯¥æœåŠ¡å™¨çš„å†²çªè¿žæŽ¥å¹¶é‡è¯•ã€‚`);this.name='SmbCredentialConflictError';}}

const connectedShares=new Set<string>();
async function disconnectServerSessions(server:string,sessions:SmbSession[]):Promise<void>{for(const session of sessions){const target=`${server}\\${session.share}`;await runNet(['use',target,'/delete','/y']).catch(()=>undefined);}}
export async function ensureSmbConnection(root:string,credentials?:MusicCredentials,options:SmbConnectionOptions={}):Promise<void>{
  if(process.platform!=='win32')throw new Error('SMB éŸ³ä¹æºä»…åœ¨ Windows ä¸Šå—æ”¯æŒ');const share=smbShareRoot(root),server=smbServerRoot(root);if(!share||!server)throw new Error('SMB åœ°å€å¿…é¡»æ˜¯ \\\\server\\share å½¢å¼');if(connectedShares.has(share))return;if(!credentials?.username)return;
  let sessions=await listSmbConnections(),state=classifySmbSessions(root,credentials,sessions);if(state.conflict){if(!options.disconnectConflicts)throw new SmbCredentialConflictError(server,state.sameServer);await disconnectServerSessions(server,state.sameServer);sessions=await listSmbConnections();state=classifySmbSessions(root,credentials,sessions);if(state.conflict)throw new SmbCredentialConflictError(server,state.sameServer);}
  try{await runNet(['use',share,credentials.password??'',`/user:${credentials.username}`,'/persistent:no']);connectedShares.add(share);}catch(error){if(error instanceof SmbCommandError&&error.windowsCode===1219){const current=await listSmbConnections();throw new SmbCredentialConflictError(server,classifySmbSessions(root,credentials,current).sameServer);}throw error;}
}
export async function disconnectSmbConnections():Promise<void>{if(process.platform!=='win32')return;for(const share of connectedShares)await runNet(['use',share,'/delete','/y']).catch(()=>undefined);connectedShares.clear();}
type BridgeTarget={url:string;headers:Record<string,string>;expiresAt:number};
export class WebDavRangeBridge{
  #server:Server|undefined;#port=0;#starting:Promise<void>|undefined;readonly #targets=new Map<string,BridgeTarget>();
  async urlFor(url:string,credentials?:MusicCredentials):Promise<string>{const remote=new URL(url);if(remote.protocol!=='http:'&&remote.protocol!=='https:')throw new Error('WebDAV 播放地址无效');await this.#ensureStarted();this.#prune();const token=randomUUID().replaceAll('-','');this.#targets.set(token,{url:remote.toString(),headers:musicRequestHeaders(credentials),expiresAt:Date.now()+6*60*60_000});return`http://127.0.0.1:${this.#port}/music/${token}`;}
  async close():Promise<void>{if(this.#starting)await this.#starting;this.#targets.clear();const server=this.#server;this.#server=undefined;this.#port=0;if(server)await new Promise<void>(resolve=>server.close(()=>resolve()));}
  #prune():void{const now=Date.now();for(const[token,target]of this.#targets)if(target.expiresAt<=now)this.#targets.delete(token);}
  async #ensureStarted():Promise<void>{if(this.#starting)return this.#starting;if(this.#server&&this.#port)return;this.#starting=this.#start();try{await this.#starting;}finally{this.#starting=undefined;}}
  async #start():Promise<void>{const server=createServer((request,response)=>{void this.#proxy(request,response);});await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>resolve());});const address=server.address();if(!address||typeof address==='string'){server.close();throw new Error('无法建立本机 WebDAV Range Bridge');}this.#server=server;this.#port=address.port;}
  async #proxy(request:import('node:http').IncomingMessage,response:import('node:http').ServerResponse):Promise<void>{
    const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;const abort=()=>controller.abort();response.once('close',abort);const armTimeout=()=>{if(timer)clearTimeout(timer);timer=setTimeout(abort,30_000);};
    try{this.#prune();const match=/^\/music\/([a-f0-9]+)$/.exec(request.url??''),target=match?.[1]?this.#targets.get(match[1]):undefined;if(!target){response.writeHead(404);response.end();return;}if(request.method!=='GET'&&request.method!=='HEAD'){response.writeHead(405);response.end();return;}const headers:Record<string,string>={...target.headers};for(const name of ['range','if-range','if-none-match','if-modified-since']){const value=request.headers[name];if(typeof value==='string')headers[name]=value;}if(headers.range&&!/^bytes=(?:[0-9]+-[0-9]*|-[0-9]+)$/.test(headers.range)){response.writeHead(416);response.end();return;}armTimeout();const upstream=await fetch(target.url,{method:request.method,headers,redirect:'error',signal:controller.signal});if(headers.range&&upstream.status===200){await upstream.body?.cancel();response.writeHead(502);response.end('上游不支持 Range，无法安全定位播放位置');return;}for(const name of ['content-type','content-length','content-range','accept-ranges','etag','last-modified','cache-control']){const value=upstream.headers.get(name);if(value)response.setHeader(name,value);}response.statusCode=upstream.status;if(request.method==='HEAD'||!upstream.body){response.end();return;}await upstream.body.pipeTo(new WritableStream<Uint8Array>({write:async chunk=>{armTimeout();if(!response.write(Buffer.from(chunk)))await once(response,'drain',{signal:controller.signal});},close:()=>void response.end(),abort:()=>void response.destroy()}),{signal:controller.signal});}
    catch{if(!response.headersSent){response.writeHead(502,{'Content-Type':'text/plain; charset=utf-8'});response.end('音乐读流失败或已取消');}else response.destroy();}
    finally{if(timer)clearTimeout(timer);response.off('close',abort);}
  }
}

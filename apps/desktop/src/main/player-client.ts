import { app,BrowserWindow } from 'electron';
import { Buffer } from 'node:buffer';
import { spawn,type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import type { PlaybackDomain,PlaybackInitiator,PlaybackSessionSnapshot,PlayerCommand,PlayerLoadStatus,PlayerQuery,PlayerStats,PlayerTrack,PlayRequest } from '@free-new-desk/contracts';
import { PlaybackSessionController,PlaybackSupersededError as SessionSupersededError } from './playback-session-controller.js';

type PlayerParams=Record<string,unknown>;
type CommandResult={ok:boolean;detail?:string};
type LoadAccepted=CommandResult&{accepted?:boolean;loadId?:string};
export type PlayerRuntimeSession=PlaybackSessionSnapshot;
export interface PlayerLoadContext{
  requestId?:string;initiator?:PlaybackInitiator;sourceId?:string;channelId?:string;routeIndex?:number;routeCount?:number;
  videoId?:string;episodeId?:string;trackId?:string;queueItemId?:string;
}
const browserUserAgent='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';
const compatibilityUserAgents=['okhttp/3.15','bingcha/1.1 (mianfeifenxiang) ','Goiptv/8.8.8'];
function headerKey(headers:Record<string,string>,name:string):string|undefined{return Object.keys(headers).find(key=>key.toLowerCase()===name.toLowerCase());}
function hasHeader(headers:Record<string,string>,name:string):boolean{return Boolean(headerKey(headers,name));}
function withUserAgent(headers:Record<string,string>,value:string):Record<string,string>{const next={...headers};const key=headerKey(next,'User-Agent');if(key&&key!=='User-Agent')delete next[key];next['User-Agent']=value;return next;}
function headerFields(headers:Record<string,string>):string{return Object.entries(headers).map(([key,value])=>`${key}: ${value}`).join(',');}
function runtimeMeta(context:PlayerLoadContext):Partial<PlaybackSessionSnapshot>{return{...(context.sourceId?{sourceId:context.sourceId}:{}),...(context.channelId?{channelId:context.channelId}:{}),...(context.routeIndex!==undefined?{routeIndex:context.routeIndex}:{}),...(context.routeCount!==undefined?{routeCount:context.routeCount}:{}),...(context.videoId?{videoId:context.videoId}:{}),...(context.episodeId?{episodeId:context.episodeId}:{}),...(context.trackId?{trackId:context.trackId}:{}),...(context.queueItemId?{queueItemId:context.queueItemId}:{})};}
class PlayerRemoteError extends Error{constructor(message:string){super(message);this.name='PlayerRemoteError';}}
class PlaybackSupersededError extends Error{constructor(){super('[PLAYBACK_SUPERSEDED] 播放请求已被更新的播放操作替代');this.name='PlaybackSupersededError';}}
let currentPlayerClient:PlayerClient|undefined;
const runtimeListeners=new Set<(session:PlayerRuntimeSession)=>void>();
const runtimeController=new PlaybackSessionController(snapshot=>{for(const listener of runtimeListeners)try{listener({...snapshot});}catch{/* diagnostic listener is best effort */}});
export function getCurrentPlayerClient():PlayerClient|undefined{return currentPlayerClient;}
export function getPlayerRuntimeSession():PlayerRuntimeSession{return runtimeController.current();}
export function onPlayerRuntimeSession(listener:(session:PlayerRuntimeSession)=>void):()=>void{runtimeListeners.add(listener);listener(runtimeController.current());return()=>runtimeListeners.delete(listener);}
export function beginPlayerRuntimeSession(domain:PlaybackDomain,meta:Partial<PlaybackSessionSnapshot>={},initiator:PlaybackInitiator='user'):PlayerRuntimeSession{return runtimeController.begin(domain,meta,initiator);}
export function patchPlayerRuntimeSession(requestId:string,patch:Partial<PlaybackSessionSnapshot>):PlayerRuntimeSession|undefined{if(!runtimeController.isMutable(requestId))return;return runtimeController.patch(requestId,patch);}
export function failPlayerRuntimeSession(requestId:string,error:string):PlayerRuntimeSession|undefined{return runtimeController.fail(requestId,error);}
export function endPlayerRuntimeSession(requestId:string,reason:'eof'|'stop'|'replaced'|'failed'|'unknown'='unknown'):PlayerRuntimeSession|undefined{if(!runtimeController.isCurrent(requestId))return;return runtimeController.end(reason);}
export function isPlayerRuntimeCurrent(requestId:string,domain?:PlaybackDomain):boolean{const current=runtimeController.current();return runtimeController.isCurrent(requestId)&&(!domain||current.domain===domain);}
export function assertPlayerRuntimeCurrent(requestId:string,domain?:PlaybackDomain):PlayerRuntimeSession{runtimeController.assertMutable(requestId);const current=runtimeController.current();if(domain&&current.domain!==domain)throw new SessionSupersededError();return current;}

export class PlayerClient{
  #process:ChildProcessWithoutNullStreams|undefined;
  #pipeName='';
  #parentHwnd='';
  #startPromise:Promise<void>|undefined;
  #loadGeneration=0;

  constructor(private readonly recordMetric:(metric:string,value:number)=>void=()=>{}){currentPlayerClient=this;}

  setParentWindowHandle(handle:Buffer):void{
    try{
      if(handle.length<4)return;
      const value=handle.length>=8?handle.readBigUInt64LE(0):BigInt(handle.readUInt32LE(0));
      const next=value.toString();
      if(!next||next==='0'||next===this.#parentHwnd)return;
      const hadParent=Boolean(this.#parentHwnd);
      this.#parentHwnd=next;
      if(hadParent&&this.#process&&!this.#process.killed)this.stop();
    }catch{/* Invalid native window handle; parent PID remains as fallback. */}
  }

  async load(request:PlayRequest,onAccepted?:(loadId:string)=>void,context:PlayerLoadContext={}):Promise<CommandResult>{
    if(process.platform!=='win32')return{ok:false,detail:'Native PlayerHost is Windows-only'};
    const generation=++this.#loadGeneration;
    const domain:PlaybackDomain|null=request.profile==='vod'||request.profile==='live'||request.profile==='music'?request.profile:null;
    let requestId='';
    if(domain){
      if(context.requestId){assertPlayerRuntimeCurrent(context.requestId,domain);requestId=context.requestId;patchPlayerRuntimeSession(requestId,runtimeMeta(context));}
      else requestId=runtimeController.begin(domain,runtimeMeta(context),context.initiator??'user').requestId;
    }
    const requestedAt=performance.now();
    const originalHeaders={...(request.headers??{})};
    const explicitUserAgent=Boolean(request.headerFields)||hasHeader(originalHeaders,'User-Agent');
    const isHttp=/^https?:\/\//i.test(request.url);
    const baseHeaders=isHttp&&!explicitUserAgent?withUserAgent(originalHeaders,browserUserAgent):originalHeaders;
    const attempts:Record<string,string>[]=[baseHeaders];
    if(isHttp&&!explicitUserAgent)for(const userAgent of compatibilityUserAgents)attempts.push(withUserAgent(originalHeaders,userAgent));
    let lastError:unknown;
    let acceptedReported=false;
    for(let index=0;index<attempts.length;index+=1){
      try{
        this.#assertCurrent(generation,requestId,domain??undefined);
        const fields=request.headerFields??headerFields(attempts[index]??{});
        const started=Date.now();
        try{
          const dispatchStarted=performance.now();
          this.recordMetric('playbackRequestQueueMs',dispatchStarted-requestedAt);
          const accepted=await this.#sendWithRecovery('player.load',{url:request.url,...(fields?{headerFields:fields}:{}),...(request.profile?{profile:request.profile}:{}),generation},generation,requestId,domain??undefined) as LoadAccepted;
          this.recordMetric('playbackRequestDispatchMs',performance.now()-dispatchStarted);
          this.#assertCurrent(generation,requestId,domain??undefined);
          if(!accepted.ok||!accepted.accepted||!accepted.loadId)throw new PlayerRemoteError(accepted.detail??'PlayerHost did not accept media load');
          if(requestId&&runtimeController.isCurrent(requestId))runtimeController.patch(requestId,{...runtimeMeta(context),status:'loading',loadId:accepted.loadId});
          if(!acceptedReported){acceptedReported=true;onAccepted?.(accepted.loadId);}
          const openStarted=performance.now();
          const result=await this.#waitForLoad(accepted.loadId,generation,requestId,domain??undefined);
          this.recordMetric('playerLoadOpenMs',performance.now()-openStarted);
          if(result.ok&&requestId&&runtimeController.isCurrent(requestId))runtimeController.playing(requestId,accepted.loadId);
          return result;
        }catch(error){
          if(error instanceof PlaybackSupersededError||error instanceof SessionSupersededError){this.recordMetric('cancelledPlaybackRequestCount',1);return{ok:false,detail:error.message};}
          lastError=error;
          const quickRemoteFailure=error instanceof PlayerRemoteError&&(Date.now()-started)<=8_000;
          if(!quickRemoteFailure||index===attempts.length-1)throw error;
        }
      }catch(error){
        if(error instanceof PlaybackSupersededError||error instanceof SessionSupersededError){this.recordMetric('cancelledPlaybackRequestCount',1);return{ok:false,detail:error.message};}
        if(requestId)runtimeController.fail(requestId,error instanceof Error?error.message:String(error));
        throw error;
      }
    }
    if(requestId)runtimeController.fail(requestId,lastError instanceof Error?lastError.message:String(lastError??'PlayerHost failed to load media'));
    throw lastError instanceof Error?lastError:new Error('PlayerHost failed to load media');
  }

  async command(command:PlayerCommand):Promise<CommandResult>{
    if(process.platform!=='win32')return{ok:false,detail:'Native PlayerHost is Windows-only'};
    if(command.command==='stop'){this.#loadGeneration+=1;const current=runtimeController.current();if(current.requestId)runtimeController.end('stop');}
    const result=await this.#sendWithRecovery('player.command',command as unknown as PlayerParams) as CommandResult;
    if(result.ok&&command.command==='pause'){const current=runtimeController.current();if(current.requestId)runtimeController.pause(current.requestId,command.value);}
    return result;
  }

  async query(query:'stats'):Promise<PlayerStats>;
  async query(query:'tracks'):Promise<PlayerTrack[]>;
  async query(query:'load-status'):Promise<PlayerLoadStatus>;
  async query(query:PlayerQuery):Promise<PlayerStats|PlayerTrack[]|PlayerLoadStatus>;
  async query(query:PlayerQuery):Promise<PlayerStats|PlayerTrack[]|PlayerLoadStatus>{
    if(process.platform!=='win32')throw new Error('Native PlayerHost is Windows-only');
    const requestedSession=runtimeController.current();
    const result=await this.#sendWithRecovery('player.query',{query}) as PlayerStats|PlayerTrack[]|PlayerLoadStatus;
    if(query==='tracks')return result;
    if(requestedSession.requestId!==runtimeController.current().requestId)throw new PlaybackSupersededError();
    if(query==='load-status'&&result&&typeof result==='object'&&!Array.isArray(result)){
      const state=result as PlayerLoadStatus,current=runtimeController.current();
      if(current.loadId&&state.loadId===current.loadId){
        if(state.status==='ended')runtimeController.end(state.error==='eof'?'eof':state.error==='failed'?'failed':'stop');
        else if(state.status==='failed'&&current.requestId)runtimeController.fail(current.requestId,state.error??'PlayerHost media load failed');
      }
    }
    const current=runtimeController.current();
    if(result&&typeof result==='object'&&!Array.isArray(result))return{...result,domain:current.domain,requestId:current.requestId,sessionGeneration:current.generation,sessionStatus:current.status,...(current.loadId?{sessionLoadId:current.loadId}:{})} as PlayerStats|PlayerLoadStatus;
    return result;
  }

  async #waitForLoad(loadId:string,generation:number,requestId:string,domain?:PlaybackDomain):Promise<CommandResult>{
    const deadline=Date.now()+30_000;
    while(Date.now()<deadline){
      this.#assertCurrent(generation,requestId,domain);
      const state=await this.query('load-status');
      this.#assertCurrent(generation,requestId,domain);
      if(state.loadId===loadId){
        if(state.status==='loaded')return{ok:true};
        if(state.status==='failed'||state.status==='ended')throw new PlayerRemoteError(state.error||`PlayerHost media load ${state.status}`);
      }
      await new Promise(resolve=>setTimeout(resolve,75));
    }
    throw new PlayerRemoteError('Timed out waiting for mpv to open media');
  }

  #assertCurrent(generation:number,requestId='',domain?:PlaybackDomain):void{if(generation!==this.#loadGeneration){this.recordMetric('stalePlaybackResponseCount',1);throw new PlaybackSupersededError();}if(requestId&&(!runtimeController.isMutable(requestId)||!isPlayerRuntimeCurrent(requestId,domain))){this.recordMetric('stalePlaybackResponseCount',1);throw new PlaybackSupersededError();}}

  stop():void{
    this.#loadGeneration+=1;
    const current=runtimeController.current();if(current.requestId)runtimeController.end('stop');
    this.#process?.kill();
    this.#process=undefined;
    this.#pipeName='';
  }

  async #sendWithRecovery(method:string,params:PlayerParams,generation?:number,requestId='',domain?:PlaybackDomain):Promise<unknown>{
    const assertCurrent=()=>{if(generation!==undefined)this.#assertCurrent(generation,requestId,domain);};
    try{
      assertCurrent();
      await this.#ensureStarted();
      assertCurrent();
      return await this.#send(method,params);
    }catch(first){
      if(first instanceof PlaybackSupersededError||first instanceof SessionSupersededError)throw first;
      if(first instanceof PlayerRemoteError)throw first;
      assertCurrent();
      this.#stopTransportOnly();
      try{
        await this.#ensureStarted();
        assertCurrent();
        return await this.#send(method,params);
      }catch(second){
        if(second instanceof PlaybackSupersededError||second instanceof SessionSupersededError||second instanceof PlayerRemoteError)throw second;
        const primary=second instanceof Error?second:first;
        throw primary instanceof Error?new Error(`${method} failed after PlayerHost recovery: ${primary.message}`,{cause:primary}):primary;
      }
    }
  }

  #stopTransportOnly():void{
    this.#process?.kill();
    this.#process=undefined;
    this.#pipeName='';
  }

  async #ensureStarted():Promise<void>{
    if(this.#startPromise)return await this.#startPromise;
    if(this.#process&&!this.#process.killed&&this.#pipeName)return;
    const start=this.#start();
    this.#startPromise=start;
    try{await start;}finally{if(this.#startPromise===start)this.#startPromise=undefined;}
  }

  async #start():Promise<void>{
    const started=performance.now();
    if(!this.#parentHwnd){
      const appWindows=BrowserWindow.getAllWindows().filter(window=>!window.isDestroyed()&&window.webContents.getURL().startsWith('file://'));
      const parent=appWindows.find(window=>window.isVisible())??appWindows[0];
      if(parent)this.setParentWindowHandle(parent.getNativeWindowHandle());
    }
    const executable=app.isPackaged?path.join(process.resourcesPath,'native','player-host','player-host.exe'):path.join(app.getAppPath(),'native','player-host','build','Release','player-host.exe');
    this.#pipeName=`\\\\.\\pipe\\free-new-desk-player-${randomUUID()}`;
    let startupError:Error|undefined;
    let stderrTail='';
    const args=['--pipe',this.#pipeName,'--parent-pid',String(process.pid),...(this.#parentHwnd?['--parent-hwnd',this.#parentHwnd]:[]),...(process.env.FND_UI_SMOKE==='1'?['--test-audio-output','null']:[])];
    const child=spawn(executable,args,{windowsHide:true});
    this.recordMetric('playerHostStartMs',performance.now()-started);
    child.stdout.on('data',()=>{});
    child.stderr.on('data',chunk=>{stderrTail=(stderrTail+String(chunk)).slice(-4096);});
    child.once('error',error=>{startupError=error;});
    child.once('exit',(code,signal)=>{
      if(this.#process===child){this.#process=undefined;this.#pipeName='';}
      if(code!==0)startupError=new Error(`PlayerHost exited with code ${code}${signal?` (${signal})`:''}${stderrTail?`: ${stderrTail.trim()}`:''}`);
    });
    this.#process=child;
    await new Promise<void>((resolve,reject)=>{
      const deadline=Date.now()+10_000;
      const probe=()=>{
        if(startupError){reject(new Error(`Unable to start PlayerHost: ${startupError.message}`,{cause:startupError}));return;}
        if(!this.#pipeName){reject(new Error('PlayerHost exited before pipe became ready'));return;}
        const socket=net.createConnection(this.#pipeName);
        socket.once('connect',()=>{socket.end();resolve();});
        socket.once('error',()=>{socket.destroy();if(Date.now()>=deadline)reject(new Error(`PlayerHost did not open its named pipe: ${executable}`));else setTimeout(probe,25);});
      };
      probe();
    });
    await this.#send('player.command',{command:'window-sync',x:0,y:0,width:1,height:1,scale:1,visible:false});
    this.recordMetric('playerHostReadyMs',performance.now()-started);
  }

  #send(method:string,params:PlayerParams):Promise<unknown>{
    return new Promise((resolve,reject)=>{
      if(!this.#pipeName){reject(new Error('PlayerHost pipe is unavailable'));return;}
      const socket=net.createConnection(this.#pipeName);
      let buffer='';
      const timeoutMs=10_000;
      const timer=setTimeout(()=>{socket.destroy();reject(new Error(`PlayerHost timeout after ${timeoutMs/1000}s: ${method}`));},timeoutMs);
      socket.setEncoding('utf8');
      socket.on('connect',()=>socket.write(`${JSON.stringify({id:randomUUID(),method,params})}\n`));
      socket.on('data',chunk=>{
        buffer+=chunk;
        const newline=buffer.indexOf('\n');
        if(newline<0)return;
        clearTimeout(timer);
        const line=buffer.slice(0,newline);
        socket.end();
        try{
          const response=JSON.parse(line) as{result?:unknown;error?:{message?:string}};
          if(response.error)reject(new PlayerRemoteError(response.error.message??'Player error'));
          else resolve(response.result);
        }catch(error){reject(error instanceof Error?error:new Error(String(error)));}
      });
      socket.on('error',error=>{clearTimeout(timer);reject(error);});
    });
  }
}

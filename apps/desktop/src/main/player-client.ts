import { app,BrowserWindow } from 'electron';
import { Buffer } from 'node:buffer';
import { spawn,type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import type { PlaybackDomain,PlaybackInitiator,PlaybackSessionSnapshot,PlayerCommand,PlayerLoadStatus,PlayerQuery,PlayerStats,PlayerTrack,PlayRequest } from '@free-new-desk/contracts';
import { PlaybackSessionController,PlaybackSupersededError as SessionSupersededError } from './playback-session-controller.js';
import {resolveLivePlaybackTarget} from './live-playback-target.js';

type PlayerParams=Record<string,unknown>;
export type PlayerLoadTrace={stage:'ready'|'round-trip';phase:'start'|'success'|'failure';attempt:number;generation:number;elapsedMs:number};
type CommandResult={ok:boolean;detail?:string};
type LoadAccepted=CommandResult&{accepted?:boolean;loadId?:string;hostEpoch?:string};
export type PlayerRuntimeSession=PlaybackSessionSnapshot;
export interface PlayerLoadContext{
  requestId?:string;initiator?:PlaybackInitiator;sourceId?:string;channelId?:string;routeIndex?:number;routeCount?:number;
  videoId?:string;episodeId?:string;trackId?:string;queueItemId?:string;deferLiveFailure?:boolean;
}
const browserUserAgent='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';
const compatibilityUserAgents=['okhttp/3.15','bingcha/1.1 (mianfeifenxiang) ','Goiptv/8.8.8'];
const STATS_SOFT_STALE_MS=3_000;
const STATS_HARD_EXPIRY_MS=15_000;
function headerKey(headers:Record<string,string>,name:string):string|undefined{return Object.keys(headers).find(key=>key.toLowerCase()===name.toLowerCase());}
function hasHeader(headers:Record<string,string>,name:string):boolean{return Boolean(headerKey(headers,name));}
function withUserAgent(headers:Record<string,string>,value:string):Record<string,string>{const next={...headers};const key=headerKey(next,'User-Agent');if(key&&key!=='User-Agent')delete next[key];next['User-Agent']=value;return next;}
function headerFields(headers:Record<string,string>):string{return Object.entries(headers).map(([key,value])=>`${key}: ${value}`).join(',');}
function runtimeMeta(context:PlayerLoadContext):Partial<PlaybackSessionSnapshot>{return{...(context.sourceId?{sourceId:context.sourceId}:{}),...(context.channelId?{channelId:context.channelId}:{}),...(context.routeIndex!==undefined?{routeIndex:context.routeIndex}:{}),...(context.routeCount!==undefined?{routeCount:context.routeCount}:{}),...(context.videoId?{videoId:context.videoId}:{}),...(context.episodeId?{episodeId:context.episodeId}:{}),...(context.trackId?{trackId:context.trackId}:{}),...(context.queueItemId?{queueItemId:context.queueItemId}:{})};}
class PlayerRemoteError extends Error{constructor(message:string){super(message);this.name='PlayerRemoteError';}}
class PlayerTransportTimeoutError extends Error{constructor(readonly method:string,readonly timeoutMs:number){super(`PlayerHost timeout after ${timeoutMs/1000}s: ${method}`);this.name='PlayerTransportTimeoutError';}}
class PlayerTransportConnectionError extends Error{constructor(readonly method:string,readonly code:string,detail:string){super(`PlayerHost transport ${code} during ${method}: ${detail}`);this.name='PlayerTransportConnectionError';}}
class PlaybackSupersededError extends Error{constructor(){super('[PLAYBACK_SUPERSEDED] 播放请求已被更新的播放操作替代');this.name='PlaybackSupersededError';}}
let currentPlayerClient:PlayerClient|undefined;
const runtimeListeners=new Set<(session:PlayerRuntimeSession)=>void>();
const runtimeController=new PlaybackSessionController(snapshot=>{for(const listener of runtimeListeners)try{listener({...snapshot});}catch{/* diagnostic listener is best effort */}});
export function getCurrentPlayerClient():PlayerClient|undefined{return currentPlayerClient;}
export function getPlayerRuntimeSession():PlayerRuntimeSession{return runtimeController.current();}
export function onPlayerRuntimeSession(listener:(session:PlayerRuntimeSession)=>void):()=>void{runtimeListeners.add(listener);listener(runtimeController.current());return()=>runtimeListeners.delete(listener);}
export function beginPlayerRuntimeSession(domain:PlaybackDomain,meta:Partial<PlaybackSessionSnapshot>={},initiator:PlaybackInitiator='user',parent?:PlaybackSessionSnapshot):PlayerRuntimeSession{return runtimeController.begin(domain,meta,initiator,parent);}
export function bindPlayerRuntimeHistory(requestId:string,historyId:string):PlayerRuntimeSession|undefined{return runtimeController.bindHistory(requestId,historyId);}
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
  #liveTargetController:AbortController|undefined;
  #acceptedEpoch='';
  #sampleSeq=0;
  #seekRevision=0;
  #pauseRevision=0;
  #lastStatsAt=0;
  #statsState:'pending'|'fresh'|'stale'|'unavailable'='pending';
  #transportFaultEpoch='';
  #transportFaultStreak=0;
  #lastTransportFaultAt=0;
  #statsInFlight:{requestId:string;loadId?:string;promise:Promise<PlayerStats>}|undefined;
  #lastStats:PlayerStats|undefined;

  constructor(private readonly recordMetric:(metric:string,value:number)=>void=()=>{},private readonly recordLoadTrace:(trace:PlayerLoadTrace)=>void=()=>{},private readonly recordCounter:(counter:string)=>void=()=>{}){currentPlayerClient=this;}

  // Prepare the transport without requesting invalid idle stats or changing a media session.
  async prewarm():Promise<void>{
    if(process.platform!=='win32')return;
    await this.#ensureStarted();
  }

  #resetStatsCache():void{this.#statsInFlight=undefined;this.#lastStats=undefined;this.#lastStatsAt=0;this.#statsState='pending';}
  #resetTransportFaults():void{this.#transportFaultEpoch='';this.#transportFaultStreak=0;this.#lastTransportFaultAt=0;}

  setParentWindowHandle(handle:Buffer):void{
    try{
      if(handle.length<4)return;
      const value=handle.length>=8?handle.readBigUInt64LE(0):BigInt(handle.readUInt32LE(0));
      const next=value.toString();
      if(!next||next==='0'||next===this.#parentHwnd)return;
      const hadParent=Boolean(this.#parentHwnd);
      this.#parentHwnd=next;
      if(hadParent&&this.#process&&!this.#process.killed){this.#loadGeneration+=1;this.#resetStatsCache();this.#resetTransportFaults();this.#stopTransportOnly();}
    }catch{/* Invalid native window handle; parent PID remains as fallback. */}
  }

  async load(request:PlayRequest,onAccepted?:(loadId:string)=>void,context:PlayerLoadContext={}):Promise<CommandResult>{
    if(process.platform!=='win32')return{ok:false,detail:'Native PlayerHost is Windows-only'};
    const domain:PlaybackDomain|null=request.profile==='vod'||request.profile==='live'||request.profile==='music'?request.profile:null;
    const deferLiveFailure=domain==='live'&&context.deferLiveFailure===true;
    let requestId='';
    if(domain){
      if(context.requestId){assertPlayerRuntimeCurrent(context.requestId,domain);requestId=context.requestId;patchPlayerRuntimeSession(requestId,runtimeMeta(context));}
      else requestId=runtimeController.begin(domain,runtimeMeta(context),context.initiator??'user').requestId;
    }
    const generation=++this.#loadGeneration;
    this.#liveTargetController?.abort();
    const targetController=new AbortController();
    this.#liveTargetController=targetController;
    const requestedAt=performance.now();
    const originalHeaders={...(request.headers??{})};
    const explicitUserAgent=Boolean(request.headerFields)||hasHeader(originalHeaders,'User-Agent');
    const isHttp=/^https?:\/\//i.test(request.url);
    const baseHeaders=isHttp&&!explicitUserAgent?withUserAgent(originalHeaders,browserUserAgent):originalHeaders;
    const attempts:Record<string,string>[]=[baseHeaders];
    if(isHttp&&!explicitUserAgent)for(const userAgent of compatibilityUserAgents)attempts.push(withUserAgent(originalHeaders,userAgent));
    let lastError:unknown;

    for(let index=0;index<attempts.length;index+=1){
      try{
        this.#assertCurrent(generation,requestId,domain??undefined);
        const target=request.profile==='live'&&!request.headerFields
          ?await resolveLivePlaybackTarget(request.url,attempts[index]??{},targetController.signal)
          :{url:request.url,headers:attempts[index]??{}};
        this.#assertCurrent(generation,requestId,domain??undefined);
        const fields=request.headerFields??headerFields(target.headers);
        const started=Date.now();
        try{
          const dispatchStarted=performance.now();
          this.recordMetric('playbackRequestQueueMs',dispatchStarted-requestedAt);
          const intent=runtimeController.current();
          const accepted=await this.#sendWithRecovery('player.load',{url:target.url,...(fields?{headerFields:fields}:{}),...(request.profile?{profile:request.profile}:{}),generation,sessionGeneration:intent.generation,paused:intent.desiredPaused??false,pauseRevision:intent.controlRevision??0},generation,requestId,domain??undefined) as LoadAccepted;
          this.recordMetric('playbackRequestDispatchMs',performance.now()-dispatchStarted);
          this.#assertCurrent(generation,requestId,domain??undefined);
          if(!accepted.ok||!accepted.accepted||!accepted.loadId)throw new PlayerRemoteError(accepted.detail??'PlayerHost did not accept media load');
          if(requestId&&runtimeController.isCurrent(requestId))runtimeController.patch(requestId,{...runtimeMeta(context),status:'loading',loadId:accepted.loadId,hostEpoch:accepted.hostEpoch??''});
          this.#acceptedEpoch=accepted.hostEpoch??'';this.#sampleSeq=0;this.#seekRevision=0;this.#resetStatsCache();this.#resetTransportFaults();
          onAccepted?.(accepted.loadId);
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
        if(generation!==this.#loadGeneration)error=new PlaybackSupersededError();
        if(error instanceof PlaybackSupersededError||error instanceof SessionSupersededError){this.recordMetric('cancelledPlaybackRequestCount',1);return{ok:false,detail:error.message};}
        if(requestId&&!deferLiveFailure)runtimeController.fail(requestId,error instanceof Error?error.message:String(error));
        throw error;
      }
    }
    if(requestId&&!deferLiveFailure)runtimeController.fail(requestId,lastError instanceof Error?lastError.message:String(lastError??'PlayerHost failed to load media'));
    throw lastError instanceof Error?lastError:new Error('PlayerHost failed to load media');
  }

  async command(command:PlayerCommand):Promise<CommandResult>{
    if(process.platform!=='win32')return{ok:false,detail:'Native PlayerHost is Windows-only'};
    const before=runtimeController.current();
    if((command.loadId&&command.loadId!==before.loadId)||(command.requestId&&command.requestId!==before.requestId))return{ok:false,detail:'[PLAYBACK_SUPERSEDED] 控制命令的播放会话已变化'};
    if(command.command==='pause'&&before.requestId)runtimeController.requestPause(before.requestId,command.value);
    if(command.command==='stop'){this.#liveTargetController?.abort();this.#loadGeneration+=1;this.#resetStatsCache();this.#resetTransportFaults();if(before.requestId)runtimeController.end('stop');}
    const pauseRevision=command.command==='pause'?++this.#pauseRevision:this.#pauseRevision;
    // Stop fences the whole session, including a replacement whose native ACK is still pending.
    const payload={...command,sessionGeneration:before.generation,...(command.command==='stop'?{loadId:undefined}:before.loadId?{loadId:before.loadId}:{}),...(command.command==='pause'?{pauseRevision:runtimeController.current().controlRevision??0}:{})};
    const expectedId=runtimeController.isMutable(before.requestId)||command.command==='stop'?before.requestId:'';
    const result=await this.#sendWithRecovery('player.command',payload as unknown as PlayerParams,this.#loadGeneration,expectedId,before.domain??undefined,command.command==='stop') as CommandResult&{seekRevision?:number};
    if(command.command==='seek'&&before.loadId===runtimeController.current().loadId&&result.ok)this.#seekRevision=result.seekRevision??this.#seekRevision;
    else if(command.command==='seek'&&!result.ok)this.recordMetric('seekRejectedCount',1);

    if(result.ok&&command.command==='pause'){const current=runtimeController.current();if(before.requestId&&current.requestId===before.requestId&&current.generation===before.generation&&pauseRevision===this.#pauseRevision)runtimeController.pause(before.requestId,command.value);}
    return result;
  }

  async query(query:'stats'):Promise<PlayerStats>;
  async query(query:'tracks'):Promise<PlayerTrack[]>;
  async query(query:'load-status'):Promise<PlayerLoadStatus>;
  async query(query:PlayerQuery):Promise<PlayerStats|PlayerTrack[]|PlayerLoadStatus>;
  async query(query:PlayerQuery):Promise<PlayerStats|PlayerTrack[]|PlayerLoadStatus>{
    if(query!=='stats')return await this.#queryOnce(query);
    const session=runtimeController.current(),inFlight=this.#statsInFlight;
    if(inFlight&&inFlight.requestId===session.requestId&&inFlight.loadId===session.loadId)return await inFlight.promise;
    const promise=this.#queryOnce('stats') as Promise<PlayerStats>;
    this.#statsInFlight={requestId:session.requestId,...(session.loadId?{loadId:session.loadId}:{}),promise};
    try{return await promise;}finally{if(this.#statsInFlight?.promise===promise)this.#statsInFlight=undefined;}
  }

  async #queryOnce(query:PlayerQuery):Promise<PlayerStats|PlayerTrack[]|PlayerLoadStatus>{
    if(process.platform!=='win32')throw new Error('Native PlayerHost is Windows-only');
    const requestedSession=runtimeController.current();
    const metric=query==='stats'?'playerHostStatsQuery':query==='load-status'?'playerHostLoadStatusQuery':'playerHostTracksQuery';
    this.recordCounter(metric+'Calls');
    const queryStarted=performance.now();
    let result:PlayerStats|PlayerTrack[]|PlayerLoadStatus;
    try{result=await this.#sendWithRecovery('player.query',{query}) as PlayerStats|PlayerTrack[]|PlayerLoadStatus;}
    catch(error){this.recordCounter(metric+'Errors');throw error;}
    finally{this.recordMetric(metric+'Ms',performance.now()-queryStarted);}
    const responseSession=runtimeController.current();
    if(requestedSession.requestId!==responseSession.requestId||requestedSession.loadId!==responseSession.loadId)throw new PlaybackSupersededError();
    if(query==='tracks')return result;
    if(query==='load-status'&&result&&typeof result==='object'&&!Array.isArray(result)){
      const state=result as PlayerLoadStatus,current=runtimeController.current();
      if(current.loadId&&state.loadId===current.loadId&&current.domain!=='live'){
        if(state.status==='ended')runtimeController.end(state.error==='eof'?'eof':state.error==='failed'?'failed':'stop');
        else if(state.status==='failed'&&current.requestId)runtimeController.fail(current.requestId,state.error??'PlayerHost media load failed');
      }
    }
    const current=runtimeController.current();
    if(query==='stats'){
      const sample=result as PlayerStats;
      const isCurrentSample=Boolean(current.loadId&&sample.sampleValid&&sample.hostEpoch&&sample.hostEpoch===this.#acceptedEpoch&&sample.loadId===current.loadId&&Number.isSafeInteger(sample.sampleSeq)&&(sample.sampleSeq??0)>this.#sampleSeq&&(sample.seekRevision??0)>=this.#seekRevision);
      if(isCurrentSample){
        this.#sampleSeq=sample.sampleSeq!;
        this.#lastStatsAt=performance.now();
        this.#statsState='fresh';
        this.#resetTransportFaults();
        this.#lastStats={...sample,sampleFresh:true,sampleAgeMs:0,sampleState:'fresh'};
        result=this.#lastStats;
      }else{
        const cached=this.#lastStats,age=Math.max(0,performance.now()-this.#lastStatsAt);
        if(!cached||cached.hostEpoch!==this.#acceptedEpoch||cached.loadId!==current.loadId||(cached.seekRevision??0)<this.#seekRevision){
          this.#statsState='pending';
          throw new Error('[PLAYBACK_STATS_PENDING] 等待当前会话有效采样');
        }
        if(age>STATS_HARD_EXPIRY_MS){if(this.#statsState!=='unavailable')this.recordMetric('playerStatsUnavailableCount',1);this.#statsState='unavailable';throw new Error('[PLAYBACK_STATS_UNAVAILABLE] 当前会话统计已超过 15 秒，不能用于播放或恢复决策');}
        if(age>STATS_SOFT_STALE_MS&&this.#statsState!=='stale')this.recordMetric('playerStatsStaleCount',1);
        this.#statsState='stale';
        // This cache is display-only. Callers must require sampleFresh and samplePositionStable before using it for watchdog or progress decisions.
        result={...cached,sampleFresh:false,sampleAgeMs:age,sampleState:'stale'};
      }
    }
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

  #assertCurrent(generation:number,requestId='',domain?:PlaybackDomain,allowTerminal=false):void{if(generation!==this.#loadGeneration){this.recordMetric('stalePlaybackResponseCount',1);throw new PlaybackSupersededError();}if(requestId&&((!allowTerminal&&!runtimeController.isMutable(requestId))||!isPlayerRuntimeCurrent(requestId,domain))){this.recordMetric('stalePlaybackResponseCount',1);throw new PlaybackSupersededError();}}

  stop():void{
    this.#liveTargetController?.abort();
    this.#loadGeneration+=1;
    this.#resetStatsCache();
    this.#resetTransportFaults();
    const current=runtimeController.current();if(current.requestId)runtimeController.end('stop');
    this.#process?.kill();
    this.#process=undefined;
    this.#pipeName='';
  }

  async #loadStage<T>(stage:'ready'|'round-trip',attempt:number,operation:()=>Promise<T>):Promise<T>{
    const started=performance.now(),generation=this.#loadGeneration;
    const trace=(phase:PlayerLoadTrace['phase'])=>{try{this.recordLoadTrace({stage,phase,attempt,generation,elapsedMs:performance.now()-started});}catch{/* Diagnostics must never change playback outcome. */}};
    trace('start');
    try{const result=await operation();trace('success');return result;}
    catch(error){trace('failure');throw error;}
    finally{this.recordMetric(stage==='ready'?'playerLoadReadyWaitMs':'playerLoadRoundTripMs',performance.now()-started);}
  }

  async #sendWithRecovery(method:string,params:PlayerParams,generation?:number,requestId='',domain?:PlaybackDomain,allowTerminal=false):Promise<unknown>{
    const expectedGeneration=generation??this.#loadGeneration;
    const session=runtimeController.current();
    const assertCurrent=()=>this.#assertCurrent(expectedGeneration,requestId,domain,allowTerminal);
    try{
      assertCurrent();
      // A query/control must not silently recreate an empty host for an active media session.
      if(method!=='player.load'&&session.loadId&&runtimeController.isMutable(session.requestId)&&(!this.#process||this.#process.killed))throw new Error('PlayerHost exited during playback');
      const readyStarted=performance.now();
      if(method==='player.load')await this.#loadStage('ready',1,()=>this.#ensureStarted());else await this.#ensureStarted();
      if(params.command==='window-sync')this.recordMetric('surfaceHostReadyWaitMs',performance.now()-readyStarted);
      assertCurrent();
      const result=method==='player.load'?await this.#loadStage('round-trip',1,()=>this.#send(method,params)):await this.#send(method,params);
      assertCurrent();
      return result;
    }catch(first){
      if(first instanceof PlaybackSupersededError||first instanceof SessionSupersededError)throw first;
      if(first instanceof PlayerRemoteError)throw first;
      assertCurrent();
      if(method!=='player.load'){
        if(first instanceof PlayerTransportTimeoutError||first instanceof PlayerTransportConnectionError){
          const faultEpoch=this.#acceptedEpoch||'host-starting';
          if(this.#transportFaultEpoch!==faultEpoch){this.#transportFaultEpoch=faultEpoch;this.#transportFaultStreak=0;this.#lastTransportFaultAt=0;}
          // Multiple overlapping failed queries during one I/O stall count as one incident, not three host deaths.
          const faultAt=performance.now();
          if(this.#lastTransportFaultAt===0||faultAt-this.#lastTransportFaultAt>=1_000){this.#transportFaultStreak+=1;this.#lastTransportFaultAt=faultAt;}
          this.recordMetric(first instanceof PlayerTransportTimeoutError?'playerHostTimeoutCount':'playerHostConnectionFailureCount',1);
          // A timeout or pipe reset does not prove that the host died or that a non-idempotent command was not applied. Only a fresh, identity-checked stats sample clears this epoch-bound fault budget.
          if(this.#transportFaultStreak<3){const kind=method==='player.query'?'QUERY':'COMMAND';const code=first instanceof PlayerTransportTimeoutError?`[PLAYER_${kind}_TIMEOUT]`:`[PLAYER_${kind}_UNAVAILABLE]`;throw new Error(`${code} PlayerHost 本次通信未确认，媒体会话保持不变`,{cause:first});}
        }
        // Confirmed transport failure, or repeated transport faults, crosses the safe recovery boundary.
        // Never replay a relative seek/control because the timed-out command may already have executed.
        this.#loadGeneration+=1;
        this.#stopTransportOnly();
        this.#resetTransportFaults();
        const detail='[PLAYER_TRANSPORT_FAILED] 播放器持续不可响应或连接中断，请重新播放当前媒体';
        if(session.requestId&&runtimeController.isMutable(session.requestId))runtimeController.fail(session.requestId,detail);
        this.recordMetric('playerHostTransportFailureCount',1);
        throw new Error(detail,{cause:first});
      }
      this.#stopTransportOnly();
      try{
        await this.#loadStage('ready',2,()=>this.#ensureStarted());
        assertCurrent();
        const result=await this.#loadStage('round-trip',2,()=>this.#send(method,params));
        assertCurrent();
        return result;
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
    const args=['--pipe',this.#pipeName,'--parent-pid',String(process.pid),...(this.#parentHwnd?['--parent-hwnd',this.#parentHwnd]:[]),...((process.env.FND_UI_SMOKE==='1'||process.env.FND_MUSIC_SMOKE==='1')?['--test-audio-output','null']:[])];
    const child=spawn(executable,args,{windowsHide:true});
    this.recordMetric('playerHostStartMs',performance.now()-started);
    child.stdout.on('data',()=>{});
    child.stderr.on('data',chunk=>{stderrTail=(stderrTail+String(chunk)).slice(-4096);});
    child.once('error',error=>{startupError=error;});
    child.once('exit',(code,signal)=>{
      if(this.#process===child){this.recordMetric('playerHostExitCount',1);this.#process=undefined;this.#pipeName='';}
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
      const transportStarted=performance.now(),surfaceCommand=params.command==='window-sync';
      const socket=net.createConnection(this.#pipeName);
      let buffer='';
      const timeoutMs=10_000;
      let transportRecorded=false;
      const finishTiming=()=>{if(surfaceCommand&&!transportRecorded){transportRecorded=true;this.recordMetric('surfacePipeRoundTripMs',performance.now()-transportStarted);this.recordMetric('surfacePipePending',0);}};
      if(surfaceCommand){this.recordMetric('surfaceCommandVisible',params.visible===false?0:1);this.recordMetric('surfacePipePending',1);}
      const timer=setTimeout(()=>{finishTiming();socket.destroy();reject(new PlayerTransportTimeoutError(method,timeoutMs));},timeoutMs);
      socket.setEncoding('utf8');
      socket.on('connect',()=>{if(surfaceCommand)this.recordMetric('surfacePipeConnectMs',performance.now()-transportStarted);socket.write(`${JSON.stringify({id:randomUUID(),method,params})}\n`);});
      socket.on('data',chunk=>{
        buffer+=chunk;
        const newline=buffer.indexOf('\n');
        if(newline<0)return;
        clearTimeout(timer);
        const line=buffer.slice(0,newline);
        // This RPC owns one response. Close both pipe directions immediately so a
        // half-closed connection cannot keep one of the native listener slots busy.
        socket.destroy();
        try{
          const response=JSON.parse(line) as{result?:unknown;error?:{message?:string};surfaceTiming?:Record<string,unknown>};
          if(surfaceCommand){
            finishTiming();
            for(const [field,metric]of Object.entries({commandLockMs:'surfaceNativeCommandLockMs',surfaceLockMs:'surfaceNativeSurfaceLockMs',applyMs:'surfaceNativeApplyMs',totalMs:'surfaceNativeTotalMs'})){const value=response.surfaceTiming?.[field];if(typeof value==='number'&&Number.isFinite(value)&&value>=0)this.recordMetric(metric,value);}
          }
          if(response.error)reject(new PlayerRemoteError(response.error.message??'Player error'));
          else resolve(response.result);
        }catch(error){finishTiming();reject(error instanceof Error?error:new Error(String(error)));}
      });
      socket.on('error',error=>{finishTiming();clearTimeout(timer);const code=(error as NodeJS.ErrnoException).code??'UNKNOWN';reject(new PlayerTransportConnectionError(method,code,error.message));});
    });
  }
}

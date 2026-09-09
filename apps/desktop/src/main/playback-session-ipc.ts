import { app,BrowserWindow,ipcMain,type IpcMainInvokeEvent } from 'electron';
import { AsyncLocalStorage } from 'node:async_hooks';
import { appendFile,mkdir } from 'node:fs/promises';
import path from 'node:path';
import { mediaIdentity,sameMediaPath } from './media-identity.js';
import type { PlaybackDomain,PlaybackHistoryEntry,PlaybackInitiator,PlaybackSessionSnapshot,PlayRequest,PlayerLoadStatus,PlayerQuery,PlayerStats,PlayerTrack } from '@free-new-desk/contracts';
import { DataService } from '@free-new-desk/data-service';
import { beginPlayerRuntimeSession,failPlayerRuntimeSession,getCurrentPlayerClient,getPlayerRuntimeSession,isPlayerRuntimeCurrent,onPlayerRuntimeSession,patchPlayerRuntimeSession } from './player-client.js';
import { canUpdateVodHistory,validateVodAutoNext,type HistoryIdentity } from './playback-session-rules.js';

type InvokeListener=(event:IpcMainInvokeEvent,...args:unknown[])=>unknown;
type CommandResult={ok:boolean;detail?:string};
type PlayerLike={
  load:(request:PlayRequest,onAccepted?:((loadId:string)=>void),context?:Record<string,unknown>)=>Promise<CommandResult>;
  query:(query:PlayerQuery)=>Promise<PlayerStats|PlayerTrack[]|PlayerLoadStatus>;
  command:(command:{command:'stop'}|{command:'pause';value:boolean})=>Promise<CommandResult>;
};
type InvokeIntent={domain:PlaybackDomain;requestId:string;initiator:PlaybackInitiator;sourceId?:string;channelId?:string;routeIndex?:number;routeCount?:number;videoId?:string;episodeId?:string;trackId?:string;queueItemId?:string;windowId?:number};
type NaturalEndClaim={owner:number;stage:'claimed'|'consumed'};
type MediaExpectation={requestId:string;loadId:string;url:string};

let registered=false;
const invokeStorage=new AsyncLocalStorage<InvokeIntent>();
const naturalEndClaims=new Map<string,NaturalEndClaim>();
const hookedPlayers=new WeakSet<object>();
const mediaExpectations=new WeakMap<object,MediaExpectation>();
const historyIdentityById=new Map<string,HistoryIdentity>();
const latestHistoryByMedia=new Map<string,string>();
const rawHandle=(ipcMain as unknown as {handle:(channel:string,listener:InvokeListener)=>void}).handle.bind(ipcMain);

function requireLocalSender(event:IpcMainInvokeEvent):void{const sender=event.senderFrame?.url??'';if(!sender.startsWith('file://'))throw new Error('Untrusted IPC sender');}
function recordOf(input:unknown):Record<string,unknown>{return input&&typeof input==='object'?input as Record<string,unknown>:{};}
function stringOf(value:unknown):string|undefined{return typeof value==='string'&&value.trim()?value.trim():undefined;}
function numberOf(value:unknown):number|undefined{const n=Number(value);return Number.isFinite(n)?n:undefined;}
function initiatorOf(value:unknown,fallback:PlaybackInitiator='user'):PlaybackInitiator{return value==='user'||value==='auto-next'||value==='auto-route'||value==='retry'||value==='history'||value==='restore'?value:fallback;}
function copySession():PlaybackSessionSnapshot{return getPlayerRuntimeSession();}
function historyKey(value:{sourceId?:string;videoId?:string;episodeId?:string}):string{return `${value.sourceId??''}\u0000${value.videoId??''}\u0000${value.episodeId??''}`;}
function pruneClaims():void{if(naturalEndClaims.size<=256)return;for(const key of naturalEndClaims.keys()){naturalEndClaims.delete(key);if(naturalEndClaims.size<=128)break;}}
function safeLogDetails(details:Record<string,unknown>):Record<string,unknown>{const allow=new Set(['fromDomain','toDomain','generation','sessionId','requestId','loadId','initiator','windowId','sourceId','channelId','routeBefore','routeAfter','routeIndex','routeCount','videoId','episodeId','trackId','queueItemId','endReason','accepted','rejectedReason','status']);return Object.fromEntries(Object.entries(details).filter(([key])=>allow.has(key)&&details[key]!==undefined));}
function logSession(message:string,details:Record<string,unknown>):void{if(!app.isReady())return;const directory=path.join(app.getPath('userData'),'logs'),line=JSON.stringify({time:new Date().toISOString(),level:'info',category:'playback-session',message,...safeLogDetails(details)})+'\n';void mkdir(directory,{recursive:true}).then(()=>appendFile(path.join(directory,'app.log'),line,'utf8')).catch(()=>undefined);}
function broadcast(snapshot:PlaybackSessionSnapshot):void{if(!app.isReady())return;for(const window of BrowserWindow.getAllWindows())if(!window.isDestroyed())window.webContents.send('playback:runtimeSessionChanged',snapshot);}
function patchSession(requestId:string,patch:Partial<PlaybackSessionSnapshot>,message='session updated',details:Record<string,unknown>={}):PlaybackSessionSnapshot|undefined{const result=patchPlayerRuntimeSession(requestId,patch);if(result)logSession(message,{generation:result.generation,sessionId:result.sessionId,requestId:result.requestId,loadId:result.loadId,initiator:result.initiator,status:result.status,...details});return result;}
function beginSession(domain:PlaybackDomain,meta:Partial<PlaybackSessionSnapshot>,initiator:PlaybackInitiator,windowId?:number):PlaybackSessionSnapshot{const previous=copySession(),next=beginPlayerRuntimeSession(domain,meta,initiator);if(previous.requestId&&previous.requestId!==next.requestId)logSession('playback intent superseded',{fromDomain:previous.domain,toDomain:domain,generation:previous.generation,sessionId:previous.sessionId,requestId:previous.requestId,loadId:previous.loadId,windowId,endReason:'replaced'});logSession('playback intent accepted',{fromDomain:previous.domain,toDomain:domain,generation:next.generation,sessionId:next.sessionId,requestId:next.requestId,initiator,windowId,accepted:true,...meta});return next;}
function failSession(requestId:string,error:string,windowId?:number):PlaybackSessionSnapshot|undefined{const result=failPlayerRuntimeSession(requestId,error);if(result)logSession('playback intent failed',{fromDomain:result.domain,toDomain:result.domain,generation:result.generation,sessionId:result.sessionId,requestId,loadId:result.loadId,windowId,endReason:'failed'});return result;}
function intentFromSession(session:PlaybackSessionSnapshot,windowId?:number):InvokeIntent{return{domain:session.domain as PlaybackDomain,requestId:session.requestId,initiator:session.initiator??'user',...(session.sourceId?{sourceId:session.sourceId}:{}),...(session.channelId?{channelId:session.channelId}:{}),...(session.routeIndex!==undefined?{routeIndex:session.routeIndex}:{}),...(session.routeCount!==undefined?{routeCount:session.routeCount}:{}),...(session.videoId?{videoId:session.videoId}:{}),...(session.episodeId?{episodeId:session.episodeId}:{}),...(session.trackId?{trackId:session.trackId}:{}),...(session.queueItemId?{queueItemId:session.queueItemId}:{}),...(windowId!==undefined?{windowId}:{})};}
function metaFromInput(input:Record<string,unknown>):Partial<PlaybackSessionSnapshot>{const sourceId=stringOf(input.sourceId),channelId=stringOf(input.channelId),videoId=stringOf(input.videoId),episodeId=stringOf(input.episodeId),trackId=stringOf(input.trackId),queueItemId=stringOf(input.queueItemId),routeIndex=numberOf(input.routeIndex),routeCount=numberOf(input.routeCount);return{...(sourceId?{sourceId}:{}),...(channelId?{channelId}:{}),...(videoId?{videoId}:{}),...(episodeId?{episodeId}:{}),...(trackId?{trackId}:{}),...(queueItemId?{queueItemId}:{}),...(routeIndex!==undefined?{routeIndex}:{}),...(routeCount!==undefined?{routeCount}:{})};}

function ensurePlayerHooks():void{
  const player=getCurrentPlayerClient();if(!player||hookedPlayers.has(player))return;hookedPlayers.add(player);
  const target=player as unknown as PlayerLike,originalLoad=target.load.bind(player),originalQuery=target.query.bind(player);
  target.load=async(request,onAccepted,context={})=>{
    const intent=invokeStorage.getStore();
    if(intent&&!isPlayerRuntimeCurrent(intent.requestId,intent.domain)){const current=copySession();logSession('stale player load rejected',{fromDomain:intent.domain,toDomain:current.domain,requestId:intent.requestId,windowId:intent.windowId,accepted:false,rejectedReason:'authoritative-session-changed'});throw new Error('[PLAYBACK_SUPERSEDED] 播放请求已被新的播放意图替代');}
    const intentContext=intent?{requestId:intent.requestId,initiator:intent.initiator,...(intent.sourceId?{sourceId:intent.sourceId}:{}),...(intent.channelId?{channelId:intent.channelId}:{}),...(intent.routeIndex!==undefined?{routeIndex:intent.routeIndex}:{}),...(intent.routeCount!==undefined?{routeCount:intent.routeCount}:{}),...(intent.videoId?{videoId:intent.videoId}:{}),...(intent.episodeId?{episodeId:intent.episodeId}:{}),...(intent.trackId?{trackId:intent.trackId}:{}),...(intent.queueItemId?{queueItemId:intent.queueItemId}:{})}:{};
    const mergedContext={...context,...intentContext};
    const result=await originalLoad(request,loadId=>{if(intent&&isPlayerRuntimeCurrent(intent.requestId,intent.domain)){mediaExpectations.set(player,{requestId:intent.requestId,loadId,url:request.url});logSession('player load accepted',{fromDomain:intent.domain,toDomain:intent.domain,requestId:intent.requestId,loadId,windowId:intent.windowId,accepted:true});}onAccepted?.(loadId);},mergedContext);
    if(intent&&isPlayerRuntimeCurrent(intent.requestId,intent.domain))logSession(result.ok?'player load opened':'player load rejected',{fromDomain:intent.domain,toDomain:intent.domain,requestId:intent.requestId,loadId:copySession().loadId,windowId:intent.windowId,accepted:result.ok,rejectedReason:result.ok?undefined:result.detail});
    return result;
  };
  target.query=async query=>{
    const result=await originalQuery(query);
    if(query==='stats'&&result&&typeof result==='object'&&!Array.isArray(result)){
      const stats=result as PlayerStats,expected=mediaExpectations.get(player),current=copySession(),out={...stats} as PlayerStats&Record<string,unknown>;
      if(expected&&current.loadId===expected.loadId&&current.requestId===expected.requestId){const identity=mediaIdentity(expected.url);if(identity?.startsWith('file:')&&!sameMediaPath(stats.path,expected.url))throw new Error('[PLAYBACK_STATS_PENDING] 本地媒体身份尚未确认');}
      return out;
    }
    return result;
  };
}

async function verifyNaturalEnd(session:PlaybackSessionSnapshot):Promise<{key:string}|undefined>{if(!session.requestId||!session.loadId||(session.domain!=='vod'&&session.domain!=='music'))return;ensurePlayerHooks();const player=getCurrentPlayerClient();if(!player)return;const state=await (player as unknown as PlayerLike).query('load-status').catch(()=>undefined),current=copySession();if(current.requestId!==session.requestId||current.loadId!==session.loadId||current.domain!==session.domain)return;if(!state||Array.isArray(state)||!('status' in state)||!('loadId' in state)||state.loadId!==session.loadId||state.status!=='ended'||state.error!=='eof')return;return{key:`${session.generation}:${session.requestId}:${session.loadId}`};}
async function preclaimNaturalEnd(domain:'vod'|'music',owner:number,requestId?:string,loadId?:string):Promise<boolean>{const session=copySession();if(session.domain!==domain||(requestId&&session.requestId!==requestId)||(loadId&&session.loadId!==loadId))return false;const verified=await verifyNaturalEnd(session);if(!verified)return false;const existing=naturalEndClaims.get(verified.key);if(existing)return false;naturalEndClaims.set(verified.key,{owner,stage:'claimed'});pruneClaims();logSession('natural eof claimed',{fromDomain:domain,toDomain:domain,requestId:session.requestId,loadId:session.loadId,windowId:owner,accepted:true,endReason:'eof'});return true;}
async function consumeNaturalEndForAutoNext(domain:'vod'|'music',owner:number,input:Record<string,unknown>):Promise<PlaybackSessionSnapshot>{const session=copySession();if(session.domain!==domain||!session.requestId||!session.loadId){logSession('auto-next rejected',{fromDomain:session.domain,toDomain:domain,windowId:owner,accepted:false,rejectedReason:'no-current-natural-end'});throw new Error('[PLAYBACK_SUPERSEDED] 当前播放会话已变化，已取消自动续播');}
  if(domain==='vod'){
    const validation=validateVodAutoNext(session,{sourceId:stringOf(input.sourceId),videoId:stringOf(input.videoId),episodeId:stringOf(input.episodeId),fromEpisodeId:stringOf(input.fromEpisodeId)});
    if(!validation.ok){logSession('auto-next rejected',{fromDomain:session.domain,toDomain:domain,requestId:session.requestId,loadId:session.loadId,windowId:owner,sourceId:session.sourceId,videoId:session.videoId,episodeId:session.episodeId,accepted:false,rejectedReason:`vod-auto-next-${validation.reason}`});throw new Error('[PLAYBACK_SUPERSEDED] 点播自动下一集来源与当前自然结束会话不一致，已取消续播');}
  }
  const verified=await verifyNaturalEnd(session);if(!verified)throw new Error('[PLAYBACK_SUPERSEDED] 当前媒体不是可消费的自然 EOF');const existing=naturalEndClaims.get(verified.key);if(existing){if(existing.owner!==owner||existing.stage!=='claimed')throw new Error('[PLAYBACK_SUPERSEDED] 当前 EOF 已由其他窗口消费');existing.stage='consumed';naturalEndClaims.set(verified.key,existing);}else naturalEndClaims.set(verified.key,{owner,stage:'consumed'});pruneClaims();logSession('auto-next eof consumed',{fromDomain:domain,toDomain:domain,requestId:session.requestId,loadId:session.loadId,windowId:owner,accepted:true,endReason:'eof'});return session;}

function installHistoryGuard():void{
  const originalAdd=DataService.prototype.addHistory,originalList=DataService.prototype.listHistory,originalUpdate=DataService.prototype.updateHistoryProgress;
  DataService.prototype.addHistory=function(this:DataService,entry:PlaybackHistoryEntry):void{const identity:HistoryIdentity={sourceId:entry.sourceId,videoId:entry.videoId,episodeId:entry.episodeId??''};historyIdentityById.set(entry.id,identity);latestHistoryByMedia.set(historyKey(identity),entry.id);return originalAdd.call(this,entry);};
  DataService.prototype.listHistory=function(this:DataService,limit=20):PlaybackHistoryEntry[]{const rows=originalList.call(this,limit);for(const entry of rows){const identity:HistoryIdentity={sourceId:entry.sourceId,videoId:entry.videoId,episodeId:entry.episodeId??''};historyIdentityById.set(entry.id,identity);const key=historyKey(identity);if(!latestHistoryByMedia.has(key))latestHistoryByMedia.set(key,entry.id);}return rows;};
  DataService.prototype.updateHistoryProgress=function(this:DataService,id:string,position:number,duration:number):boolean{const current=copySession(),identity=historyIdentityById.get(id),key=identity?historyKey(identity):'',allowed=canUpdateVodHistory(current,identity,latestHistoryByMedia.get(key),id);if(!allowed){logSession('history progress rejected',{fromDomain:current.domain,toDomain:current.domain,requestId:current.requestId,loadId:current.loadId,sourceId:current.sourceId,videoId:current.videoId,episodeId:current.episodeId,accepted:false,rejectedReason:'history-session-identity-mismatch'});return false;}return originalUpdate.call(this,id,position,duration);};
}

function installIpcRegistrationGuard():void{
  const target=ipcMain as unknown as {handle:(channel:string,listener:InvokeListener)=>void};
  target.handle=(channel,listener)=>{
    if(channel==='playback:play')return rawHandle(channel,async(event,...args)=>{requireLocalSender(event);ensurePlayerHooks();const input=recordOf(args[0]),owner=event.sender.id,initiator=initiatorOf(input.initiator);if(initiator==='auto-next')await consumeNaturalEndForAutoNext('vod',owner,input);const session=beginSession('vod',metaFromInput(input),initiator,owner),intent=intentFromSession(session,owner);try{return await invokeStorage.run(intent,()=>Promise.resolve(listener(event,...args)));}catch(error){if(isPlayerRuntimeCurrent(session.requestId,'vod'))failSession(session.requestId,error instanceof Error?error.message:String(error),owner);throw error;}});
    if(channel==='music:play')return rawHandle(channel,async(event,...args)=>{requireLocalSender(event);ensurePlayerHooks();const input=recordOf(args[0]),owner=event.sender.id,initiator=initiatorOf(input.initiator);if(initiator==='auto-next')await consumeNaturalEndForAutoNext('music',owner,input);const session=beginSession('music',metaFromInput(input),initiator,owner),intent=intentFromSession(session,owner);try{const result=await invokeStorage.run(intent,()=>Promise.resolve(listener(event,...args)));return result&&typeof result==='object'?{...(result as Record<string,unknown>),session:copySession()}:result;}catch(error){if(isPlayerRuntimeCurrent(session.requestId,'music'))failSession(session.requestId,error instanceof Error?error.message:String(error),owner);throw error;}});
    if(channel==='live:play')return rawHandle(channel,async(event,...args)=>{requireLocalSender(event);ensurePlayerHooks();const input=recordOf(args[0]),owner=event.sender.id,requestedId=stringOf(input.requestId),initiator=initiatorOf(input.initiator),meta=metaFromInput(input);let session=copySession();if(requestedId){if(!isPlayerRuntimeCurrent(requestedId,'live')){logSession('stale live route rejected',{fromDomain:'live',toDomain:session.domain,requestId:requestedId,windowId:owner,accepted:false,rejectedReason:'live-request-id-stale'});throw new Error('[PLAYBACK_SUPERSEDED] 直播线路请求已过期');}patchSession(requestedId,meta,'live route requested',{windowId:owner,routeIndex:meta.routeIndex});session=copySession();}else session=beginSession('live',meta,initiator,owner);const intent={...intentFromSession(session,owner),initiator,...meta} as InvokeIntent;try{const result=await invokeStorage.run(intent,()=>Promise.resolve(listener(event,...args)));if(result&&typeof result==='object'&&isPlayerRuntimeCurrent(session.requestId,'live')){const value=result as Record<string,unknown>,routeIndex=numberOf(value.routeIndex),routeCount=numberOf(value.routeCount);patchSession(session.requestId,{...(routeIndex!==undefined?{routeIndex}:{}),...(routeCount!==undefined?{routeCount}:{})},'live route result',{windowId:owner,routeIndex,routeCount,accepted:value.ok===true});}return result;}catch(error){if(isPlayerRuntimeCurrent(session.requestId,'live')&&initiator!=='auto-route')failSession(session.requestId,error instanceof Error?error.message:String(error),owner);throw error;}});
    if(channel==='playback:control')return rawHandle(channel,async(event,...args)=>{const before=copySession(),result=await Promise.resolve(listener(event,...args)),value=recordOf(args[0]);if(result&&typeof result==='object'&&(result as Record<string,unknown>).ok===true)logSession('playback control',{fromDomain:before.domain,toDomain:copySession().domain,requestId:before.requestId,loadId:before.loadId,windowId:event.sender.id,status:String(value.command??'')});return result;});
    if(channel==='diagnostics:get')return rawHandle(channel,async(event,...args)=>{const result=await Promise.resolve(listener(event,...args));return result&&typeof result==='object'?{...(result as Record<string,unknown>),playbackSession:copySession(),playbackNaturalEndClaims:naturalEndClaims.size}:result;});
    return rawHandle(channel,listener);
  };
}

installHistoryGuard();
installIpcRegistrationGuard();
onPlayerRuntimeSession(snapshot=>{broadcast(snapshot);});

export function registerPlaybackSessionIpc():void{
  if(registered)return;registered=true;
  rawHandle('playback:runtimeSession',event=>{requireLocalSender(event);ensurePlayerHooks();return copySession();});
  rawHandle('playback:beginIntent',(event,input)=>{requireLocalSender(event);ensurePlayerHooks();const value=recordOf(input),domain=value.domain;if(domain!=='vod'&&domain!=='live'&&domain!=='music')throw new Error('Invalid playback domain');return beginSession(domain,metaFromInput(value),initiatorOf(value.initiator),event.sender.id);});
  rawHandle('playback:failIntent',(event,input)=>{requireLocalSender(event);const value=recordOf(input),requestId=stringOf(value.requestId),error=stringOf(value.error)??'Playback intent failed';if(!requestId)return false;return Boolean(failSession(requestId,error,event.sender.id));});
  rawHandle('playback:recordRoute',(event,input)=>{requireLocalSender(event);const value=recordOf(input),requestId=stringOf(value.requestId);if(!requestId||!isPlayerRuntimeCurrent(requestId,'live'))return false;const before=numberOf(value.routeBefore),after=numberOf(value.routeAfter),sourceId=stringOf(value.sourceId),channelId=stringOf(value.channelId);patchSession(requestId,{...(after!==undefined?{routeIndex:after}:{}),...(sourceId?{sourceId}:{}),...(channelId?{channelId}:{})},'live route switched',{windowId:event.sender.id,sourceId,channelId,routeBefore:before,routeAfter:after,initiator:initiatorOf(value.initiator,'auto-route'),accepted:true});return true;});
  rawHandle('playback:claimNaturalEnd',async(event,input)=>{requireLocalSender(event);const value=recordOf(input),domain=value.domain,loadId=stringOf(value.loadId),requestId=stringOf(value.requestId);if(domain!=='vod'&&domain!=='music')return false;return preclaimNaturalEnd(domain,event.sender.id,requestId,loadId);});
}

registerPlaybackSessionIpc();

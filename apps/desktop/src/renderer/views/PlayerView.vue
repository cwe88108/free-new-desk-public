<script setup lang="ts">
import { computed,nextTick,onBeforeUnmount,onMounted,ref,watch } from 'vue';
import { onBeforeRouteLeave,useRouter } from 'vue-router';
import AppIcon from '../components/AppIcon.vue';
import type { PlaybackHistoryEntry,PlayerLoadStatus,PlayerStats,PlayerTrack } from '@free-new-desk/contracts';
import { createNativeSurfaceLease,type NativeSurfaceLease } from '../native-surface';
import { onPlaybackStage } from '../playback-events';
import { usePlaybackSessionStore,clockStats,clockStale,clockLoadStatus,clockRuntime,refreshPlaybackClock } from '../stores/playback-session';

type RuntimeSession={generation:number;requestId:string;domain:'vod'|'live'|'music'|null;status:string;loadId?:string;historyId?:string;sourceId?:string;videoId?:string;episodeId?:string;trackId?:string;controlRevision?:number;url?:string;error?:string;updatedAt:number};
type SessionStats=PlayerStats&{domain?:'vod'|'live'|'music'|null;requestId?:string;sessionGeneration?:number;sessionStatus?:string;sessionLoadId?:string};
type PendingVodPlayback={requestId:string;createdAt:number;request:{sourceId:string;videoId:string;videoName:string;flag:string;episodeId:string;episodeName:string;poster?:string;episodeListJson:string;};sourceName:string;};
type PendingEpisode={flag:string;id:string;name:string};
const router=useRouter();const playbackSession=usePlaybackSessionStore();
const surface=ref<HTMLElement|null>(null);const paused=ref(false);const muted=ref(false);const volume=ref(100);const hwdecEnabled=ref(localStorage.getItem('player.hwdec')!=='off');const surfaceError=ref('');const playbackError=ref('');const playbackCode=ref('');const volumeTouched=ref(false);const autoNext=ref(true);const lastFailed=ref<PlaybackHistoryEntry|null>(null);const lastFailedPending=ref<PendingVodPlayback|null>(null);const draggedIndex=ref(-1);const speed=ref(1);const pip=ref(false);const fullscreen=ref(false);const subtitlePath=ref('');const subtitleDelay=ref(0);const audioDelay=ref(0);const aspect=ref('no');const status=ref('');const stats=ref<SessionStats|null>(null);const tracks=ref<PlayerTrack[]>([]);const loadStatus=ref<PlayerLoadStatus|null>(null);const runtimeSession=ref<RuntimeSession>({generation:0,requestId:'',domain:null,status:'idle',updatedAt:0});const queue=ref<PlaybackHistoryEntry[]>([]);const queuePersisted=ref(false);const diagnostics=ref<Record<string,string|number>>({});const seekValue=ref(0);const seeking=ref(false);const controlsHidden=ref(false);const stageHover=ref(false);let allowSurfaceSync=true;let surfaceLease:NativeSurfaceLease|undefined;let controlsIdleTimer:ReturnType<typeof setTimeout>|undefined;let removePlaybackStage:(()=>void)|undefined;let removeBackendStage:(()=>void)|undefined;let removeFullscreenChanged:(()=>void)|undefined;let removeRuntimeSessionChanged:(()=>void)|undefined;let removeOverlayAction:(()=>void)|undefined;let bufferingStarted=0;let videoMetadataStarted=0;let autoAdvanceLocked=false;let consumedEofLoadId='';let lastProgressPersist=0;let timer:ReturnType<typeof setInterval>|undefined;let surfaceTimer:ReturnType<typeof setInterval>|undefined;let observer:ResizeObserver|undefined;let surfaceRaf=0;let lastSurfaceError='';
const actualDomain=computed(()=>runtimeSession.value.domain??stats.value?.domain??null);
const liveRetrying=ref(false);
let tracksRefresh:Pick<RuntimeSession,'generation'|'requestId'|'loadId'>|undefined;
let liveBufferProbe:{loadId:string;position:number;since:number}|undefined;
const liveBufferingLoadId=ref('');
const liveBuffering=computed(()=>!paused.value&&!seeking.value&&!clockStale.value&&
  runtimeSession.value.status==='playing'&&Boolean(liveBufferingLoadId.value)&&
  liveBufferingLoadId.value===runtimeSession.value.loadId);
function updateLiveBuffering(sample:SessionStats|null){
  const loadId=sample?.loadId;
  if(!loadId||actualDomain.value!=='live'||runtimeSession.value.status!=='playing'||
    sample.sampleFresh!==true||sample.samplePositionStable===false||sample.paused||seeking.value||
    sample.position<=0||sample.cacheDuration>0.1){
    liveBufferProbe=undefined;
    liveBufferingLoadId.value='';
    return;
  }
  // The live profile keeps mpv's cache pause disabled. Confirm starvation with the playback clock.
  const now=performance.now();
  if(liveBufferProbe?.loadId!==loadId||Math.abs(liveBufferProbe.position-sample.position)>=0.1){
    liveBufferProbe={loadId,position:sample.position,since:now};
    liveBufferingLoadId.value='';
    return;
  }
  if(now-liveBufferProbe.since>=1500)liveBufferingLoadId.value=loadId;
}
const isVod=computed(()=>actualDomain.value==='vod');
const audioTracks=computed(()=>tracks.value.filter(track=>track.type==='audio'));
const subtitleTracks=computed(()=>tracks.value.filter(track=>track.type==='sub'));
const resolution=computed(()=>stats.value?.width&&stats.value?.height?stats.value.width+' × '+stats.value.height:'—');
function videoSurfaceStatus():string{
  if(actualDomain.value==='music')return '音乐模式，无视频窗口';
  const sample=stats.value,current=runtimeSession.value;
  if(!sample||sample.sampleFresh!==true||sample.requestId!==current.requestId||(current.loadId&&sample.loadId!==current.loadId))return '等待当前会话的画面诊断';
  const surface=sample.videoSurface;
  if(!surface)return '当前内核未提供窗口诊断';
  if(!surface.windowExists)return '视频窗口不存在，请重新挂载';
  if(!surface.requestedVisible)return '视频窗口当前未请求显示';
  if(surface.mode==='embedded'){
    if(!surface.parentExists||!surface.parentMatches)return '视频窗口未挂到当前应用窗口，请重新挂载';
    if(!surface.parentVisible)return '应用窗口已隐藏或最小化';
    if(!surface.withinParent)return '视频区域超出应用窗口，请重新挂载';
  }
  if(surface.width<2||surface.height<2)return '视频窗口尺寸异常，请重新挂载';
  if(!surface.windowVisible)return '视频窗口处于隐藏状态，请重新挂载';
  return '窗口显示条件满足；实际画面仍需确认';
}
const videoSurfaceMessage=computed(videoSurfaceStatus);
const boundHistory=ref<PlaybackHistoryEntry|null>(null);
async function refreshBoundHistory(){
  const {requestId,historyId,domain}=runtimeSession.value;
  boundHistory.value=null;
  if(domain!=='vod'||!historyId)return;
  try{
    const rows=await window.desktop.history.list(200);
    if(!allowSurfaceSync||runtimeSession.value.requestId!==requestId||runtimeSession.value.historyId!==historyId)return;
    boundHistory.value=rows.find(item=>item.id===historyId)??null;
  }catch{/* Playback remains usable if presentation metadata cannot be read. */}
}
watch([()=>runtimeSession.value.requestId,()=>runtimeSession.value.historyId],()=>{void refreshBoundHistory();},{immediate:true});
const currentQueueEntry=computed(()=>{if(!isVod.value)return null;const session=runtimeSession.value;if(boundHistory.value?.id===session.historyId&&boundHistory.value?.sourceId===session.sourceId&&boundHistory.value?.videoId===session.videoId&&boundHistory.value?.episodeId===session.episodeId)return boundHistory.value;if(session.sourceId&&session.videoId&&session.episodeId){return queue.value.find(item=>item.sourceId===session.sourceId&&item.videoId===session.videoId&&item.episodeId===session.episodeId)??null;}const currentPath=stats.value?.path;return currentPath?queue.value.find(item=>item.url===currentPath)??null:null;});
const currentEpisodes=computed(()=>currentQueueEntry.value?.episodes??[]);
const pendingEpisodes=computed<PendingEpisode[]>(()=>{try{const value=JSON.parse(lastFailedPending.value?.request.episodeListJson??'[]') as unknown;return Array.isArray(value)?value.filter((item):item is PendingEpisode=>Boolean(item&&typeof item==='object'&&typeof(item as PendingEpisode).flag==='string'&&typeof(item as PendingEpisode).id==='string'&&typeof(item as PendingEpisode).name==='string')):[];}catch{return[];}});
const activeEpisodes=computed(()=>currentEpisodes.value.length?currentEpisodes.value:pendingEpisodes.value);
const currentEpisodeIndex=computed(()=>{const current=currentQueueEntry.value;if(!current?.episodeId)return-1;return currentEpisodes.value.findIndex(item=>item.id===current.episodeId&&(!current.flag||item.flag===current.flag));});
const canPrevious=computed(()=>isVod.value&&currentEpisodeIndex.value>0);
const canNext=computed(()=>isVod.value&&currentEpisodeIndex.value>=0&&currentEpisodeIndex.value<currentEpisodes.value.length-1);
const routeFlags=computed(()=>[...new Set(activeEpisodes.value.map(item=>item.flag))]);
const nextRouteFlag=computed(()=>{if(!isVod.value&&!lastFailedPending.value)return'';const flags=routeFlags.value;if(flags.length<2)return'';const current=currentQueueEntry.value?.flag??lastFailedPending.value?.request.flag??flags[0]!;const position=flags.indexOf(current);return flags[(position+1)%flags.length]??'';});
const failureSourceName=computed(()=>currentQueueEntry.value?.sourceName??lastFailedPending.value?.sourceName??'—');
const failureFlag=computed(()=>currentQueueEntry.value?.flag??lastFailedPending.value?.request.flag??'—');
function playbackCodeOf(message:string){return /^\[(P\d{4})\]/.exec(message)?.[1]??'';}
function stripPlaybackCode(message:string){return message.replace(/^\[(P\d{4})\]\s*/,'');}
function formatTime(value:number|undefined){const total=Math.max(0,Math.floor(value??0));const h=Math.floor(total/3600),m=Math.floor((total%3600)/60),s=total%60;return(h?h.toString().padStart(2,'0')+':':'')+m.toString().padStart(2,'0')+':'+s.toString().padStart(2,'0');}
function formatRate(value:number|undefined){return value&&value>0?(value/1000).toFixed(value>1000000?0:1)+' kbps':'—';}
function formatBytes(value:number|undefined){if(!value||value<=0)return'—';const units=['B','KB','MB','GB'];let n=value,i=0;while(n>=1024&&i<units.length-1){n/=1024;i++;}return n.toFixed(i?1:0)+' '+units[i];}
function applyRuntime(value:RuntimeSession){if(value.generation<runtimeSession.value.generation||(value.generation===runtimeSession.value.generation&&value.updatedAt<runtimeSession.value.updatedAt))return;if(value.requestId!==runtimeSession.value.requestId||value.loadId!==runtimeSession.value.loadId||value.status==='stopped'){stats.value=null;tracks.value=[];loadStatus.value=null;}runtimeSession.value=value;if(value.status==='stopped'){paused.value=true;seekValue.value=0;seeking.value=false;pip.value=false;fullscreen.value=false;}if(value.status==='paused'||value.status==='playing')paused.value=value.status==='paused';if(value.status==='failed'&&value.error&&(value.domain==='live'||value.error.startsWith('[PLAYER_TRANSPORT_FAILED]'))){playbackError.value=value.error;playbackCode.value=value.error.startsWith('[PLAYER_TRANSPORT_FAILED]')?'PLAYER_TRANSPORT_FAILED':playbackCodeOf(value.error);status.value=value.error;}if(value.domain!=='vod'){lastFailed.value=null;autoAdvanceLocked=false;consumedEofLoadId='';}}
let lastHistorySample:{requestId:string;loadId:string;sampleSeq:number;seekRevision:number}|undefined;
function persistCurrentHistoryProgress(sample:SessionStats){
  const current=runtimeSession.value;
  if(current.domain!=='vod'||!current.historyId||!current.requestId||!current.loadId||sample.requestId!==current.requestId||sample.loadId!==current.loadId||sample.sampleFresh!==true||sample.samplePositionStable===false)return;
  const sampleSeq=sample.sampleSeq,seekRevision=sample.seekRevision;
  if(!Number.isSafeInteger(sampleSeq)||sampleSeq===undefined||sampleSeq<1||!Number.isSafeInteger(seekRevision)||seekRevision===undefined||seekRevision<0)return;
  if(lastHistorySample?.requestId===current.requestId&&lastHistorySample.loadId===current.loadId&&(sampleSeq<=lastHistorySample.sampleSeq||seekRevision<lastHistorySample.seekRevision))return;
  lastHistorySample={requestId:current.requestId,loadId:current.loadId,sampleSeq,seekRevision};
  if(Date.now()-lastProgressPersist<5000)return;
  lastProgressPersist=Date.now();
  // The ID is bound only after the main process inserts this playback's row.
  // Never substitute a saved queue ID or guess the latest row by wall-clock time.
  void window.desktop.history.updateProgress(current.historyId,sample.position,sample.duration).catch(()=>undefined);
}
function refreshTracks(){
  const {generation,requestId,loadId,status}=runtimeSession.value;
  if(!requestId||!loadId||status==='stopped'||status==='ended'||status==='failed')return;
  if(tracksRefresh?.generation===generation&&tracksRefresh.requestId===requestId&&tracksRefresh.loadId===loadId)return;
  const pending={generation,requestId,loadId};
  tracksRefresh=pending;
  void window.desktop.playback.query('tracks').then(result=>{
    if(tracksRefresh!==pending)return;
    const current=runtimeSession.value;
    if(current.generation===generation&&current.requestId===requestId&&current.loadId===loadId&&current.status!=='stopped'){
      tracks.value=result;
    }
  }).catch(()=>{/* A subsequent refresh can retry tracks independently. */}).finally(()=>{
    if(tracksRefresh===pending)tracksRefresh=undefined;
  });
}
async function refresh(){try{
  applyRuntime(clockRuntime.value);
  if(runtimeSession.value.status==='stopped')return;
  loadStatus.value=clockLoadStatus.value;
  refreshTracks();
  const nextStats=clockStale.value?null:clockStats.value;
  if(!nextStats||nextStats.requestId!==runtimeSession.value.requestId||!runtimeSession.value.loadId||nextStats.loadId!==runtimeSession.value.loadId){
    updateLiveBuffering(null);
    const currentLoadId=runtimeSession.value.loadId??'';
    const terminal=isVod.value&&loadStatus.value?.status==='ended'&&loadStatus.value.error==='eof'&&Boolean(currentLoadId)&&loadStatus.value.loadId===currentLoadId;
    if(terminal&&autoNext.value&&canNext.value&&consumedEofLoadId!==currentLoadId&&!autoAdvanceLocked){consumedEofLoadId=currentLoadId;autoAdvanceLocked=true;void playAdjacent(1,'auto-next').finally(()=>{autoAdvanceLocked=false;});}
    return;
  }
  stats.value=nextStats;const freshState=nextStats.sampleFresh===true,stablePosition=freshState&&nextStats.samplePositionStable!==false;
  updateLiveBuffering(nextStats);
  if(freshState){fullscreen.value=Boolean(nextStats.fullscreen);pip.value=Boolean(nextStats.pip);paused.value=nextStats.paused;muted.value=nextStats.muted;if(!volumeTouched.value){const persisted=Number(localStorage.getItem('player.volume'));volume.value=Number.isFinite(persisted)&&localStorage.getItem('player.volume')!==null?Math.min(100,Math.max(0,Math.round(persisted))):Math.min(100,Math.round(nextStats.volume));if(localStorage.getItem('player.volume')!==null&&Math.abs(volume.value-nextStats.volume)>=1)void command({command:'volume',value:volume.value});}else volume.value=Math.min(100,Math.round(nextStats.volume));speed.value=nextStats.speed;}
  if(stablePosition&&(nextStats.duration??0)>0&&mediaSwitching.value)markSwitching(false);
  if(stablePosition){if(nextStats.pausedForCache&&!bufferingStarted){bufferingStarted=performance.now();void window.desktop.diagnostics.recordPerformance('bufferingCount',1).catch(()=>false);}else if(!nextStats.pausedForCache&&bufferingStarted){void window.desktop.diagnostics.recordPerformance('bufferingDurationMs',performance.now()-bufferingStarted).catch(()=>false);bufferingStarted=0;}if(videoMetadataStarted&&isVod.value&&(nextStats.width??0)>0&&(nextStats.height??0)>0){void window.desktop.diagnostics.recordPerformance('videoMetadataReadyMs',performance.now()-videoMetadataStarted).catch(()=>false);videoMetadataStarted=0;}if(!seeking.value)seekValue.value=nextStats.position;const current=currentQueueEntry.value;if(isVod.value&&nextStats.duration>0){if(current){current.position=nextStats.position;current.duration=nextStats.duration;}persistCurrentHistoryProgress(nextStats);}}
  const currentLoadId=runtimeSession.value.loadId??nextStats.sessionLoadId??'';const naturalEof=isVod.value&&loadStatus.value?.status==='ended'&&loadStatus.value.error==='eof'&&Boolean(currentLoadId)&&loadStatus.value.loadId===currentLoadId;
  if(naturalEof&&autoNext.value&&canNext.value&&consumedEofLoadId!==currentLoadId&&!autoAdvanceLocked){consumedEofLoadId=currentLoadId;autoAdvanceLocked=true;void playAdjacent(1,'auto-next').finally(()=>{autoAdvanceLocked=false;});}
}catch{/* PlayerHost may be starting or shared samples may be stale while it starts. */}}

async function command(value:Parameters<typeof window.desktop.playback.control>[0]):Promise<boolean>{try{const result=await window.desktop.playback.control({...value,requestId:value.requestId??runtimeSession.value.requestId});if(!result.ok)throw new Error(result.detail??'命令失败');status.value='操作已确认';playbackError.value='';playbackCode.value='';await refreshPlaybackClock().catch(()=>undefined);await refresh();return true;}catch(error){playbackError.value=error instanceof Error?error.message:String(error);playbackCode.value=playbackCodeOf(playbackError.value);status.value=playbackError.value;return false;}}
const removeAfterNavigation=router.afterEach((_to,_from,failure)=>{if(failure&&!allowSurfaceSync){allowSurfaceSync=true;scheduleSurfaceSync();}});
async function releaseSurface(){const lease=surfaceLease;if(!lease)return;try{await lease.release();if(surfaceLease===lease)surfaceLease=undefined;surfaceError.value='';}catch(error){surfaceError.value='播放器区域隐藏失败：'+(error instanceof Error?error.message:String(error));throw error;}}
async function syncSurface(visible=true){const element=surface.value;if(!allowSurfaceSync||!element)return;if(actualDomain.value==='music'||runtimeSession.value.status==='stopped'){await releaseSurface().catch(()=>undefined);return;}if(visible&&(pip.value||fullscreen.value))return;const rect=element.getBoundingClientRect();if(rect.width<1||rect.height<1)return;surfaceLease??=createNativeSurfaceLease('player-view');const lease=surfaceLease;try{const syncStarted=performance.now();const ok=await lease.sync({x:Math.round(rect.left),y:Math.round(rect.top),width:Math.max(1,Math.round(rect.width)),height:Math.max(1,Math.round(rect.height))},visible);void window.desktop.diagnostics.recordPerformance('surfaceSyncMs',performance.now()-syncStarted).catch(()=>false);if(lease!==surfaceLease)return;if(!ok&&visible)throw new Error('PlayerHost rejected window sync');surfaceError.value='';if(lastSurfaceError){lastSurfaceError='';if(status.value.startsWith('播放器区域同步异常：'))status.value='';}}catch(value){if(lease!==surfaceLease)return;const message=value instanceof Error?value.message:String(value);surfaceError.value='播放器区域同步异常：'+message;if(message!==lastSurfaceError){lastSurfaceError=message;status.value='播放器区域同步异常：'+message;}}}
function scheduleSurfaceSync(){if(surfaceRaf)return;surfaceRaf=requestAnimationFrame(()=>{surfaceRaf=0;void syncSurface();});}
async function seekAbsolute(){seeking.value=false;await command({command:'seek',value:seekValue.value,absolute:true});}
async function toggleHwdec(){const next=!hwdecEnabled.value,mode=next?'auto-safe':'no';if(!await command({command:'hwdec',value:mode}))return;hwdecEnabled.value=next;localStorage.setItem('player.hwdec',next?'on':'off');try{await window.desktop.settings.set('player.hwdec',mode);}catch(error){status.value='硬解已应用，但偏好保存失败：'+(error instanceof Error?error.message:String(error));}window.dispatchEvent(new CustomEvent('fnd:render-mode',{detail:mode}));}
async function togglePause(){const next=!paused.value;if(await command({command:'pause',value:next}))paused.value=next;}async function toggleMute(){const next=!muted.value;if(await command({command:'mute',value:next}))muted.value=next;}async function togglePip(){if(actualDomain.value==='music')return;const next=!pip.value;if(!await command({command:'pip',value:next}))return;pip.value=next;playbackSession.update({pip:next});if(!next){await nextTick();scheduleSurfaceSync();}}async function toggleFullscreen(){if(actualDomain.value==='music')return;const next=!fullscreen.value;if(!await command({command:'fullscreen',value:next}))return;fullscreen.value=next;playbackSession.update({fullscreen:next});if(!next){await nextTick();scheduleSurfaceSync();}}async function screenshot(){if(actualDomain.value==='music'){status.value='音乐播放不提供视频截图。';return;}try{const result=await window.desktop.playback.screenshot();status.value='截图已保存：'+result.path;}catch(error){status.value=error instanceof Error?error.message:String(error);}}
function readPendingPlayback():PendingVodPlayback|null{try{const value=JSON.parse(localStorage.getItem('vod.pendingPlayback')??'null') as Partial<PendingVodPlayback>|null;const request=value?.request;if(!request||typeof value?.requestId!=='string'||typeof value?.createdAt!=='number'||Date.now()-value.createdAt>6*60*60*1000||typeof value?.sourceName!=='string'||typeof request.sourceId!=='string'||typeof request.videoId!=='string'||typeof request.videoName!=='string'||typeof request.flag!=='string'||typeof request.episodeId!=='string'||typeof request.episodeName!=='string'||typeof request.episodeListJson!=='string'){localStorage.removeItem('vod.pendingPlayback');return null;}return{requestId:value.requestId,createdAt:value.createdAt,sourceName:value.sourceName,request};}catch{localStorage.removeItem('vod.pendingPlayback');return null;}}
function replayable(item:PlaybackHistoryEntry){return Boolean(item.flag&&item.episodeId);}
async function resumePendingPlayback(value:PendingVodPlayback){
  try{
    const source=(await window.desktop.source.list()).find(item=>item.id===value.request.sourceId&&item.enabled);if(!source){localStorage.removeItem('vod.pendingPlayback');lastFailedPending.value=null;status.value='原失败请求的来源已删除或停用，请重新选择来源。';return;}
    const current=readPendingPlayback();if(!current||current.requestId!==value.requestId){lastFailedPending.value=current;status.value='旧的失败请求已经过期或被新的播放意图替代。';return;}
    await window.desktop.playback.play({...value.request,initiator:'user'});
    localStorage.removeItem('vod.pendingPlayback');
    lastFailedPending.value=null;lastFailed.value=null;playbackError.value='';playbackCode.value='';status.value='已重新解析并播放：'+value.request.videoName+' · '+value.request.episodeName;
    if(!queuePersisted.value)queue.value=await window.desktop.history.list(8);await nextTick();scheduleSurfaceSync();
  }catch(error){const message=error instanceof Error?error.message:String(error);if(message.includes('PLAYBACK_SUPERSEDED'))return;lastFailedPending.value=value;playbackError.value=message;playbackCode.value=playbackCodeOf(message);status.value=message;}
}
async function resumeQueueItem(item:PlaybackHistoryEntry,initiator:'user'|'auto-next'|'history'='history',fromEpisodeId?:string){if(!item.flag||!item.episodeId){status.value='该记录来自旧版本，缺少重播参数；请从点播详情重新播放一次。';return;}try{await window.desktop.playback.play({sourceId:item.sourceId,videoId:item.videoId,videoName:item.videoName,flag:item.flag,episodeId:item.episodeId,episodeName:item.episodeName,initiator,...(initiator==='auto-next'&&fromEpisodeId?{fromEpisodeId,parentRequestId:runtimeSession.value.requestId,expectedLoadId:runtimeSession.value.loadId,expectedControlRevision:runtimeSession.value.controlRevision??0}:{}),...(item.poster?{poster:item.poster}:{}),...(item.episodes?.length?{episodeListJson:JSON.stringify(item.episodes)}:{})});if(!queuePersisted.value)queue.value=await window.desktop.history.list(8);consumedEofLoadId='';lastFailed.value=null;playbackError.value='';playbackCode.value='';status.value='已继续播放：'+item.videoName+' · '+item.episodeName;await nextTick();scheduleSurfaceSync();}catch(error){const message=error instanceof Error?error.message:String(error);if(message.includes('PLAYBACK_SUPERSEDED'))return;lastFailed.value=item;playbackError.value=message;playbackCode.value=playbackCodeOf(playbackError.value);status.value=playbackError.value;}}
async function retryPlayback(){if(actualDomain.value==='live'){if(liveRetrying.value)return;liveRetrying.value=true;try{await window.desktop.live.retry(runtimeSession.value.requestId);}catch{/* The active playback session publishes its failure. */}finally{liveRetrying.value=false;}return;}if(lastFailedPending.value)await resumePendingPlayback(lastFailedPending.value);else if(lastFailed.value)await resumeQueueItem(lastFailed.value,'user');else status.value='没有可重试的点播请求，请从点播详情重新播放。';}
async function switchRoute(){
  const flag=nextRouteFlag.value;
  if(!flag)return;
  const pending=lastFailedPending.value;
  if(pending&&!currentQueueEntry.value){
    const episode=matchEpisodeForFlag(activeEpisodes.value,flag,pending.request.episodeId,pending.request.episodeName);
    if(!episode){status.value='无法可靠匹配其他线路中的同一集，请返回点播详情手动选择线路和剧集。';return;}
    status.value=`切换到线路「${flag}」…`;
    await resumePendingPlayback({...pending,request:{...pending.request,flag:episode.flag,episodeId:episode.id,episodeName:episode.name}});
    return;
  }
  const base=lastFailed.value??currentQueueEntry.value;
  if(!base)return;
  const episode=matchEpisodeForFlag(currentEpisodes.value,flag,base.episodeId,base.episodeName);
  if(!episode){status.value='无法可靠匹配其他线路中的同一集，请返回点播详情手动选择线路和剧集。';return;}
  status.value=`切换到线路「${flag}」…`;
  await resumeQueueItem({...base,flag:episode.flag,episodeId:episode.id,episodeName:episode.name},'user');
}
function openDiagnostics(){void router.push('/settings?section=diagnostics');}
function normalizedEpisodeIdentity(value:string):string{return value.normalize('NFKC').trim().toLowerCase().replace(/\s+/g,' ');}
function matchEpisodeForFlag(episodes:PendingEpisode[],flag:string,episodeId:string|undefined,episodeName:string|undefined):PendingEpisode|undefined{const candidates=episodes.filter(item=>item.flag===flag);if(episodeId){const exact=candidates.filter(item=>item.id===episodeId);if(exact.length===1)return exact[0];}if(episodeName){const key=normalizedEpisodeIdentity(episodeName),named=candidates.filter(item=>normalizedEpisodeIdentity(item.name)===key);if(named.length===1)return named[0];}return undefined;}
async function playAdjacent(offset:number,initiator:'user'|'auto-next'='user'){if(!isVod.value)return;const base=currentQueueEntry.value,index=currentEpisodeIndex.value;if(!base||index<0)return;const episode=currentEpisodes.value[index+offset];if(!episode)return;await resumeQueueItem({...base,flag:episode.flag,episodeId:episode.id,episodeName:episode.name},initiator,initiator==='auto-next'?base.episodeId:undefined);}
async function saveQueue(){try{await window.desktop.settings.set('player.savedQueue',JSON.stringify(queue.value));queuePersisted.value=true;status.value='播放队列已保存到本机设置。';}catch(error){status.value='保存播放队列失败：'+(error instanceof Error?error.message:String(error));}}
async function clearQueue(){if(!window.confirm('确认清空当前播放队列？播放历史不会被删除。'))return;try{await window.desktop.settings.set('player.savedQueue','[]');queue.value=[];queuePersisted.value=true;status.value='已清空并保存当前播放队列（不会删除播放历史）。';}catch(error){status.value='清空播放队列失败，当前队列保持不变：'+(error instanceof Error?error.message:String(error));}}
function dropQueue(target:number){const source=draggedIndex.value;if(source<0||source===target)return;const next=[...queue.value];const moved=next.splice(source,1)[0];if(moved)next.splice(target,0,moved);queue.value=next;draggedIndex.value=-1;void saveQueue();}
async function persistVolume(){volumeTouched.value=true;const requested=volume.value;if(await command({command:'volume',value:requested}))localStorage.setItem('player.volume',String(requested));else volume.value=Math.min(100,Math.round(stats.value?.volume??requested));}
function wakeControls(){controlsHidden.value=false;if(controlsIdleTimer)clearTimeout(controlsIdleTimer);if(!stageHover.value)return;controlsIdleTimer=setTimeout(()=>{if(seeking.value||stageHover.value)return;if(paused.value)return;controlsHidden.value=true;},3000);}
const mediaSwitching=ref(false);let switchTimer:ReturnType<typeof setTimeout>|undefined;
const switchTitle=computed(()=>currentQueueEntry.value?.videoName??lastFailedPending.value?.request.videoName??'准备播放');
const switchSubtitle=computed(()=>currentQueueEntry.value?.episodeName?`${currentQueueEntry.value.episodeName} · 正在解析片源…`:'正在解析片源…');
function markSwitching(active:boolean){
  if(switchTimer){clearTimeout(switchTimer);switchTimer=undefined;}
  if(active){if(!mediaSwitching.value){mediaSwitching.value=true;void syncSurface(false);}return;}
  switchTimer=setTimeout(()=>{mediaSwitching.value=false;scheduleSurfaceSync();},300);
}
function clearPendingPlayback(requestId:string){try{const pending=JSON.parse(localStorage.getItem('vod.pendingPlayback')??'null') as {requestId?:string}|null;if(pending?.requestId===requestId)localStorage.removeItem('vod.pendingPlayback');}catch{localStorage.removeItem('vod.pendingPlayback');}}
const displayDuration=computed(()=>{if(runtimeSession.value.status==='stopped')return 0;const sampled=stats.value?.duration??0;if(sampled>0)return sampled;const queued=currentQueueEntry.value?.duration??0;return queued>0?queued:0;});
const durationReady=computed(()=>displayDuration.value>0);
const playPercent=computed(()=>{const total=displayDuration.value;if(!total)return 0;return Math.min(100,Math.max(0,seekValue.value/total*100));});
const bufferPercent=computed(()=>{const total=displayDuration.value;if(!total)return 0;const buffered=stats.value?.cacheDuration??0;return Math.min(100,Math.max(0,Math.round(buffered/total*100)));});
async function persistSpeed(){const requested=speed.value;if(!await command({command:'speed',value:requested}))speed.value=stats.value?.speed??1;}
function keydown(event:KeyboardEvent){const target=event.target as HTMLElement|null;if(target&&['INPUT','SELECT','TEXTAREA'].includes(target.tagName))return;if(event.key==='Escape'&&fullscreen.value){event.preventDefault();void toggleFullscreen();return;}if(event.code==='Space'){event.preventDefault();void togglePause();}else if(event.key==='ArrowLeft')void command({command:'seek',value:-10});else if(event.key==='ArrowRight')void command({command:'seek',value:10});else if(event.key==='ArrowUp'){volume.value=Math.min(100,volume.value+5);void persistVolume();}else if(event.key==='ArrowDown'){volume.value=Math.max(0,volume.value-5);void persistVolume();}else if(event.key.toLowerCase()==='f'&&actualDomain.value!=='music')void toggleFullscreen();else if(event.key.toLowerCase()==='m')void toggleMute();else if(event.key.toLowerCase()==='p'&&actualDomain.value!=='music')void togglePip();}
onMounted(async()=>{lastFailedPending.value=readPendingPlayback();window.addEventListener('keydown',keydown);removeRuntimeSessionChanged=window.desktop.playback.onRuntimeSessionChanged(value=>{applyRuntime(value);if(runtimeSession.value.domain==='music')void releaseSurface().catch(()=>undefined);else void nextTick().then(()=>scheduleSurfaceSync());});removeFullscreenChanged=window.desktop.playback.onFullscreenChanged(value=>{fullscreen.value=value;if(!value){void nextTick().then(()=>scheduleSurfaceSync());}});removeOverlayAction=window.desktop.playback.onOverlayAction(value=>{if(value.action!=='next'||value.requestId!==runtimeSession.value.requestId||!isVod.value||!canNext.value)return;void playAdjacent(1,'user');});removePlaybackStage=onPlaybackStage(detail=>{status.value=detail.message;if(detail.stage==='source-resolving'||detail.stage==='connecting'){videoMetadataStarted=performance.now();markSwitching(true);}if(detail.stage==='playing')markSwitching(false);if(detail.stage==='failed'){playbackError.value=detail.error??detail.message;playbackCode.value=playbackCodeOf(playbackError.value);}else if(detail.stage==='playing'){playbackError.value='';playbackCode.value='';}});removeBackendStage=window.desktop.playback.onStageChanged(detail=>{status.value=detail.message;if(detail.stage==='source-resolving'||detail.stage==='connecting'){videoMetadataStarted=performance.now();markSwitching(true);}if(detail.stage==='playing')markSwitching(false);if(detail.stage==='failed'){playbackError.value=detail.error??detail.message;playbackCode.value=playbackCodeOf(playbackError.value);}else if(detail.stage==='playing'){playbackError.value='';playbackCode.value='';}});window.addEventListener('resize',scheduleSurfaceSync);window.addEventListener('scroll',scheduleSurfaceSync,true);const [recent,diag,savedSettings,runtime]=await Promise.all([window.desktop.history.list(8).catch(()=>[]),window.desktop.diagnostics.get().catch(()=>({})),window.desktop.settings.list().catch(()=>({} as Record<string,string>)),window.desktop.playback.runtimeSession().catch(()=>({generation:0,requestId:'',domain:null,status:'idle',updatedAt:0} as RuntimeSession))]);applyRuntime(runtime);autoNext.value=savedSettings['player.autoNext']!=='false';
  const pendingOnMount=readPendingPlayback();
  if(pendingOnMount&&runtime.domain!=='live'&&runtime.domain!=='music'&&(!runtime.domain||runtime.status==='idle'||runtime.status==='failed')){
    void window.desktop.playback.play(pendingOnMount.request).then(()=>clearPendingPlayback(pendingOnMount.requestId)).catch(value=>{const message=value instanceof Error?value.message:String(value);if(!message.includes('PLAYBACK_SUPERSEDED'))status.value=message;});
  }let saved:PlaybackHistoryEntry[]=[];try{const parsed=JSON.parse(savedSettings['player.savedQueue']??'[]') as unknown;if(Array.isArray(parsed))saved=parsed as PlaybackHistoryEntry[];}catch{/* ignore malformed saved queue */}queuePersisted.value=Object.prototype.hasOwnProperty.call(savedSettings,'player.savedQueue');queue.value=queuePersisted.value?saved:recent;diagnostics.value=diag;await nextTick();observer=new ResizeObserver(()=>scheduleSurfaceSync());if(surface.value)observer.observe(surface.value);void refresh();scheduleSurfaceSync();timer=setInterval(()=>{void refresh();},1000);surfaceTimer=setInterval(()=>scheduleSurfaceSync(),1000);});onBeforeRouteLeave(async()=>{allowSurfaceSync=false;const started=performance.now();try{await releaseSurface();const elapsed=performance.now()-started;if(window.desktop.app.isUiSmoke()&&elapsed>200)throw new Error(`Player native surface hide exceeded 200ms: ${elapsed.toFixed(1)}ms`);}catch(error){allowSurfaceSync=true;scheduleSurfaceSync();throw error;}finally{void window.desktop.diagnostics.recordPerformance('surfaceHideMs',performance.now()-started).catch(()=>false);}});
onBeforeUnmount(()=>{tracksRefresh=undefined;allowSurfaceSync=false;removeAfterNavigation();if(controlsIdleTimer)clearTimeout(controlsIdleTimer);if(switchTimer)clearTimeout(switchTimer);window.removeEventListener('keydown',keydown);window.removeEventListener('resize',scheduleSurfaceSync);window.removeEventListener('scroll',scheduleSurfaceSync,true);removePlaybackStage?.();removeBackendStage?.();removeFullscreenChanged?.();removeRuntimeSessionChanged?.();removeOverlayAction?.();observer?.disconnect();if(timer)clearInterval(timer);if(surfaceTimer)clearInterval(surfaceTimer);if(surfaceRaf)cancelAnimationFrame(surfaceRaf);void releaseSurface().catch(()=>undefined);});
</script>

<template>
  <section class="page player-page">
    <div class="page-heading split"><div><h1>播放器</h1></div><div class="toolbar-group"><button class="secondary-button" :disabled="actualDomain==='music'" @click="screenshot">截图</button><button class="secondary-button" :disabled="actualDomain==='music'" @click="togglePip">{{pip?'退出 PiP':'画中画'}}</button><button class="secondary-button" :disabled="actualDomain==='music'" @click="toggleFullscreen">{{fullscreen?'退出全屏':'全屏'}}</button><button class="secondary-button" :class="{active:hwdecEnabled}" @click="toggleHwdec">{{hwdecEnabled?'硬件解码':'软件解码'}}</button></div></div>
    <div class="player-workspace">
      <div class="player-stage-column" :class="{'controls-hidden':controlsHidden}" @pointermove="wakeControls" @pointerenter="stageHover=true;wakeControls()" @pointerleave="stageHover=false">
        <div ref="surface" class="player-surface concept-surface" role="region" aria-label="视频播放区域"><div class="surface-placeholder"><span class="surface-seal">山河无恙<br/>人间皆安</span><strong>{{actualDomain==='music'?'音乐模式不创建视频窗口':'Native libmpv Video Surface'}}</strong><small>{{actualDomain==='music'?'音乐由同一 PlayerHost 输出，视频 Surface 已释放。':'开始播放后，原生视频窗口严格嵌入此区域；全屏时移动鼠标或点击画面可使用应用控制浮层。'}}</small></div>
          <transition name="switch-fade"><div v-if="mediaSwitching" class="switch-overlay" aria-live="polite"><div class="switch-card"><span class="panel-kicker">正在切换片源</span><strong>{{switchTitle}}</strong><small>{{switchSubtitle}}</small><div class="switch-skeleton" aria-hidden="true"><i/><i/><i/></div></div></div></transition></div>
        <div class="progress-panel panel">
          <div class="progress-times"><span>{{formatTime(seekValue)}}</span><span class="buffer-hint" v-if="bufferPercent">缓冲 {{bufferPercent}}%</span><span :class="{waiting:!durationReady}">{{durationReady?formatTime(displayDuration):'--:--'}}</span></div>
          <div class="player-timeline" :class="{seeking}">
            <div class="tl-rail" aria-hidden="true">
              <i v-if="bufferPercent>0" class="tl-buffer" :style="{width:bufferPercent+'%'}"/>
              <i class="tl-played" :style="{width:playPercent+'%'}"/>
              <span class="tl-thumb" :style="{left:playPercent+'%'}"/>
            </div>
            <input v-model.number="seekValue" class="tl-input" type="range" :min="0" :max="Math.max(0.1,displayDuration||0.1)" step="0.1" aria-label="播放进度" :disabled="!durationReady" @pointerdown="seeking=true" @pointerup="seeking=false" @pointercancel="seeking=false" @change="seekAbsolute"/>
          </div>
        </div>
        <div class="transport-bar panel"><button v-if="isVod" class="icon-control episode-control" :disabled="!canPrevious" @click="playAdjacent(-1)">上一集</button><button class="icon-control" @click="command({command:'seek',value:-10})" aria-label="后退 10 秒" title="后退 10 秒"><AppIcon name="player-rewind" :size="18"/></button><button class="icon-control primary" :disabled="runtimeSession.status==='stopped'" :aria-label="paused?'播放':'暂停'" :title="paused?'播放':'暂停'" @click="togglePause"><AppIcon :name="paused?'player-play':'player-pause'" :size="20"/></button><button class="icon-control" @click="command({command:'seek',value:10})" aria-label="前进 10 秒" title="前进 10 秒"><AppIcon name="player-forward" :size="18"/></button><button v-if="isVod" class="icon-control episode-control" :disabled="!canNext" @click="playAdjacent(1)">下一集</button><button class="icon-control" @click="toggleMute">{{muted?'静音':'声音'}}</button><input v-model.number="volume" class="volume-slider" type="range" min="0" max="100" aria-label="音量" @change="persistVolume"/><select v-model.number="speed" @change="persistSpeed"><option v-for="value in [0.5,1,1.25,1.5,2,3]" :key="value" :value="value">{{value}}×</option></select><span class="transport-spacer"/><button class="secondary-button" @click="command({command:'stop'})">停止</button></div>
        <section class="panel playback-status" role="status" aria-label="播放状态"><strong :class="{good:runtimeSession.status==='playing'&&!playbackError&&!liveBuffering,danger:!!playbackError}"><i/>{{playbackError?'播放失败':runtimeSession.status==='paused'?'已暂停':runtimeSession.status==='playing'?(paused?'已暂停':liveBuffering?'正在缓冲':'播放中'):runtimeSession.status==='loading'?'正在连接':runtimeSession.status==='ended'?'播放结束':'等待播放'}}</strong><span v-if="isVod&&currentQueueEntry">{{currentQueueEntry.videoName}} · {{currentQueueEntry.episodeName}}</span><span v-else>{{actualDomain==='live'?'直播':actualDomain==='music'?'音乐':'暂无播放会话'}}</span><span v-if="status" class="playback-status-message" :title="status">{{status}}</span><span v-if="stats?.width">{{resolution}} · {{stats.videoFormat||'—'}}</span></section>
    <div v-if="surfaceError" class="player-error" role="alert"><strong>视频画面未挂载</strong><p>{{surfaceError}}</p><div class="row-actions"><button class="primary-button" @click="syncSurface()">重新挂载画面</button><button class="text-link" @click="openDiagnostics">打开诊断</button></div></div>
    <div v-if="playbackError" class="player-error" role="alert"><div class="player-error-head"><strong>播放失败</strong><span v-if="playbackCode" class="error-code">错误码 {{playbackCode}}</span></div><p>{{stripPlaybackCode(playbackError)}}</p><p class="error-context">播放域：{{actualDomain??(lastFailedPending?'vod':'未知')}} · 来源：{{failureSourceName}} · 线路：{{failureFlag}}</p><div class="row-actions"><button class="primary-button" :disabled="liveRetrying" @click="retryPlayback">重试</button><button v-if="isVod||lastFailedPending" class="secondary-button" :disabled="!nextRouteFlag" :title="nextRouteFlag?`切换到线路「${nextRouteFlag}」`:''" @click="switchRoute">切换线路</button><button class="text-link" @click="openDiagnostics">打开诊断</button></div></div>
    <section class="panel queue-panel"><div class="panel-heading"><div><span class="panel-kicker">点播历史</span><h2>{{isVod?'当前点播队列':'仅浏览，不参与当前播放'}}</h2></div><div class="queue-actions"><button class="text-link" :disabled="!queue.length" @click="saveQueue">保存队列</button><button class="text-link" :disabled="!queue.length" @click="clearQueue">清空并保存</button><RouterLink class="text-link" to="/history">查看全部</RouterLink></div></div><div v-if="queue.length" class="queue-strip"><button v-for="(item,index) in queue" :key="item.id" class="queue-card" draggable="true" @dragstart="draggedIndex=index" @dragover.prevent @drop="dropQueue(index)" :class="{legacy:!replayable(item)}" :title="replayable(item)?'明确点击后切换为点播':'旧记录缺少重播参数'" @click="resumeQueueItem(item,'history')"><div class="queue-thumb"><img v-if="item.poster" :src="item.poster" :alt="item.videoName+' 海报'"/><span v-else><AppIcon name="player-play" :size="16"/></span></div><div><strong>{{item.videoName}}</strong><small>{{item.episodeName}} · {{item.sourceName}} · {{formatTime(item.position)}} / {{formatTime(item.duration)}}</small><progress class="queue-progress" :value="item.position??0" :max="Math.max(1,item.duration??1)" :aria-label="`${item.videoName} 播放进度`"/></div></button></div><div v-else class="compact-empty">当前点播历史为空。</div></section>
      </div>
      <aside class="panel playback-info"><div class="panel-heading"><div><span class="panel-kicker">播放信息</span><h2>媒体与运行状态</h2></div></div><dl class="info-list"><div><dt>播放域 / 会话</dt><dd>{{actualDomain??'—'}} / {{runtimeSession.requestId.slice(0,8)||'—'}}</dd></div><div><dt>播放位置</dt><dd>{{formatTime(stats?.position)}} / {{formatTime(stats?.duration)}}</dd></div><div><dt>容器 / 视频</dt><dd>{{stats?.containerFormat||'—'}} / {{stats?.videoFormat||'—'}}</dd></div><div><dt>分辨率 / 帧率</dt><dd>{{resolution}} / {{stats?.fps?stats.fps.toFixed(2)+' fps':'—'}}</dd></div><div><dt>视频码率</dt><dd>{{formatRate(stats?.videoBitrate)}}</dd></div><div><dt>音频</dt><dd>{{stats?.audioFormat||'—'}} · {{stats?.audioChannels||'—'}} ch · {{stats?.sampleRate?Math.round(stats.sampleRate/1000)+' kHz':'—'}}</dd></div><div><dt>音频码率</dt><dd>{{formatRate(stats?.audioBitrate)}}</dd></div><div><dt>硬件解码</dt><dd>{{stats?.hwdec||'—'}}</dd></div><div><dt>缓存</dt><dd>{{stats?formatBytes(stats.cacheBytes)+' / '+formatBytes(stats.cacheMaxBytes)+' · '+stats.cacheDuration.toFixed(1)+' 秒':'—'}}</dd></div><div><dt>画面窗口</dt><dd>{{videoSurfaceMessage}}</dd></div><div><dt>显示模式</dt><dd>{{actualDomain==='music'?'音频':fullscreen?'全屏':pip?'画中画':'嵌入'}}</dd></div><div><dt>来源 / 片源</dt><dd>{{isVod?(currentQueueEntry?.sourceName??'—'):'—'}} / {{isVod?(currentQueueEntry?.episodeName??'—'):'—'}}</dd></div><div><dt>文件大小</dt><dd>{{formatBytes(stats?.fileSize)}}</dd></div><div class="path-row"><dt>媒体路径</dt><dd :title="stats?.path??''">{{stats?.path||'—'}}</dd></div></dl><div class="runtime-box"><strong>PlayerHost 运行信息</strong><small>应用 V{{diagnostics.appVersion??'—'}} · {{diagnostics.architecture??'x64'}}</small><small>libmpv：{{String(diagnostics.libmpv??'—').split(';')[0]}}</small><small>GPU：{{String(diagnostics.gpu??'—').slice(0,64)}}</small><small>视频尺寸就绪与真实呈现首帧分开统计；当前不伪报首帧时间</small><small>编译运行时：MSVC 2022 (x64)</small><small>平台：Windows {{diagnostics.windowsBuild??'—'}} · {{diagnostics.architecture??'x64'}}</small></div><div class="advanced-player-controls"><label>画面比例<select v-model="aspect" :disabled="actualDomain==='music'" @change="command({command:'aspect-ratio',value:aspect})"><option value="no">自动</option><option value="16:9">16:9</option><option value="4:3">4:3</option><option value="2.35:1">2.35:1</option></select></label><label>音轨<select @change="command({command:'audio-track',value:($event.target as HTMLSelectElement).value})"><option value="auto">自动</option><option v-for="track in audioTracks" :key="track.id" :value="track.id">{{track.title||track.language||track.id}}</option></select></label><label>字幕轨<select :disabled="actualDomain==='music'" @change="command({command:'subtitle-track',value:($event.target as HTMLSelectElement).value})"><option value="auto">自动</option><option value="no">关闭</option><option v-for="track in subtitleTracks" :key="track.id" :value="track.id">{{track.title||track.language||track.id}}</option></select></label><label>字幕延迟<input v-model.number="subtitleDelay" :disabled="actualDomain==='music'" type="number" step="0.1" @change="command({command:'subtitle-delay',value:subtitleDelay})"/></label><label>音频延迟<input v-model.number="audioDelay" type="number" step="0.1" @change="command({command:'audio-delay',value:audioDelay})"/></label><label>外挂字幕<div class="inline-input"><input v-model="subtitlePath" :disabled="actualDomain==='music'" placeholder="C:\\Subtitles\\movie.ass"/><button :disabled="!subtitlePath||actualDomain==='music'" @click="command({command:'subtitle-add',value:subtitlePath})">加载</button></div></label></div></aside>
    </div>

  </section>
</template>

<style scoped>
.player-stage-column{min-width:0}.playback-status{display:flex;align-items:center;flex-wrap:wrap;gap:10px 16px;margin-top:12px;padding:14px 16px;min-height:52px;box-sizing:border-box}.playback-status>strong{display:flex;align-items:center;gap:8px;white-space:nowrap}.playback-status i{width:9px;height:9px;border-radius:50%;background:currentColor}.playback-status>span{min-width:0;padding-left:16px;border-left:1px solid var(--line);font-size:12px}.playback-status-message{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.queue-panel{margin-top:12px}.queue-strip{grid-template-columns:repeat(3,minmax(0,1fr))}.queue-thumb{height:66px}.queue-card small{font-size:11px}.player-stage-column>.player-error{margin-top:12px}.good{color:var(--good)}.danger{color:var(--danger)}
@media(max-width:760px){.queue-strip{grid-template-columns:1fr}.queue-actions{flex-wrap:wrap}.queue-panel>.panel-heading{flex-wrap:wrap;gap:10px}}
.concept-surface{position:relative;overflow:hidden;isolation:isolate}.progress-panel{padding:10px 14px 8px;margin-top:10px}.progress-times{display:flex;justify-content:space-between;align-items:center;gap:8px;font-variant-numeric:tabular-nums;font-size:11px;color:var(--muted)}
.progress-times .waiting{color:color-mix(in srgb,var(--muted) 62%,transparent)}
.player-timeline{position:relative;display:flex;align-items:center;height:18px;margin-top:3px}
.tl-rail{position:relative;flex:1;height:4px;border-radius:2px;background:color-mix(in srgb,var(--text) 14%,var(--canvas));transition:height .16s ease}
.player-timeline:hover .tl-rail,.player-timeline.seeking .tl-rail,.player-timeline:focus-within .tl-rail{height:6px}
.tl-buffer{position:absolute;left:0;top:0;bottom:0;background:color-mix(in srgb,var(--accent) 28%,transparent);border-radius:2px;transition:width .5s linear}
.tl-played{position:absolute;left:0;top:0;bottom:0;width:0;background:var(--accent);border-radius:2px}
.tl-thumb{position:absolute;top:50%;left:0;width:12px;height:12px;margin-left:-6px;border-radius:50%;background:var(--surface);border:2px solid var(--accent);box-shadow:0 1px 3px rgba(0,0,0,.22);transform:translateY(-50%);transition:width .12s ease,height .12s ease,margin-left .12s ease;pointer-events:none}
.player-timeline:hover .tl-thumb,.player-timeline.seeking .tl-thumb{width:14px;height:14px;margin-left:-7px}
.tl-input{position:absolute;inset:0;width:100%;height:100%;margin:0;opacity:0;cursor:pointer;appearance:none;-webkit-appearance:none;background:transparent}
.tl-input:disabled{cursor:default}
.player-timeline:focus-within .tl-rail{outline:2px solid var(--accent);outline-offset:3px}
.buffer-hint{color:var(--muted)}
.switch-overlay{position:absolute;inset:0;z-index:6;display:grid;place-items:center;background:color-mix(in srgb,var(--canvas) 88%,transparent);backdrop-filter:blur(3px)}
.switch-card{display:grid;gap:5px;max-width:min(440px,82%);padding:18px 24px 20px;text-align:center;border:1px solid var(--line);border-radius:var(--radius-l);background:var(--surface);box-shadow:var(--shadow-md)}
.switch-card strong{font-family:"Iowan Old Style","STSong",serif;font-size:17px;line-height:1.3}
.switch-card small{color:var(--muted);font-size:11.5px}
.switch-skeleton{display:grid;gap:6px;margin-top:10px}
.switch-skeleton i{position:relative;display:block;height:8px;border-radius:4px;background:var(--surface-2);overflow:hidden}
.switch-skeleton i::after{content:"";position:absolute;inset:0;transform:translateX(-100%);background:linear-gradient(90deg,transparent,color-mix(in srgb,var(--surface) 70%,var(--line-soft)),transparent);animation:skeleton-wave 1.4s infinite}
.switch-skeleton i:nth-child(2){width:76%;margin:0 auto}
.switch-skeleton i:nth-child(3){width:54%;margin:0 auto}
.switch-fade-enter-active,.switch-fade-leave-active{transition:opacity .2s ease}
.switch-fade-enter-from,.switch-fade-leave-to{opacity:0}
@media(prefers-reduced-motion:reduce){.tl-rail,.tl-thumb{transition:none}.switch-skeleton i::after{animation:none}}
.controls-hidden .progress-panel,.controls-hidden .transport-bar{opacity:.12;transition:opacity .5s ease}
.progress-panel,.transport-bar{transition:opacity .25s ease}.runtime-box{display:flex;flex-direction:column;gap:4px;padding:10px 0;margin-top:8px;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}.runtime-box small{color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.path-row dd{max-width:190px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.queue-card{text-decoration:none;color:inherit;text-align:left;border:0;cursor:pointer}.queue-card.legacy{opacity:.62}.queue-thumb{overflow:hidden}.queue-thumb img{width:100%;height:100%;object-fit:cover}.queue-progress{width:100%;height:4px;margin-top:4px}.queue-actions{display:flex;align-items:center;gap:10px}.episode-control{min-width:58px}.episode-control:disabled{opacity:.35;cursor:not-allowed}.toolbar-group button:disabled,.advanced-player-controls :disabled{opacity:.45;cursor:not-allowed}
</style>
<style scoped>
.player-error{display:grid;gap:6px;margin:12px 0;padding:12px 14px;border:1px solid #d45858;border-radius:10px;background:rgba(180,45,45,.12);color:#a92f2f}.player-error-head{display:flex;align-items:center;gap:10px}.player-error .error-code{font-size:11px;padding:2px 7px;border-radius:999px;border:1px solid currentColor}.player-error .error-context{color:var(--muted);font-size:11px}.player-error .row-actions{display:flex;gap:9px;align-items:center}.queue-card[draggable=true]{cursor:grab}.queue-card[draggable=true]:active{cursor:grabbing}
</style>

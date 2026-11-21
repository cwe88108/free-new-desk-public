import { ref,shallowRef } from 'vue';
import type { PlaybackSessionSnapshot,PlayerStats,PlayerLoadStatus } from '@free-new-desk/contracts';
export const clockStats=shallowRef<PlayerStats|null>(null);
export const clockRuntime=shallowRef<PlaybackSessionSnapshot>({generation:0,sessionId:'',requestId:'',domain:null,status:'idle',updatedAt:0});
export const clockLoadStatus=shallowRef<PlayerLoadStatus|null>(null);
export const clockPosition=ref(0),clockStale=ref(true);
type SeekState={serial:number;target:number;loadId:string;requestId:string;deadline:number};
export const clockDiagnostics={rejected:0,reason:'',sampleAgeMs:0};
const legacyClock = window.desktop.rollback?.playbackClock === true;
let started=false,inFlight:Promise<void>|undefined,anchorAt=0,anchor=0,frame=0,seekSerial=0,seekState:SeekState|undefined;
let visualSubscribers = 0;
let staleTimer: ReturnType<typeof setTimeout> | undefined;

function invalidateAnchor() {
  anchorAt = 0;
  clockStale.value = true;
  clearTimeout(staleTimer);
  if (!legacyClock) {
    cancelAnimationFrame(frame);
    frame = 0;
  }
}

function canDrawPosition(): boolean {
  const sample = clockStats.value;
  return (legacyClock || (visualSubscribers > 0 && clockRuntime.value.domain === 'music'))
    && !document.hidden && !clockStale.value && !seekState && clockRuntime.value.status === 'playing'
    && Boolean(sample && !sample.paused && !sample.pausedForCache);
}

function scheduleVisualClock() {
  if (frame || (legacyClock ? !started : !canDrawPosition())) return;
  frame = requestAnimationFrame(now => {
    frame = 0;
    const sample = clockStats.value;
    const age = Math.max(0, now - anchorAt);
    if (legacyClock) {
      clockStale.value = !anchorAt || age > 1000;
      clockDiagnostics.sampleAgeMs = Math.round(age);
      if (seekState) clockPosition.value = seekState.target;
    }
    if (sample && canDrawPosition()) {
      const position = anchor + age / 1000 * sample.speed;
      clockDiagnostics.sampleAgeMs = Math.round(age);
      clockPosition.value = sample.duration > 0 ? Math.min(sample.duration, position) : position;
    }
    scheduleVisualClock();
  });
}

export function observePlaybackPosition(): () => void {
  visualSubscribers++;
  scheduleVisualClock();
  return () => {
    visualSubscribers--;
    if (!legacyClock && !visualSubscribers) {
      cancelAnimationFrame(frame);
      frame = 0;
    }
  };
}

function reset(){invalidateAnchor();clockStats.value=null;clockLoadStatus.value=null;anchor=0;clockPosition.value=0;seekState=undefined;seekSerial++;}
function runtime(value:PlaybackSessionSnapshot){const previous=clockRuntime.value;if(value.generation<previous.generation)return;if(value.generation===previous.generation&&value.requestId===previous.requestId&&value.updatedAt<previous.updatedAt)return;if(value.requestId!==previous.requestId||value.loadId!==previous.loadId||value.status==='stopped')reset();clockRuntime.value=value;scheduleVisualClock();}
function acceptSample(sample:PlayerStats,current:PlaybackSessionSnapshot):boolean{
  if(current.status==='stopped')return false;
  if(sample.sampleFresh!==true||sample.sampleState&&sample.sampleState!=='fresh'||sample.samplePositionStable===false){clockDiagnostics.rejected++;clockDiagnostics.reason='sample-not-fresh-and-stable';return false;}
  if(!sample.sampleValid||!sample.hostEpoch||sample.loadId!==current.loadId||sample.requestId!==current.requestId||!Number.isSafeInteger(sample.sampleSeq)){clockDiagnostics.rejected++;clockDiagnostics.reason=!sample.sampleValid?'sample-invalid':'session-mismatch';return false;}
  const old=clockStats.value;if(old&&old.hostEpoch===sample.hostEpoch&&(old.sampleSeq??0)>=(sample.sampleSeq??0))return false;
  if(seekState){
    if(seekState.loadId!==current.loadId||seekState.requestId!==current.requestId){seekState=undefined;return false;}
    const tolerance=Math.max(.75,sample.duration>0?sample.duration*.001:0);
    if(Math.abs(sample.position-seekState.target)>tolerance)return false;
    seekState=undefined;
  }
  clockDiagnostics.reason = '';
  clockDiagnostics.sampleAgeMs = 0;
  clockStats.value = sample;
  anchor = sample.position;
  anchorAt = performance.now();
  if (legacyClock || !document.hidden || visualSubscribers) clockPosition.value = anchor;
  clockStale.value = false;
  if (!legacyClock) {
    clearTimeout(staleTimer);
    staleTimer = setTimeout(invalidateAnchor, 1000);
  }
  scheduleVisualClock();
  return true;
}
export async function refreshPlaybackClock():Promise<void>{
  if(inFlight)return inFlight;
  inFlight=(async()=>{
    // An idle/requested session has no native load to sample. Read the authoritative
    // identity first rather than opening two invalid native queries every tick.
    const r=await window.desktop.playback.runtimeSession().catch(()=>undefined);
    if(r)runtime(r);
    if(!clockRuntime.value.loadId||clockRuntime.value.status==='stopped')return;
    const [s,l]=await Promise.allSettled([window.desktop.playback.query('stats'),window.desktop.playback.query('load-status')]);
    const current=clockRuntime.value;
    if(current.status!=='stopped'&&l.status==='fulfilled'&&l.value.loadId===current.loadId)clockLoadStatus.value=l.value;
    if(s.status==='fulfilled')acceptSample(s.value,current);
  })().finally(()=>{inFlight=undefined;});return inFlight;
}

export function startPlaybackClock() {
  if (started) return;
  started = true;
  const unsubscribe = window.desktop.playback.onRuntimeSessionChanged(value => {
    const loadChanged = clockRuntime.value.loadId !== value.loadId || clockRuntime.value.requestId !== value.requestId;
    runtime(value);
    if (!legacyClock && loadChanged && value.loadId && value.status !== 'stopped') void refreshPlaybackClock();
  });
  // Active loads still need authoritative sampling for queue advance and background audio.
  const poll = setInterval(() => {
    if (legacyClock || (clockRuntime.value.loadId && clockRuntime.value.status !== 'stopped')) void refreshPlaybackClock();
  }, 275);
  const onVisibilityChange = () => {
    invalidateAnchor();
    if (!document.hidden) void refreshPlaybackClock();
  };
  document.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('beforeunload', () => {
    clearInterval(poll);
    unsubscribe();
    document.removeEventListener('visibilitychange', onVisibilityChange);
    invalidateAnchor();
    if (legacyClock) {
      started = false;
      cancelAnimationFrame(frame);
      frame = 0;
    }
  }, { once: true });
  if (legacyClock) scheduleVisualClock();
  void refreshPlaybackClock();
}
export async function seekPlayback(position:number,loadId:string,requestId:string):Promise<void>{
  if(!Number.isFinite(position)||clockRuntime.value.loadId!==loadId||clockRuntime.value.requestId!==requestId)throw new Error('[PLAYBACK_SUPERSEDED] seek 会话已变化');
  const serial=++seekSerial,target=Math.max(0,Math.min(clockStats.value?.duration||Number.POSITIVE_INFINITY,position));seekState={serial,target,loadId,requestId,deadline:performance.now()+2500};clockPosition.value=target;invalidateAnchor();
  try{
    const result=await window.desktop.playback.control({command:'seek',value:target,absolute:true,loadId,requestId});if(!result.ok)throw new Error(result.detail??'定位失败');
    while(seekState?.serial===serial&&performance.now()<seekState.deadline){await new Promise(resolve=>setTimeout(resolve,75));await refreshPlaybackClock();}
    if(seekState?.serial===serial){seekState=undefined;await refreshPlaybackClock();throw new Error('定位确认超时，请重试');}
  }catch(error){if(seekState?.serial===serial)seekState=undefined;await refreshPlaybackClock().catch(()=>undefined);throw error;}
}

import { ref,shallowRef } from 'vue';
import type { PlaybackSessionSnapshot,PlayerStats,PlayerLoadStatus } from '@free-new-desk/contracts';
export const clockStats=shallowRef<PlayerStats|null>(null);
export const clockRuntime=shallowRef<PlaybackSessionSnapshot>({generation:0,sessionId:'',requestId:'',domain:null,status:'idle',updatedAt:0});
export const clockLoadStatus=shallowRef<PlayerLoadStatus|null>(null);
export const clockPosition=ref(0),clockStale=ref(true);
type SeekState={serial:number;target:number;loadId:string;requestId:string;deadline:number};
let started=false,inFlight:Promise<void>|undefined,anchorAt=0,anchor=0,frame=0,seekSerial=0,seekState:SeekState|undefined;
function reset(){clockStats.value=null;clockLoadStatus.value=null;anchorAt=0;anchor=0;clockPosition.value=0;clockStale.value=true;seekState=undefined;seekSerial++;}
function runtime(value:PlaybackSessionSnapshot){const previous=clockRuntime.value;if(value.generation<previous.generation||value.updatedAt<previous.updatedAt)return;if(value.requestId!==previous.requestId||value.loadId!==previous.loadId)reset();clockRuntime.value=value;}
function acceptSample(sample:PlayerStats,current:PlaybackSessionSnapshot):boolean{
  if(!sample.sampleValid||!sample.hostEpoch||sample.loadId!==current.loadId||sample.requestId!==current.requestId||!Number.isSafeInteger(sample.sampleSeq))return false;
  const old=clockStats.value;if(old&&old.hostEpoch===sample.hostEpoch&&(old.sampleSeq??0)>=(sample.sampleSeq??0))return false;
  if(seekState){
    if(seekState.loadId!==current.loadId||seekState.requestId!==current.requestId){seekState=undefined;return false;}
    const tolerance=Math.max(.75,sample.duration>0?sample.duration*.001:0);
    if(Math.abs(sample.position-seekState.target)>tolerance)return false;
    seekState=undefined;
  }
  clockStats.value=sample;anchor=sample.position;anchorAt=performance.now();clockPosition.value=anchor;clockStale.value=false;return true;
}
export async function refreshPlaybackClock():Promise<void>{
  if(inFlight)return inFlight;
  inFlight=(async()=>{const [s,l,r]=await Promise.allSettled([window.desktop.playback.query('stats'),window.desktop.playback.query('load-status'),window.desktop.playback.runtimeSession()]);
    if(r.status==='fulfilled')runtime(r.value);const current=clockRuntime.value;
    if(l.status==='fulfilled'&&l.value.loadId===current.loadId)clockLoadStatus.value=l.value;
    if(s.status==='fulfilled')acceptSample(s.value,current);
  })().finally(()=>{inFlight=undefined;});return inFlight;
}export function startPlaybackClock(){if(started)return;started=true;window.desktop.playback.onRuntimeSessionChanged(runtime);
  const poll=setInterval(()=>{void refreshPlaybackClock();},275);
  const tick=()=>{const sample=clockStats.value,age=performance.now()-anchorAt;clockStale.value=!anchorAt||age>1000;
    if(seekState){clockPosition.value=seekState.target;}
    else if(!clockStale.value&&sample&&!sample.paused&&!sample.pausedForCache&&clockRuntime.value.status==='playing'&&!document.hidden){const position=anchor+age/1000*sample.speed;clockPosition.value=sample.duration>0?Math.min(sample.duration,position):position;}
    frame=requestAnimationFrame(tick);
  };frame=requestAnimationFrame(tick);
  document.addEventListener('visibilitychange',()=>{anchorAt=0;clockStale.value=true;if(!document.hidden)void refreshPlaybackClock();});
  window.addEventListener('beforeunload',()=>{clearInterval(poll);cancelAnimationFrame(frame);},{once:true});void refreshPlaybackClock();
}
export async function seekPlayback(position:number,loadId:string,requestId:string):Promise<void>{
  if(!Number.isFinite(position)||clockRuntime.value.loadId!==loadId||clockRuntime.value.requestId!==requestId)throw new Error('[PLAYBACK_SUPERSEDED] seek 会话已变化');
  const serial=++seekSerial,target=Math.max(0,Math.min(clockStats.value?.duration||Number.POSITIVE_INFINITY,position));seekState={serial,target,loadId,requestId,deadline:performance.now()+2500};clockPosition.value=target;anchorAt=0;clockStale.value=true;
  try{
    const result=await window.desktop.playback.control({command:'seek',value:target,absolute:true,loadId,requestId});if(!result.ok)throw new Error(result.detail??'定位失败');
    while(seekState?.serial===serial&&performance.now()<seekState.deadline){await new Promise(resolve=>setTimeout(resolve,75));await refreshPlaybackClock();}
    if(seekState?.serial===serial){seekState=undefined;await refreshPlaybackClock();throw new Error('定位确认超时，请重试');}
  }catch(error){if(seekState?.serial===serial)seekState=undefined;await refreshPlaybackClock().catch(()=>undefined);throw error;}
}

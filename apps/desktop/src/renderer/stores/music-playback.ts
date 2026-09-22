import { clockRuntime,clockLoadStatus,startPlaybackClock,refreshPlaybackClock } from './playback-clock.js';
let timer:ReturnType<typeof setInterval>|undefined,busy=false;
const consumed=new Set<string>();
export function readQueue():string[]{try{const data=JSON.parse(localStorage.getItem('music.queue')??'[]');return Array.isArray(data)?data.filter((x):x is string=>typeof x==='string').slice(0,2000):[];}catch{return[];}}
export function adjacentMusicId(ids:string[],current:string|undefined,direction:1|-1,mode:string,natural=false):string|undefined{
  if(!ids.length)return;const index=current?ids.indexOf(current):-1;
  if(natural&&mode==='repeat-one'&&index>=0)return current;
  if(mode==='shuffle'){
    let history:string[];try{history=JSON.parse(localStorage.getItem('music.shuffleHistory')??'[]');if(!Array.isArray(history))history=[];}catch{history=[];}
    if(direction<0){while(history.length){const previous=history.pop();if(previous&&ids.includes(previous)){localStorage.setItem('music.shuffleHistory',JSON.stringify(history));return previous;}}return current;}
    const candidates=ids.filter(id=>id!==current);const next=candidates[Math.floor(Math.random()*candidates.length)]??ids[0];if(current)history.push(current);localStorage.setItem('music.shuffleHistory',JSON.stringify(history.slice(-200)));return next;
  }
  if(natural&&mode==='sequence'&&index===ids.length-1)return;
  return ids[(index+direction+ids.length)%ids.length];
}
export function startMusicPlaybackController(){if(timer)return;startPlaybackClock();timer=setInterval(()=>{void tick();},300);}
export function stopMusicPlaybackController(){if(timer)clearInterval(timer);timer=undefined;}
async function tick(){if(busy)return;busy=true;try{await refreshPlaybackClock();const r=clockRuntime.value,l=clockLoadStatus.value;if(r.domain!=='music'||!r.loadId||!r.trackId)return;localStorage.setItem('music.currentTrack',r.trackId);if(l?.loadId!==r.loadId||l.status!=='ended'||l.error!=='eof')return;const key=`${r.requestId}:${r.loadId}`;if(consumed.has(key))return;if(!await window.desktop.playback.claimNaturalEnd({loadId:r.loadId,requestId:r.requestId,domain:'music'}))return;consumed.add(key);if(consumed.size>100)consumed.delete(consumed.values().next().value!);const next=adjacentMusicId(readQueue(),r.trackId,1,localStorage.getItem('music.mode')??'sequence',true);if(next){const latest=clockRuntime.value;if(latest.domain==='music'&&latest.loadId===r.loadId&&latest.requestId===r.requestId)await window.desktop.music.play({trackId:next,initiator:'auto-next'});}}catch(error){window.dispatchEvent(new CustomEvent('music:playback-error',{detail:error instanceof Error?error.message:String(error)}));}finally{busy=false;}}

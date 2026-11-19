import { defineStore } from 'pinia';
import { computed,reactive } from 'vue';
import type { PlaybackSessionSnapshot } from '@free-new-desk/contracts';
export {clockStats,clockStale,clockLoadStatus,clockRuntime,refreshPlaybackClock} from './playback-clock.js';

export type PlaybackKind='vod'|'live'|'music'|null;
export interface PlaybackSessionState{
  generation:number;requestId:string;loadId:string;kind:PlaybackKind;status:string;
  sourceId:string;channelId:string;routeIndex:number|null;routeCount:number;
  fullscreen:boolean;pip:boolean;lastReason:string;updatedAt:number;
}

export const usePlaybackSessionStore=defineStore('playback-session',()=>{
  const state=reactive<PlaybackSessionState>({generation:0,requestId:'',loadId:'',kind:null,status:'idle',sourceId:'',channelId:'',routeIndex:null,routeCount:0,fullscreen:false,pip:false,lastReason:'',updatedAt:0});
  // Renderer pages may attach presentation metadata, but only the main-process runtime
  // is allowed to advance the authoritative playback generation.
  function begin(value:Partial<Omit<PlaybackSessionState,'generation'>>):number{update(value);return state.generation;}
  function update(value:Partial<Omit<PlaybackSessionState,'generation'>>):void{if(value.fullscreen!==undefined)state.fullscreen=value.fullscreen;if(value.pip!==undefined)state.pip=value.pip;if(value.lastReason!==undefined)state.lastReason=value.lastReason;}
  function applyRuntime(value:PlaybackSessionSnapshot):void{
    if(value.generation<state.generation)return;
    if(value.generation===state.generation&&value.updatedAt<state.updatedAt&&state.requestId===value.requestId)return;
    const domainChanged=state.kind!==value.domain;
    state.generation=value.generation;state.requestId=value.requestId;state.loadId=value.loadId??'';state.kind=value.domain;state.status=value.status;state.updatedAt=value.updatedAt;
    state.sourceId=value.sourceId??'';state.channelId=value.channelId??'';state.routeIndex=value.routeIndex??null;state.routeCount=value.routeCount??0;
    if(domainChanged)state.lastReason='';
  }
  window.desktop.playback.onRuntimeSessionChanged(applyRuntime);
  window.desktop.playback.onFullscreenChanged(fullscreen=>{state.fullscreen=fullscreen;});
  void window.desktop.playback.runtimeSession().then(applyRuntime).catch(()=>undefined);
  const isVod=computed(()=>state.kind==='vod');const isLive=computed(()=>state.kind==='live');const isMusic=computed(()=>state.kind==='music');
  return{state,isVod,isLive,isMusic,begin,update,applyRuntime};
});

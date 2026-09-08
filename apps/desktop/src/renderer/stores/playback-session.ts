import { defineStore } from 'pinia';
import { computed,reactive } from 'vue';

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
  function begin(value:Partial<Omit<PlaybackSessionState,'generation'>>):number{Object.assign(state,value,{updatedAt:Date.now()});return state.generation;}
  function update(value:Partial<Omit<PlaybackSessionState,'generation'>>):void{Object.assign(state,value,{updatedAt:Date.now()});}
  function applyRuntime(value:{generation:number;requestId:string;domain:'vod'|'live'|'music'|null;status:string;loadId?:string;updatedAt:number}):void{
    if(value.generation<state.generation)return;
    if(value.generation===state.generation&&value.updatedAt<state.updatedAt&&state.requestId===value.requestId)return;
    const domainChanged=state.kind!==value.domain;
    state.generation=value.generation;state.requestId=value.requestId;state.loadId=value.loadId??'';state.kind=value.domain;state.status=value.status;state.updatedAt=value.updatedAt;
    if(domainChanged){state.sourceId='';state.channelId='';state.routeIndex=null;state.routeCount=0;state.lastReason='';}
  }
  window.desktop.playback.onRuntimeSessionChanged(applyRuntime);
  window.desktop.playback.onFullscreenChanged(fullscreen=>{state.fullscreen=fullscreen;});
  void window.desktop.playback.runtimeSession().then(applyRuntime).catch(()=>undefined);
  const isVod=computed(()=>state.kind==='vod');const isLive=computed(()=>state.kind==='live');const isMusic=computed(()=>state.kind==='music');
  return{state,isVod,isLive,isMusic,begin,update,applyRuntime};
});

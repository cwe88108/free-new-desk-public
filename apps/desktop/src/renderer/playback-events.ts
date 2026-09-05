export type PlaybackStage='queued'|'source-resolving'|'probing'|'parsing'|'sniffing'|'connecting'|'buffering'|'playing'|'failed';
export interface PlaybackStageDetail{stage:PlaybackStage;message:string;error?:string;at:number;}
const EVENT='fnd:playback-stage';let latest:PlaybackStageDetail|undefined;
export function emitPlaybackStage(stage:PlaybackStage,message:string,error?:string):void{latest={stage,message,...(error?{error}:{}),at:Date.now()};window.dispatchEvent(new CustomEvent<PlaybackStageDetail>(EVENT,{detail:latest}));}
export function onPlaybackStage(listener:(detail:PlaybackStageDetail)=>void):()=>void{const handler=(event:Event)=>listener((event as CustomEvent<PlaybackStageDetail>).detail);window.addEventListener(EVENT,handler);if(latest&&Date.now()-latest.at<60_000)queueMicrotask(()=>listener(latest as PlaybackStageDetail));return()=>window.removeEventListener(EVENT,handler);}

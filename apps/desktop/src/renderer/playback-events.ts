export type PlaybackStage='queued'|'source-resolving'|'probing'|'parsing'|'sniffing'|'connecting'|'buffering'|'playing'|'failed';
export interface PlaybackStageDetail{stage:PlaybackStage;message:string;error?:string;at:number;}
const EVENT='fnd:playback-stage';let latest:PlaybackStageDetail|undefined;
function superseded(message:string,error?:string):boolean{return message.includes('PLAYBACK_SUPERSEDED')||Boolean(error?.includes('PLAYBACK_SUPERSEDED'));}
export function emitPlaybackStage(stage:PlaybackStage,message:string,error?:string):void{if(superseded(message,error))return;latest={stage,message,...(error?{error}:{}),at:Date.now()};window.dispatchEvent(new CustomEvent<PlaybackStageDetail>(EVENT,{detail:latest}));}
export function onPlaybackStage(listener:(detail:PlaybackStageDetail)=>void):()=>void{const handler=(event:Event)=>{const detail=(event as CustomEvent<PlaybackStageDetail>).detail;if(!superseded(detail.message,detail.error))listener(detail);};window.addEventListener(EVENT,handler);if(latest&&Date.now()-latest.at<60_000)queueMicrotask(()=>listener(latest as PlaybackStageDetail));return()=>window.removeEventListener(EVENT,handler);}

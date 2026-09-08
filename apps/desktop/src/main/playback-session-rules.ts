import type { PlaybackSessionSnapshot } from '@free-new-desk/contracts';

export interface VodAutoNextInput{sourceId?:string|undefined;videoId?:string|undefined;episodeId?:string|undefined;fromEpisodeId?:string|undefined;}
export interface HistoryIdentity{sourceId:string;videoId:string;episodeId:string;}
export type VodAutoNextValidation={ok:true}|{ok:false;reason:'not-vod'|'missing-current-identity'|'queue-identity-mismatch'|'origin-episode-mismatch'|'target-episode-invalid'};

export function validateVodAutoNext(session:PlaybackSessionSnapshot,input:VodAutoNextInput):VodAutoNextValidation{
  if(session.domain!=='vod')return{ok:false,reason:'not-vod'};
  if(!session.sourceId||!session.videoId||!session.episodeId)return{ok:false,reason:'missing-current-identity'};
  if(input.sourceId!==session.sourceId||input.videoId!==session.videoId)return{ok:false,reason:'queue-identity-mismatch'};
  if(!input.fromEpisodeId||input.fromEpisodeId!==session.episodeId)return{ok:false,reason:'origin-episode-mismatch'};
  if(!input.episodeId||input.episodeId===session.episodeId)return{ok:false,reason:'target-episode-invalid'};
  return{ok:true};
}

export function canUpdateVodHistory(session:PlaybackSessionSnapshot,identity:HistoryIdentity|undefined,latestHistoryId:string|undefined,historyId:string):boolean{
  if(session.domain!=='vod'||!session.requestId||!session.loadId||!session.sourceId||!session.videoId||!session.episodeId||!identity)return false;
  return identity.sourceId===session.sourceId&&identity.videoId===session.videoId&&identity.episodeId===session.episodeId&&latestHistoryId===historyId;
}

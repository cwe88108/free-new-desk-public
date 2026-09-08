import { randomUUID } from 'node:crypto';
import type { PlaybackDomain,PlaybackInitiator,PlaybackSessionSnapshot } from '@free-new-desk/contracts';

export class PlaybackSupersededError extends Error{
  constructor(){super('[PLAYBACK_SUPERSEDED] 播放请求已被新的播放意图替代或已经结束');this.name='PlaybackSupersededError';}
}

function mutableStatus(status:PlaybackSessionSnapshot['status']):boolean{return status==='requested'||status==='loading'||status==='playing'||status==='paused';}

export class PlaybackSessionController{
  #generation=0;
  #snapshot:PlaybackSessionSnapshot={generation:0,sessionId:'',requestId:'',domain:null,status:'idle',updatedAt:Date.now()};
  readonly #emit:(snapshot:PlaybackSessionSnapshot)=>void;
  constructor(emit:(snapshot:PlaybackSessionSnapshot)=>void){this.#emit=emit;}
  current():PlaybackSessionSnapshot{return{...this.#snapshot};}
  begin(domain:PlaybackDomain,meta:Partial<PlaybackSessionSnapshot>={},initiator:PlaybackInitiator='user'):PlaybackSessionSnapshot{
    const now=Date.now();
    if(this.#snapshot.domain&&mutableStatus(this.#snapshot.status)){
      this.#snapshot={...this.#snapshot,status:'superseded',endReason:'replaced',updatedAt:now};this.#publish();
    }
    const generation=++this.#generation,sessionId=randomUUID(),requestId=randomUUID();
    this.#snapshot={...meta,generation,sessionId,requestId,domain,status:'requested',initiator,updatedAt:now};
    this.#publish();return this.current();
  }
  assertCurrent(requestId:string):void{if(!requestId||this.#snapshot.requestId!==requestId)throw new PlaybackSupersededError();}
  assertMutable(requestId:string):void{this.assertCurrent(requestId);if(!mutableStatus(this.#snapshot.status))throw new PlaybackSupersededError();}
  isCurrent(requestId:string):boolean{return Boolean(requestId&&this.#snapshot.requestId===requestId);}
  isMutable(requestId:string):boolean{return this.isCurrent(requestId)&&mutableStatus(this.#snapshot.status);}
  patch(requestId:string,patch:Partial<PlaybackSessionSnapshot>):PlaybackSessionSnapshot{
    this.assertMutable(requestId);this.#snapshot={...this.#snapshot,...patch,requestId,generation:this.#generation,updatedAt:Date.now()};this.#publish();return this.current();
  }
  loading(requestId:string,loadId?:string):PlaybackSessionSnapshot{return this.patch(requestId,{status:'loading',...(loadId?{loadId}:{})});}
  playing(requestId:string,loadId?:string):PlaybackSessionSnapshot{return this.patch(requestId,{status:'playing',startedAt:this.#snapshot.startedAt??Date.now(),...(loadId?{loadId}:{})});}
  pause(requestId:string,paused:boolean):PlaybackSessionSnapshot|undefined{if(!this.isMutable(requestId))return;return this.patch(requestId,{status:paused?'paused':'playing'});}
  fail(requestId:string,error:string):PlaybackSessionSnapshot|undefined{if(!this.isMutable(requestId))return;return this.patch(requestId,{status:'failed',endReason:'failed',error});}
  end(reason:'eof'|'stop'|'replaced'|'failed'|'unknown'='unknown'):PlaybackSessionSnapshot{
    if(!this.#snapshot.domain||!mutableStatus(this.#snapshot.status))return this.current();
    this.#snapshot={...this.#snapshot,status:reason==='eof'?'ended':reason==='failed'?'failed':reason==='replaced'?'superseded':'stopped',endReason:reason,updatedAt:Date.now()};this.#publish();return this.current();
  }
  supersede():PlaybackSessionSnapshot{
    if(this.#snapshot.domain&&mutableStatus(this.#snapshot.status))this.#snapshot={...this.#snapshot,status:'superseded',endReason:'replaced',updatedAt:Date.now()};
    this.#generation+=1;this.#publish();return this.current();
  }
  #publish():void{this.#emit(this.current());}
}

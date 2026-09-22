import type {PlaybackSessionSnapshot} from '@free-new-desk/contracts';

const terminal=new Set<PlaybackSessionSnapshot['status']>(['idle','stopped','failed','ended','superseded']);

export class SourceRuntimeLeaseTracker{
  #active:{leaseId:string;requestId:string}|undefined;
  constructor(private readonly release:(leaseId:string)=>Promise<void>){}
  snapshot():{leaseId:string;requestId:string}|undefined{return this.#active?{...this.#active}:undefined;}
  async adopt(leaseId:string,requestId:string):Promise<void>{
    if(!leaseId||!requestId)throw new Error('A runtime lease requires an active playback request');
    const previous=this.#active;this.#active={leaseId,requestId};
    if(previous&&previous.leaseId!==leaseId)await this.release(previous.leaseId);
  }
  async observe(session:PlaybackSessionSnapshot):Promise<void>{
    const active=this.#active;if(!active)return;
    if(session.requestId!==active.requestId||terminal.has(session.status)){this.#active=undefined;await this.release(active.leaseId);}
  }
  async clear():Promise<void>{const active=this.#active;this.#active=undefined;if(active)await this.release(active.leaseId);}
}

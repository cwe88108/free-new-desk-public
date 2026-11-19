import {createHash,randomUUID} from 'node:crypto';
import type {SourceAdapter,SourceConfig} from '@free-new-desk/contracts';

interface RuntimeEntry{
  key:string;config:SourceConfig;adapter:SourceAdapter;executable:boolean;
  inFlightCount:number;playbackLeaseCount:number;workerEpoch:number;
  lastIdleAt:number;retiring:boolean;queueTail:Promise<void>;
}
interface RuntimeInitialization{
  promise:Promise<RuntimeEntry>;controller:AbortController;waiters:number;
}
export interface RuntimeSnapshot{
  key:string;sourceId:string;revision:string;inFlightCount:number;
  playbackLeaseCount:number;workerEpoch:number;retiring:boolean;
}
export interface RuntimeControls{acquireLease():string;}
export interface RuntimeManagerOptions{
  maxExecutable:number;idleMs:number;initWaitMs?:number;isExecutable:(config:SourceConfig)=>boolean;
  create:(config:SourceConfig,signal:AbortSignal)=>Promise<SourceAdapter>;
}

function stable(value:unknown):string{
  if(Array.isArray(value))return`[${value.map(stable).join(',')}]`;
  if(value&&typeof value==='object')return`{${Object.entries(value as Record<string,unknown>).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>`${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
  return JSON.stringify(value)??'null';
}
export function runtimeRevision(config:SourceConfig):string{
  return config.configRevision??createHash('sha256').update(stable(config)).digest('hex');
}
export function runtimeKey(config:SourceConfig):string{return`${config.id}\u0000${runtimeRevision(config)}`;}
function abortReason(signal?:AbortSignal):unknown{return signal?.reason??new DOMException('Aborted','AbortError');}

export class RuntimeManager{
  readonly #entries=new Map<string,RuntimeEntry>();
  readonly #initializing=new Map<string,RuntimeInitialization>();
  readonly #leases=new Map<string,string>();
  readonly #desired=new Map<string,string>();
  #epoch=0;#capacityTail=Promise.resolve();#destroyed=false;
  constructor(private readonly options:RuntimeManagerOptions){}

  async #dispose(entry:RuntimeEntry):Promise<void>{
    if(this.#entries.get(entry.key)!==entry)return;
    this.#entries.delete(entry.key);await entry.adapter.destroy();
  }
  async #cleanupRetiring(entry:RuntimeEntry):Promise<void>{
    if(entry.retiring&&entry.inFlightCount===0&&entry.playbackLeaseCount===0)await this.#dispose(entry);
  }
  async #withCapacityLock<T>(action:()=>Promise<T>):Promise<T>{
    const previous=this.#capacityTail;let release!:()=>void;
    this.#capacityTail=new Promise<void>(resolve=>{release=resolve;});
    await previous;try{return await action();}finally{release();}
  }
  async #ensureCapacityLocked(config:SourceConfig):Promise<void>{
    if(!this.options.isExecutable(config))return;
    const active=[...this.#entries.values()].filter(item=>item.executable);
    if(active.length<this.options.maxExecutable)return;
    const victims=active.filter(item=>item.inFlightCount===0&&item.playbackLeaseCount===0&&item.lastIdleAt>0)
      .sort((a,b)=>a.lastIdleAt-b.lastIdleAt);
    while(active.length>=this.options.maxExecutable&&victims.length){
      const victim=victims.shift();if(!victim)break;await this.#dispose(victim);
      const index=active.indexOf(victim);if(index>=0)active.splice(index,1);
    }
    if(active.length>=this.options.maxExecutable)throw new Error('RUNTIME_CAPACITY_EXCEEDED: all executable runtimes are busy');
  }
  #entry(config:SourceConfig):RuntimeEntry|RuntimeInitialization{
    if(this.#destroyed)throw new Error('RUNTIME_MANAGER_DESTROYED');
    const key=runtimeKey(config);
    if(this.#desired.get(config.id)!==key)throw new DOMException('Source configuration was retired','AbortError');
    const existing=this.#entries.get(key);if(existing)return existing;
    const pending=this.#initializing.get(key);if(pending)return pending;
    const controller=new AbortController();
    const initialization:RuntimeInitialization={controller,waiters:0,promise:undefined!};
    initialization.promise=this.#withCapacityLock(async()=>{
      controller.signal.throwIfAborted();
      const again=this.#entries.get(key);if(again)return again;
      await this.#ensureCapacityLocked(config);controller.signal.throwIfAborted();
      const adapter=await this.options.create(config,controller.signal);
      if(this.#destroyed||controller.signal.aborted){
        await adapter.destroy().catch(()=>undefined);
        controller.signal.throwIfAborted();throw new Error('RUNTIME_MANAGER_DESTROYED');
      }
      const entry:RuntimeEntry={key,config,adapter,executable:this.options.isExecutable(config),inFlightCount:0,playbackLeaseCount:0,workerEpoch:++this.#epoch,lastIdleAt:0,retiring:this.#desired.get(config.id)!==key,queueTail:Promise.resolve()};
      this.#entries.set(key,entry);return entry;
    }).finally(()=>{if(this.#initializing.get(key)===initialization)this.#initializing.delete(key);});
    this.#initializing.set(key,initialization);return initialization;
  }
  async #waitForEntry(config:SourceConfig,signal?:AbortSignal):Promise<RuntimeEntry>{
    signal?.throwIfAborted();
    const source=this.#entry(config);if(!('promise' in source))return source;
    // A new caller must not attach to an initialization already cancelled by its last waiter.
    const retry=source.controller.signal.aborted;
    source.waiters+=1;
    let timer:ReturnType<typeof setTimeout>|undefined,abort:(()=>void)|undefined;
    let revoked:(()=>void)|undefined;
    const gate=new Promise<never>((_resolve,reject)=>{
      if(!retry){revoked=()=>reject(abortReason(source.controller.signal));source.controller.signal.addEventListener('abort',revoked,{once:true});if(source.controller.signal.aborted)revoked();}
      if(signal){abort=()=>reject(abortReason(signal));signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();}
      const timeoutMs=this.options.initWaitMs??(signal?15_000:0);
      if(timeoutMs>0)timer=setTimeout(()=>reject(new Error(`[RUNTIME_INIT_TIMEOUT] 来源运行时初始化超过 ${timeoutMs}ms`)),timeoutMs);
    });
    let entry:RuntimeEntry|undefined;
    try{
      const pending=retry?source.promise.then(()=>undefined,()=>undefined):source.promise;
      entry=await Promise.race([pending,gate]);
    }finally{
      if(timer)clearTimeout(timer);if(signal&&abort)signal.removeEventListener('abort',abort);
      if(revoked)source.controller.signal.removeEventListener('abort',revoked);
      source.waiters-=1;
      if(source.waiters===0&&this.#initializing.get(runtimeKey(config))===source)source.controller.abort();
    }
    return entry??this.#waitForEntry(config,signal);
  }
  async #serialized<T>(entry:RuntimeEntry,signal:AbortSignal|undefined,action:()=>Promise<T>):Promise<T>{
    const previous=entry.queueTail;let release!:()=>void;
    entry.queueTail=new Promise<void>(resolve=>{release=resolve;});
    await previous;if(signal?.aborted){release();throw abortReason(signal);}
    try{return await action();}finally{release();}
  }
  async withRuntime<T>(config:SourceConfig,signal:AbortSignal|undefined,action:(adapter:SourceAdapter,controls:RuntimeControls)=>Promise<T>):Promise<T>{
    if(signal?.aborted)throw abortReason(signal);
    const entry=await this.#waitForEntry(config,signal);if(signal?.aborted)throw abortReason(signal);entry.inFlightCount+=1;
    const controls:RuntimeControls={acquireLease:()=>{const id=randomUUID();entry.playbackLeaseCount+=1;this.#leases.set(id,entry.key);return id;}};
    try{return await this.#serialized(entry,signal,()=>action(entry.adapter,controls));}
    finally{
      entry.inFlightCount=Math.max(0,entry.inFlightCount-1);
      if(entry.inFlightCount===0)entry.lastIdleAt=Date.now();
      await this.#cleanupRetiring(entry);
    }
  }
  async releaseLease(leaseId:string):Promise<boolean>{
    const key=this.#leases.get(leaseId);if(!key)return false;this.#leases.delete(leaseId);
    const entry=this.#entries.get(key);if(!entry)return false;
    entry.playbackLeaseCount=Math.max(0,entry.playbackLeaseCount-1);
    if(entry.inFlightCount===0&&entry.playbackLeaseCount===0)entry.lastIdleAt=Date.now();
    await this.#cleanupRetiring(entry);return true;
  }
  async reconcile(configs:SourceConfig[]):Promise<void>{
    const active=new Map(configs.filter(config=>config.enabled).map(config=>[config.id,runtimeKey(config)]));
    this.#desired.clear();for(const[id,key]of active)this.#desired.set(id,key);
    // Revoke pending creations before any await. Do not wait for a stalled download
    // to settle here; adapters must check this signal before executing its bytes.
    const desiredKeys=new Set(active.values());
    for(const[key,work]of this.#initializing)if(!desiredKeys.has(key))work.controller.abort();
    for(const entry of [...this.#entries.values()]){
      if(active.get(entry.config.id)===entry.key)continue;
      entry.retiring=true;await this.#cleanupRetiring(entry);
    }
  }
  async pruneIdle(now=Date.now()):Promise<void>{
    for(const entry of [...this.#entries.values()]){
      if(!entry.executable||entry.retiring||entry.inFlightCount>0||entry.playbackLeaseCount>0)continue;
      if(now-entry.lastIdleAt>=this.options.idleMs)await this.#dispose(entry);
    }
  }
  async resetSource(sourceId:string):Promise<void>{
    const pending=[...this.#initializing.entries()].filter(([key])=>key.startsWith(`${sourceId}\u0000`)).map(([,work])=>work);for(const work of pending)work.controller.abort();await Promise.allSettled(pending.map(work=>work.promise));
    for(const entry of [...this.#entries.values()])if(entry.config.id===sourceId){for(const[id,key]of this.#leases)if(key===entry.key)this.#leases.delete(id);await this.#dispose(entry);}
  }
  snapshot():RuntimeSnapshot[]{
    return[...this.#entries.values()].map(entry=>({
      key:entry.key,sourceId:entry.config.id,revision:runtimeRevision(entry.config),
      inFlightCount:entry.inFlightCount,playbackLeaseCount:entry.playbackLeaseCount,
      workerEpoch:entry.workerEpoch,retiring:entry.retiring
    }));
  }
  async destroy():Promise<void>{
    this.#destroyed=true;this.#leases.clear();this.#desired.clear();
    const pending=[...this.#initializing.values()];this.#initializing.clear();
    for(const work of pending)work.controller.abort();await Promise.allSettled(pending.map(work=>work.promise));
    const entries=[...this.#entries.values()];this.#entries.clear();
    await Promise.allSettled(entries.map(entry=>entry.adapter.destroy()));
  }
}

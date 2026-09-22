import {createHash,randomUUID} from 'node:crypto';
import type {SourceAdapter,SourceConfig} from '@free-new-desk/contracts';

interface RuntimeEntry{
  key:string;config:SourceConfig;adapter:SourceAdapter;executable:boolean;
  inFlightCount:number;playbackLeaseCount:number;workerEpoch:number;
  lastIdleAt:number;retiring:boolean;queueTail:Promise<void>;
}
export interface RuntimeSnapshot{
  key:string;sourceId:string;revision:string;inFlightCount:number;
  playbackLeaseCount:number;workerEpoch:number;retiring:boolean;
}
export interface RuntimeControls{acquireLease():string;}
export interface RuntimeManagerOptions{
  maxExecutable:number;idleMs:number;initWaitMs?:number;isExecutable:(config:SourceConfig)=>boolean;
  create:(config:SourceConfig)=>Promise<SourceAdapter>;
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
  readonly #initializing=new Map<string,Promise<RuntimeEntry>>();
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
  async #entry(config:SourceConfig):Promise<RuntimeEntry>{
    if(this.#destroyed)throw new Error('RUNTIME_MANAGER_DESTROYED');
    const key=runtimeKey(config),existing=this.#entries.get(key);if(existing)return existing;
    const pending=this.#initializing.get(key);if(pending)return pending;
    const work=this.#withCapacityLock(async()=>{
      const again=this.#entries.get(key);if(again)return again;
      await this.#ensureCapacityLocked(config);const adapter=await this.options.create(config);
      if(this.#destroyed){await adapter.destroy().catch(()=>undefined);throw new Error('RUNTIME_MANAGER_DESTROYED');}
      const entry:RuntimeEntry={key,config,adapter,executable:this.options.isExecutable(config),inFlightCount:0,playbackLeaseCount:0,workerEpoch:++this.#epoch,lastIdleAt:0,retiring:this.#desired.get(config.id)!==key,queueTail:Promise.resolve()};
      this.#entries.set(key,entry);return entry;
    }).finally(()=>{if(this.#initializing.get(key)===work)this.#initializing.delete(key);});
    this.#initializing.set(key,work);return work;
  }
  async #waitForEntry(config:SourceConfig,signal?:AbortSignal):Promise<RuntimeEntry>{const pending=this.#entry(config);if(!signal&&!(this.options.initWaitMs&&this.options.initWaitMs>0))return pending;let timer:ReturnType<typeof setTimeout>|undefined,abort:((()=>void))|undefined;const gate=new Promise<never>((_resolve,reject)=>{if(signal){abort=()=>reject(abortReason(signal));signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();}const timeoutMs=this.options.initWaitMs??15_000;if(timeoutMs>0)timer=setTimeout(()=>reject(new Error(`[RUNTIME_INIT_TIMEOUT] 来源运行时初始化超过 ${timeoutMs}ms`)),timeoutMs);});try{return await Promise.race([pending,gate]);}finally{if(timer)clearTimeout(timer);if(signal&&abort)signal.removeEventListener('abort',abort);}}
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
    const active=new Map(configs.map(config=>[config.id,runtimeKey(config)]));
    this.#desired.clear();for(const[id,key]of active)this.#desired.set(id,key);
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
    await Promise.allSettled(pending);
    const entries=[...this.#entries.values()];this.#entries.clear();
    await Promise.allSettled(entries.map(entry=>entry.adapter.destroy()));
  }
}

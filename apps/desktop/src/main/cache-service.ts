import { createHash } from 'node:crypto';
import { mkdir,readFile,readdir,rm,stat,utimes,writeFile } from 'node:fs/promises';
import path from 'node:path';
interface Meta{contentType:string;expiresAt:number;accessedAt:number;size:number;}
interface CacheEntry extends Meta{namespace:string;meta:string;data:string;}
export interface CacheValue{data:Buffer;contentType:string;}
export interface CacheNamespaceStats{namespace:string;bytes:number;files:number;}
export interface CacheStats{bytes:number;files:number;maxBytes:number;namespaces:CacheNamespaceStats[];}
export type CacheWriter=(file:string,data:string|Uint8Array,encoding?:BufferEncoding)=>Promise<void>;
const defaultWriter:CacheWriter=async(file,data,encoding)=>{if(encoding)await writeFile(file,data,encoding);else await writeFile(file,data);};
const cacheEntryKey=(file:string)=>process.platform==='win32'?file.toLowerCase():file;
const cacheScanBatchSize=8;
export class DiskCache{
  #maxBytes:number;readonly #writer:CacheWriter;
  #entriesByPath:Map<string,CacheEntry>|undefined;
  #trackedBytes=0;
  #nextExpiry=0;
  #pending:Promise<void>=Promise.resolve();
  readonly #reads=new Map<string,Promise<unknown>>();
  // One owner orders disk operations so pruning cannot see half-written pairs.
  #run<T>(operation:()=>Promise<T>):Promise<T>{
    const result=Promise.all([this.#pending,...this.#reads.values()].map(task=>task.catch(()=>{}))).then(operation);
    this.#pending=result.then(()=>{},()=>{});
    return result;
  }
  get(namespace:string,key:string,maxBytes=this.#maxBytes){
    const id=cacheEntryKey(this.#paths(namespace,key).data);
    const previous=this.#reads.get(id)??Promise.resolve();
    const result=Promise.all([this.#pending,previous.catch(()=>{})]).then(()=>this.#get(namespace,key,maxBytes));
    this.#reads.set(id,result);
    const finish=()=>{if(this.#reads.get(id)===result)this.#reads.delete(id);};
    void result.then(finish,finish);
    return result;
  }
  put(namespace:string,key:string,data:Buffer|Uint8Array,contentType='application/octet-stream',ttlMs=24*60*60*1000){const bytes=Buffer.from(data);return this.#run(()=>this.#put(namespace,key,bytes,contentType,ttlMs));}
  clear(namespace?:string){return this.#run(()=>this.#clear(namespace));}
  fileCount(){return this.#run(async()=>(this.#entriesByPath??await this.#refreshEntries()).size);}
  stats(){return this.#run(()=>this.#stats());}
  prune(){return this.#run(async()=>{await this.#refreshEntries();await this.#prune();});}
  constructor(readonly root:string,maxBytes=1024*1024*1024,writer:CacheWriter=defaultWriter,private readonly touch:typeof utimes=utimes){this.#maxBytes=maxBytes;this.#writer=writer;}
  init():Promise<void>{
    return this.#run(async()=>{
      await mkdir(this.root,{recursive:true});
      // Startup shares disk access with the renderer loading its first view.
      await this.#refreshEntries(1);
      await this.#prune();
    });
  }
  setMaxBytes(value:number):void{this.#maxBytes=Math.max(64*1024*1024,Math.min(value,8*1024*1024*1024));void this.prune().catch(()=>{/* A later explicit prune can retry a locked cache file. */});}
  #dir(namespace:string):string{return path.join(this.root,namespace.replace(/[^a-z0-9_-]/gi,'_'));}
  #id(key:string):string{return createHash('sha256').update(key).digest('hex');}
  #paths(namespace:string,key:string){const dir=this.#dir(namespace);const id=this.#id(key);return{dir,data:path.join(dir,`${id}.bin`),meta:path.join(dir,`${id}.json`)}}
  async #get(namespace:string,key:string,maxBytes=this.#maxBytes):Promise<CacheValue|undefined>{
    const p=this.#paths(namespace,key);
    try{
      const meta=JSON.parse(await readFile(p.meta,'utf8')) as Meta;
      if(meta.expiresAt<Date.now()){await this.#evictPair(p.meta,p.data);return undefined;}
      if((await stat(p.data)).size>maxBytes)return undefined;
      const data=await readFile(p.data);
      if(data.byteLength>maxBytes)return undefined;
      const accessedAt=Date.now();
      try{
        // A filesystem timestamp update cannot truncate the committed metadata.
        await this.touch(p.meta,accessedAt/1000,accessedAt/1000);
        const entry=this.#entriesByPath?.get(cacheEntryKey(p.data));
        if(entry)entry.accessedAt=accessedAt;
      }catch{/* A failed timestamp update must not reject a readable cache hit. */}
      return{data,contentType:meta.contentType};
    }catch{return undefined;}
  }
  async #put(namespace:string,key:string,bytes:Buffer,contentType:string,ttlMs:number):Promise<void>{
    if(bytes.byteLength>this.#maxBytes)throw new Error('Cache entry exceeds byte budget');
    const p=this.#paths(namespace,key);
    const meta:Meta={contentType,expiresAt:Date.now()+ttlMs,accessedAt:Date.now(),size:bytes.byteLength};
    for(let attempt=0;attempt<2;attempt++){
      try{
        await mkdir(p.dir,{recursive:true});
        await this.#writer(p.data,bytes);
        await this.#writer(p.meta,JSON.stringify(meta),'utf8');
        break;
      }catch(error){
        await this.#removePair(p.meta,p.data);
        if(attempt!==0||(error as NodeJS.ErrnoException).code!=='ENOSPC')throw error;
        await this.#clear();
      }
    }
    // Only the cache owner writes pairs. Scan on initialization, explicit maintenance,
    // or after invalidation, then account for successful writes and removals directly.
    const entries=this.#entriesByPath??await this.#refreshEntries();
    if(!Number.isFinite(meta.expiresAt)){await this.#evictPair(p.meta,p.data);return;}
    const id=cacheEntryKey(p.data);
    const previous=entries.get(id);
    this.#trackedBytes+=meta.size-(previous?.size??0);
    entries.set(id,{...meta,namespace:previous?.namespace??path.basename(p.dir),meta:p.meta,data:p.data});
    this.#nextExpiry=Math.min(this.#nextExpiry,meta.expiresAt);
    if(!(this.#trackedBytes<=this.#maxBytes)||this.#nextExpiry<=Date.now())await this.#prune();
  }
  async #removePair(meta:string,data:string):Promise<void>{
    // Preserve metadata if Windows denies deletion of the payload.
    await rm(data,{force:true});
    const id=cacheEntryKey(data);
    const entry=this.#entriesByPath?.get(id);
    if(entry){
      this.#trackedBytes-=entry.size;
      this.#entriesByPath?.delete(id);
    }
    await rm(meta,{force:true});
  }
  async #evictPair(meta:string,data:string):Promise<boolean>{
    try{
      await this.#removePair(meta,data);
      return true;
    }catch(error){
      const code=(error as NodeJS.ErrnoException).code;
      if(process.platform==='win32'&&(code==='EBUSY'||code==='EPERM'))return false;
      throw error;
    }
  }
  async #clear(namespace?:string):Promise<void>{
    this.#entriesByPath=undefined;
    this.#trackedBytes=0;
    this.#nextExpiry=0;
    if(namespace)await rm(this.#dir(namespace),{recursive:true,force:true});
    else for(const item of await readdir(this.root,{withFileTypes:true}).catch(()=>[]))if(item.isDirectory())await rm(path.join(this.root,item.name),{recursive:true,force:true});
  }
  async #stats():Promise<CacheStats>{const entries=await this.#refreshEntries();const grouped=new Map<string,{bytes:number;files:number}>();for(const item of entries.values()){const value=grouped.get(item.namespace)??{bytes:0,files:0};value.bytes+=item.size;value.files+=1;grouped.set(item.namespace,value);}return{bytes:this.#trackedBytes,files:entries.size,maxBytes:this.#maxBytes,namespaces:[...grouped.entries()].map(([namespace,value])=>({namespace,...value})).sort((a,b)=>b.bytes-a.bytes)};}
  async #prune():Promise<void>{
    const entries=this.#entriesByPath??await this.#refreshEntries();
    const now=Date.now();
    for(const item of entries.values()){
      if(item.expiresAt<=now)await this.#evictPair(item.meta,item.data);
    }
    if(!(this.#trackedBytes<=this.#maxBytes)){
      const oldest=[...entries.values()].filter(item=>item.expiresAt>now).sort((a,b)=>a.accessedAt-b.accessedAt);
      for(const item of oldest){
        await this.#evictPair(item.meta,item.data);
        if(this.#trackedBytes<=this.#maxBytes)break;
      }
    }
    this.#nextExpiry=Infinity;
    for(const item of entries.values())this.#nextExpiry=Math.min(this.#nextExpiry,item.expiresAt);
  }
  async #refreshEntries(batchSize=cacheScanBatchSize):Promise<Map<string,CacheEntry>>{
    const output=new Map<string,CacheEntry>();
    for(const folder of await readdir(this.root,{withFileTypes:true}).catch(()=>[])){
      if(!folder.isDirectory())continue;
      const namespace=folder.name,dir=path.join(this.root,namespace);
      const files=await readdir(dir);
      // Clean up scratch files from earlier builds that rewrote access metadata.
      for(const file of files){
        if(/^[a-f0-9]{64}\.json\.touch$/.test(file))await rm(path.join(dir,file),{force:true}).catch(()=>{});
      }
      // Only cache-owned hashed pairs are eligible for repair; leave unrelated files alone.
      const ids=new Set(files.filter(file=>/^[a-f0-9]{64}\.(bin|json)$/.test(file)).map(file=>file.slice(0,64)));
      const readEntry=async(id:string):Promise<CacheEntry|undefined>=>{
        const meta=path.join(dir,id+'.json'),data=path.join(dir,id+'.bin');
        try{
          const [text,metaInfo,dataInfo]=await Promise.all([readFile(meta,'utf8'),stat(meta),stat(data)]);
          const value=JSON.parse(text) as Meta;
          if(!value||typeof value.contentType!=='string'||!Number.isFinite(value.expiresAt)||!Number.isFinite(value.accessedAt))throw new SyntaxError('Invalid cache metadata');
          return {...value,accessedAt:Math.max(value.accessedAt,metaInfo.mtimeMs),size:dataInfo.size,namespace,meta,data};
        }catch(error){
          if(!(error instanceof SyntaxError)&&(error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
          await this.#evictPair(meta,data);
          return undefined;
        }
      };
      if(batchSize===1){
        for(const id of ids){
          const entry=await readEntry(id);
          if(entry)output.set(cacheEntryKey(entry.data),entry);
        }
        continue;
      }
      const entries=[...ids];
      for(let offset=0;offset<entries.length;offset+=batchSize){
        // Let every repair settle before releasing the cache operation queue.
        const batch=await Promise.allSettled(entries.slice(offset,offset+batchSize).map(readEntry));
        for(const result of batch){
          if(result.status==='rejected')throw result.reason;
          if(result.value)output.set(cacheEntryKey(result.value.data),result.value);
        }
      }
    }
    this.#entriesByPath=output;
    this.#trackedBytes=0;
    this.#nextExpiry=Infinity;
    for(const item of output.values()){
      this.#trackedBytes+=item.size;
      this.#nextExpiry=Math.min(this.#nextExpiry,item.expiresAt);
    }
    return output;
  }
}

import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,rename,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import type {DrpyEngineBundle,DrpyEngineManifest} from './drpy-engine-manager.js';
import type {Drpy2Profile} from './drpy2-profile.js';

export interface EngineBinding{
  sourceId:string;
  configRevision:string;
  accountProfile:string;
}
interface BindingRef{
  digest:string;
  profileId:string;
  hostAbiVersion:string;
  validatedAt:number;
}
export interface BindingFile{schemaVersion:1;current?:BindingRef;previous?:BindingRef;}
interface BundleFile{
  schemaVersion:1;
  entryUrl:string;
  modules:Record<string,string>;
  manifest:DrpyEngineManifest;
}
export interface LoadedValidatedEngine{bundle:DrpyEngineBundle;profileId:string;hostAbiVersion:string;slot:'current'|'previous';}
function sha(value:string):string{return createHash('sha256').update(value).digest('hex');}
function bindingId(binding:EngineBinding):string{return sha([binding.sourceId,binding.configRevision,binding.accountProfile].join('\u0000'));}
function cacheSafeUrl(value:string):boolean{
  try{const url=new URL(value);return !url.username&&!url.password&&!url.search&&!url.hash&&(url.protocol==='http:'||url.protocol==='https:');}
  catch{return false;}
}
function bundleIsCacheSafe(bundle:DrpyEngineBundle):boolean{
  return cacheSafeUrl(bundle.entryUrl)&&Object.keys(bundle.modules).every(cacheSafeUrl);
}
function validateBundleFile(file:BundleFile,expectedDigest:string):DrpyEngineBundle|undefined{
  if(file.schemaVersion!==1||file.manifest.sha256!==expectedDigest)return;
  const entry=file.modules[file.entryUrl];if(typeof entry!=='string'||sha(entry)!==expectedDigest)return;
  for(const dep of file.manifest.dependencies){const code=file.modules[dep.url];if(typeof code!=='string'||sha(code)!==dep.sha256)return;}
  return{entryUrl:file.entryUrl,modules:file.modules,manifest:{...file.manifest,lastKnownGood:true,validation:'rule-validated'},fallback:true};
}

export class ValidatedEngineStore{
  constructor(readonly rootDir:string|undefined){}
  #bundlePath(digest:string):string|undefined{return this.rootDir?path.join(this.rootDir,'bundles',`${digest}.json`):undefined;}
  #bindingPath(binding:EngineBinding):string|undefined{return this.rootDir?path.join(this.rootDir,'bindings',`${bindingId(binding)}.json`):undefined;}
  async #readBinding(binding:EngineBinding):Promise<BindingFile>{
    const file=this.#bindingPath(binding);if(!file)return{schemaVersion:1};
    try{const parsed=JSON.parse(await readFile(file,'utf8')) as BindingFile;return parsed.schemaVersion===1?parsed:{schemaVersion:1};}
    catch{return{schemaVersion:1};}
  }
  async #writeJson(file:string,value:unknown,immutable=false):Promise<void>{
    await mkdir(path.dirname(file),{recursive:true});const temp=`${file}.${randomUUID()}.tmp`;
    await writeFile(temp,JSON.stringify(value),'utf8');
    try{await rename(temp,file);}
    catch(error){
      const code=(error as NodeJS.ErrnoException).code,conflict=code==='EPERM'||code==='EEXIST'||code==='ENOTEMPTY';
      if(conflict&&immutable){try{await readFile(file,'utf8');return;}catch{/* target absent: rethrow original */}}
      if(conflict&&!immutable){await rm(file,{force:true});await rename(temp,file);return;}
      throw error;
    }finally{await rm(temp,{force:true}).catch(()=>undefined);}
  }
  async saveValidated(binding:EngineBinding,bundle:DrpyEngineBundle,profile:Drpy2Profile):Promise<boolean>{
    if(!this.rootDir||!bundleIsCacheSafe(bundle))return false;
    const bundlePath=this.#bundlePath(bundle.manifest.sha256),bindingPath=this.#bindingPath(binding);if(!bundlePath||!bindingPath)return false;
    const persisted:BundleFile={schemaVersion:1,entryUrl:bundle.entryUrl,modules:bundle.modules,manifest:{...bundle.manifest,lastKnownGood:true,validation:'rule-validated'}};
    await this.#writeJson(bundlePath,persisted,true);
    const existing=await this.#readBinding(binding),next:BindingRef={digest:bundle.manifest.sha256,profileId:profile.id,hostAbiVersion:profile.hostAbiVersion,validatedAt:Date.now()};
    const previous=existing.current&&existing.current.digest!==next.digest?existing.current:existing.previous;
    await this.#writeJson(bindingPath,{schemaVersion:1,current:next,...(previous?{previous}:{})} satisfies BindingFile);return true;
  }
  async load(binding:EngineBinding):Promise<LoadedValidatedEngine|undefined>{
    const record=await this.#readBinding(binding);
    for(const slot of ['current','previous'] as const){
      const ref=record[slot];if(!ref)continue;const file=this.#bundlePath(ref.digest);if(!file)continue;
      try{
        const parsed=JSON.parse(await readFile(file,'utf8')) as BundleFile,bundle=validateBundleFile(parsed,ref.digest);
        if(bundle)return{bundle,profileId:ref.profileId,hostAbiVersion:ref.hostAbiVersion,slot};
      }catch{/* corrupt/missing slot: try previous */}
    }
    return undefined;
  }
  async snapshot(binding:EngineBinding):Promise<BindingFile>{return this.#readBinding(binding);}
}

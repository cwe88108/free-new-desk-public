import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { init as initModuleLexer,parse as parseModule } from 'es-module-lexer';
import type { RequestBroker } from '@free-new-desk/source-sdk';

const MAX_MODULE_BYTES=2*1024*1024,MAX_GRAPH_BYTES=8*1024*1024,MAX_MODULES=32,MAX_DEPTH=8,CACHE_TTL_MS=30*60_000,MAX_REDIRECTS=8;
export type DrpyValidation='downloaded'|'engine-validated'|'rule-validated';
export interface DrpyEngineManifest{engineUrl:string;family:'drpy2-esm';version?:string;sha256:string;dependencies:Array<{url:string;sha256:string}>;fetchedAt:number;lastKnownGood:boolean;validation:DrpyValidation;}
export interface DrpyEngineBundle{entryUrl:string;modules:Record<string,string>;manifest:DrpyEngineManifest;fallback:boolean;}
const sharedCache=new Map<string,{bundle:DrpyEngineBundle;at:number}>(),sharedPending=new Map<string,Promise<DrpyEngineBundle>>();
function hash(value:string):string{return createHash('sha256').update(value).digest('hex');}
function privateIpv4(address:string):boolean{const p=address.split('.').map(Number);if(p.length!==4||p.some(v=>!Number.isInteger(v)||v<0||v>255))return true;const[a,b]=p as[number,number,number,number];return a===0||a===10||a===127||a>=224||(a===100&&b>=64&&b<=127)||(a===169&&b===254)||(a===172&&b>=16&&b<=31)||(a===192&&b===168)||(a===198&&(b===18||b===19));}
function privateAddress(address:string):boolean{const value=address.toLowerCase().split('%')[0]??'';if(isIP(value)===4)return privateIpv4(value);if(isIP(value)!==6)return true;if(value==='::'||value==='::1'||value.startsWith('fc')||value.startsWith('fd')||/^fe[89ab]/.test(value)||value.startsWith('ff'))return true;const mapped=/^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value);return Boolean(mapped?.[1]&&privateIpv4(mapped[1]));}
function isPrivateHost(hostname:string):boolean{const host=hostname.toLowerCase().replace(/^\[|\]$/g,'');if(host==='localhost'||host.endsWith('.localhost')||host==='metadata.google.internal')return true;return isIP(host)>0&&privateAddress(host);}
export function assertSafeDrpyUrl(value:string):URL{let url:URL;try{url=new URL(value);}catch{throw new Error(`DRPY_REQ_BLOCKED: invalid URL ${value}`);}if(url.protocol!=='http:'&&url.protocol!=='https:')throw new Error(`DRPY_REQ_BLOCKED: protocol ${url.protocol}`);if(isPrivateHost(url.hostname))throw new Error(`DRPY_REQ_BLOCKED: private host ${url.hostname}`);return url;}
export async function assertSafeDrpyNetworkUrl(value:string):Promise<URL>{const url=assertSafeDrpyUrl(value),host=url.hostname.replace(/^\[|\]$/g,'');if(isIP(host))return url;let records;try{records=await lookup(host,{all:true,verbatim:true});}catch(error){throw new Error(`DRPY_REQ_DNS_FAILED: ${error instanceof Error?error.message:String(error)}`);}if(!records.length)throw new Error(`DRPY_REQ_DNS_FAILED: no address for ${host}`);for(const record of records)if(privateAddress(record.address))throw new Error(`DRPY_REQ_BLOCKED: DNS resolved private address for ${host}`);return url;}
export async function parseDrpyImportSpecifiers(code:string):Promise<string[]>{await initModuleLexer;const[imports]=parseModule(code),values=new Set<string>();for(const item of imports){if(item.d===-2)continue;if(!item.n)throw new Error('DRPY_ENGINE_IMPORT_BLOCKED: non-literal dynamic import');values.add(item.n);}return[...values];}
function engineVersion(code:string):string|undefined{return /\b(?:drpy2\D{0,20})?(3\.9(?:\.\d+)?(?:beta\d+)?)/i.exec(code)?.[1];}
export class DrpyEngineManager{
  constructor(private readonly broker:RequestBroker){}
  async #fetchText(sourceId:string,value:string,maxBytes=MAX_MODULE_BYTES):Promise<{url:string;text:string}>{
    let current=assertSafeDrpyUrl(value).toString();
    for(let redirects=0;redirects<=MAX_REDIRECTS;redirects+=1){
      await assertSafeDrpyNetworkUrl(current);const response=await this.broker.request({sourceId,url:current,timeoutMs:10_000,retries:0,maxBytes,redirect:'manual'});
      if([301,302,303,307,308].includes(response.status)){const location=response.headers.get('location');await response.body?.cancel();if(!location)throw new Error(`DRPY_ENGINE_REDIRECT_INVALID: ${response.status}`);current=new URL(location,current).toString();continue;}
      if(!response.ok)throw new Error(`HTTP ${response.status} for Drpy2 engine request`);return{url:response.url||current,text:await response.text()};
    }
    throw new Error('DRPY_ENGINE_REDIRECT_LIMIT');
  }
  async peekSource(sourceId:string,url:string):Promise<string>{return(await this.#fetchText(sourceId,url)).text;}
  async load(sourceId:string,engineUrl:string):Promise<DrpyEngineBundle>{
    const entry=assertSafeDrpyUrl(engineUrl).toString(),cached=sharedCache.get(entry);if(cached&&Date.now()-cached.at<CACHE_TTL_MS)return cached.bundle;
    const pending=sharedPending.get(entry);if(pending)return pending;const work=this.#download(sourceId,entry,cached).finally(()=>{if(sharedPending.get(entry)===work)sharedPending.delete(entry);});sharedPending.set(entry,work);return work;
  }
  async #download(sourceId:string,entry:string,cached?:{bundle:DrpyEngineBundle;at:number}):Promise<DrpyEngineBundle>{
    try{const modules:Record<string,string>={},visiting=new Set<string>();let totalBytes=0;const entryOrigin=new URL(entry).origin;
      const visit=async(url:string,depth:number):Promise<void>=>{if(url in modules)return;if(depth>MAX_DEPTH)throw new Error('DRPY_ENGINE_GRAPH_LIMIT: import depth');if(Object.keys(modules).length>=MAX_MODULES)throw new Error('DRPY_ENGINE_GRAPH_LIMIT: module count');if(visiting.has(url))return;visiting.add(url);const parsed=assertSafeDrpyUrl(url);if(parsed.origin!==entryOrigin)throw new Error(`DRPY_ENGINE_IMPORT_BLOCKED: cross-origin ${url}`);const fetched=await this.#fetchText(sourceId,url),code=fetched.text;if(fetched.url!==url&&new URL(fetched.url).origin!==entryOrigin)throw new Error(`DRPY_ENGINE_IMPORT_BLOCKED: redirect cross-origin ${fetched.url}`);const size=Buffer.byteLength(code);if(size>MAX_MODULE_BYTES)throw new Error('DRPY_ENGINE_MODULE_TOO_LARGE');totalBytes+=size;if(totalBytes>MAX_GRAPH_BYTES)throw new Error('DRPY_ENGINE_GRAPH_LIMIT: total bytes');modules[url]=code;for(const specifier of await parseDrpyImportSpecifiers(code)){if(!/^\.\.?\//.test(specifier))throw new Error(`DRPY_ENGINE_IMPORT_BLOCKED: ${specifier}`);await visit(new URL(specifier,url).toString(),depth+1);}visiting.delete(url);};
      await visit(entry,0);const deps=Object.entries(modules).filter(([url])=>url!==entry).map(([url,code])=>({url,sha256:hash(code)})),version=engineVersion(modules[entry]??''),manifest:DrpyEngineManifest={engineUrl:entry,family:'drpy2-esm',...(version?{version}:{}),sha256:hash(modules[entry]??''),dependencies:deps,fetchedAt:Date.now(),lastKnownGood:false,validation:'downloaded'};const bundle:DrpyEngineBundle={entryUrl:entry,modules,manifest,fallback:false};sharedCache.set(entry,{bundle,at:Date.now()});return bundle;
    }catch(error){if(cached?.bundle.manifest.lastKnownGood)return{...cached.bundle,fallback:true};throw error;}
  }
  markValidated(entryUrl:string,validation:Exclude<DrpyValidation,'downloaded'>):void{const cached=sharedCache.get(entryUrl);if(!cached)return;cached.bundle={...cached.bundle,manifest:{...cached.bundle.manifest,validation,lastKnownGood:true}};cached.at=Date.now();sharedCache.set(entryUrl,cached);}
  clear():void{/* shared immutable engine bytes intentionally survive per-source adapter teardown */}
}

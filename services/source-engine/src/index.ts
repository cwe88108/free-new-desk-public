import type {CategoryResult,DetailResult,HomeResult,PlaybackDescriptorV2,PlayResult,SearchResult,SourceAdapter,SourceAuditResult,SourceConfig,SourceContext,SourceSummary} from '@free-new-desk/contracts';
import {AlistAdapter,CmsJsonAdapter,CmsXmlAdapter,DeclarativeRuleAdapter,Type4Adapter} from '@free-new-desk/source-adapters';
import {RequestBroker} from '@free-new-desk/source-sdk';
import {JavaSpiderAdapter} from './java-spider-adapter.js';
import {PluginAdapter} from './plugin-adapter.js';
import {SpiderAdapter} from './spider-adapter.js';
import {Drpy2Adapter} from './drpy2-adapter.js';
import {classifyRuntimeFlavor,runtimeHint} from './runtime-classifier.js';
import {DoubanAdapter} from './douban-adapter.js';
import {legacyPlayResultToDescriptorV2} from './playback-descriptor.js';
import {RuntimeManager,runtimeKey} from './runtime-manager.js';

const MAX_EXECUTABLE=6,IDLE_MS=180_000;
const runtimeProbeBroker=new RequestBroker();
function executable(config:SourceConfig):boolean{return config.kind==='T3_JS'||config.kind==='T3_JAR'||config.kind==='PLUGIN'||config.kind==='T4_CATVOD';}
function isDoubanSource(config:SourceConfig):boolean{return /豆瓣|douban/i.test(`${config.id} ${config.name}`);}
function runtimeProxyResult(result:PlaybackDescriptorV2):boolean{return result.resolutionIntent==='runtime-proxy'||result.candidates.some(candidate=>candidate.target.kind==='runtime-proxy'||candidate.target.kind==='external-bridge');}

async function useDrpy2(config:SourceConfig,signal?:AbortSignal):Promise<boolean>{
  const hint=runtimeHint(config);if(hint==='drpy2'){if(process.env.DRPY2_RUNTIME_V2==='0')throw new Error('DRPY_RUNTIME_DISABLED: Drpy2 runtime is disabled');if(!/^https?:\/\//i.test(config.endpoint))throw new Error('DRPY_UNSUPPORTED_ENGINE: Drpy2 engine URL must be HTTP(S)');return true;}
  if(!/^https?:\/\//i.test(config.endpoint))return false;if(process.env.DRPY2_RUNTIME_V2==='0')return false;
  runtimeProbeBroker.bindContext(config.id,{configRevision:config.configRevision??'legacy',...(config.headers?{defaultHeaders:config.headers}:{})});
  let code:string;try{code=await runtimeProbeBroker.text({sourceId:config.id,url:config.endpoint,timeoutMs:10_000,retries:0,maxBytes:2*1024*1024,...(signal?{signal}:{})});}catch(error){throw new Error(`DRPY_RUNTIME_PROBE_FAILED: ${error instanceof Error?error.message:String(error)}`);}
  const classified=classifyRuntimeFlavor(config,code);if(classified.flavor==='drpy2-esm')return true;if(classified.flavor==='unsupported')throw new Error(`DRPY_RUNTIME_UNSUPPORTED: ${classified.signals.join(',')||'unknown ESM shape'}`);return false;
}
export class SourceEngine{
  readonly #configs=new Map<string,SourceConfig>();readonly #failures=new Map<string,string>();readonly #notices=new Map<string,string>();readonly #auditPending=new Map<string,Promise<SourceAuditResult>>();
  readonly #runtime=new RuntimeManager({maxExecutable:MAX_EXECUTABLE,idleMs:IDLE_MS,isExecutable:executable,create:config=>this.#initializeAdapter(config)});
  #proxyBaseUrl='';#proxyToken='';#engineStoreDir='';
  configureRuntime(config:{proxyBaseUrl?:string;proxyToken?:string;engineStoreDir?:string}):void{this.#proxyBaseUrl=config.proxyBaseUrl??'';this.#proxyToken=config.proxyToken??'';this.#engineStoreDir=config.engineStoreDir??'';}
  async replaceSources(sources:SourceConfig[]):Promise<void>{
    const next=sources.filter(source=>source.enabled),previous=new Map(this.#configs);this.#configs.clear();
    for(const config of next){this.#configs.set(config.id,config);const old=previous.get(config.id);if(!old||runtimeKey(old)!==runtimeKey(config)){this.#failures.delete(config.id);this.#notices.delete(config.id);}}
    for(const id of previous.keys())if(!this.#configs.has(id)){this.#failures.delete(id);this.#notices.delete(id);}
    await this.#runtime.reconcile(next);
  }
  async #createAdapter(config:SourceConfig,signal?:AbortSignal):Promise<SourceAdapter|undefined>{switch(config.kind){
    case'T1_JSON':return new CmsJsonAdapter(config.endpoint);case'T0_XML':return new CmsXmlAdapter(config.endpoint);
    case'T4_EXT':return new Type4Adapter(config.endpoint,config.ext,config.type4Dialect,config.configRevision??'legacy');
    case'T3_XYQ':case'T3_XBPQ':return new DeclarativeRuleAdapter(config.endpoint,config.ext);case'DRIVE_ALIST':return new AlistAdapter(config.endpoint);
    case'T3_JS':return await useDrpy2(config,signal)?new Drpy2Adapter(config):new SpiderAdapter(config);case'T3_JAR':return new JavaSpiderAdapter(config);case'PLUGIN':return new PluginAdapter(config);
    case'T4_CATVOD':if(!/\.js(?:\?|$)/i.test(config.ext??config.endpoint))return new Type4Adapter(config.endpoint,config.ext,config.type4Dialect,config.configRevision??'legacy');return await useDrpy2(config,signal)?new Drpy2Adapter(config):new SpiderAdapter(config);default:return undefined;
  }}
  async #initializeAdapter(config:SourceConfig):Promise<SourceAdapter>{
    const adapter=await this.#createAdapter(config);if(!adapter)throw new Error(`Unsupported source kind: ${config.kind}`);
    const context:SourceContext={sourceId:config.id,configRevision:config.configRevision??'legacy',accountProfile:'default',...(this.#proxyBaseUrl?{proxyBaseUrl:this.#proxyBaseUrl}:{}),...(this.#proxyToken?{proxyToken:this.#proxyToken}:{}),...(this.#engineStoreDir?{engineStoreDir:this.#engineStoreDir}:{}),...(config.headers?{requestHeaders:config.headers}:{})};
    try{await adapter.init(context);this.#failures.delete(config.id);this.#notices.delete(config.id);return adapter;}
    catch(error){
      const message=error instanceof Error?error.message:String(error);
      if(config.kind==='T3_JAR'&&/ClassNotFoundException/i.test(message)&&isDoubanSource(config)){
        await adapter.destroy().catch(()=>undefined);const fallback=new DoubanAdapter(config);await fallback.init(context);this.#failures.delete(config.id);
        this.#notices.set(config.id,`配置引用的 Spider 类不在 JAR 中，已自动回退到内置豆瓣源（浏览/搜索/详情/官方预告片播放）。原始错误：${message}`);return fallback;
      }
      await adapter.destroy().catch(()=>undefined);this.#failures.set(config.id,message);throw error;
    }
  }
  #config(sourceId:string):SourceConfig{const config=this.#configs.get(sourceId);if(!config)throw new Error(this.#failures.get(sourceId)??'Source is disabled or missing');return config;}
  async #invoke<T>(sourceId:string,signal:AbortSignal|undefined,action:(adapter:SourceAdapter,acquireLease:()=>string)=>Promise<T>):Promise<T>{
    const config=this.#config(sourceId);return this.#runtime.withRuntime(config,signal,(adapter,controls)=>action(adapter,controls.acquireLease));
  }
  listSources():SourceSummary[]{return[...this.#configs.values()].map(config=>({id:config.id,name:config.name,kind:config.kind,enabled:config.enabled,trust:config.trust,...(config.searchable!==undefined?{searchable:config.searchable}:{})})).sort((a,b)=>a.name.localeCompare(b.name));}
  getFailure(sourceId:string):string|undefined{return this.#failures.get(sourceId);}
  getNotice(sourceId:string):string|undefined{return this.#notices.get(sourceId);}
  async getHome(sourceId:string,signal?:AbortSignal):Promise<HomeResult>{
    const result=await this.#invoke(sourceId,signal,(adapter)=>adapter.getHome(signal));const allow=this.#configs.get(sourceId)?.categories;
    if(!allow?.length||!result.categories?.length)return result;const names=new Set(allow),categories=result.categories.filter(item=>names.has(item.name)),ids=new Set(categories.map(item=>item.id));
    const filters=result.filters?Object.fromEntries(Object.entries(result.filters).filter(([id])=>ids.has(id))):undefined;return{...result,categories,...(filters&&Object.keys(filters).length?{filters}:result.filters?{filters:{}}:{})};
  }
  async getCategory(sourceId:string,categoryId:string,page=1,filters:Record<string,string>={},signal?:AbortSignal):Promise<CategoryResult>{return this.#invoke(sourceId,signal,adapter=>adapter.getCategory(categoryId,page,filters,signal));}
  async search(sourceId:string,keyword:string,page=1,signal?:AbortSignal):Promise<SearchResult>{return this.#invoke(sourceId,signal,adapter=>adapter.search(keyword,page,signal));}
  async getDetail(sourceId:string,ids:string[],signal?:AbortSignal):Promise<DetailResult>{return this.#invoke(sourceId,signal,adapter=>adapter.getDetail(ids,signal));}
  async getPlay(sourceId:string,flag:string,episodeId:string,signal?:AbortSignal):Promise<PlayResult>{return this.#invoke(sourceId,signal,adapter=>adapter.getPlay(flag,episodeId,signal));}
  async getPlayV2(sourceId:string,flag:string,episodeId:string,signal?:AbortSignal):Promise<PlaybackDescriptorV2>{
    const config=this.#config(sourceId);return this.#runtime.withRuntime(config,signal,async(adapter,controls)=>{
      const result=adapter.getPlayV2?await adapter.getPlayV2(flag,episodeId,signal):legacyPlayResultToDescriptorV2({sourceId,configRevision:config.configRevision??'legacy',originProfileId:`legacy-${config.kind}`,flag,result:await adapter.getPlay(flag,episodeId,signal)});
      return runtimeProxyResult(result)?{...result,runtimeLeaseId:controls.acquireLease()}:result;
    });
  }
  async releaseLease(leaseId:string):Promise<boolean>{return this.#runtime.releaseLease(leaseId);}
  async audit(sourceId:string):Promise<SourceAuditResult>{
    const existing=this.#auditPending.get(sourceId);if(existing)return existing;
    const work=this.#runAudit(sourceId).finally(()=>{if(this.#auditPending.get(sourceId)===work)this.#auditPending.delete(sourceId);});this.#auditPending.set(sourceId,work);return work;
  }
  async #runAudit(sourceId:string):Promise<SourceAuditResult>{
    const stages:SourceAuditResult['stages']=[],run=async(stage:string,action:()=>Promise<unknown>)=>{const started=performance.now();try{const result=await action();stages.push({stage,ok:true,durationMs:Math.round(performance.now()-started)});return result;}catch(error){stages.push({stage,ok:false,durationMs:Math.round(performance.now()-started),message:error instanceof Error?error.message:String(error)});return undefined;}};
    const missing=(stage:string,message:string)=>stages.push({stage,ok:false,durationMs:0,message});
    const skipped=(stage:string,message:string)=>stages.push({stage,ok:true,durationMs:0,message:`SKIPPED: ${message}`});
    const home=await run('home',()=>this.getHome(sourceId)) as HomeResult|undefined;
    const category=home?.categories?.[0];let categoryResult:CategoryResult|undefined;
    if(category)categoryResult=await run('category',()=>this.getCategory(sourceId,category.id,1)) as CategoryResult|undefined;else missing('category','来源未返回可审计分类');
    const first=home?.items[0]??categoryResult?.items[0];
    if(this.#configs.get(sourceId)?.searchable===false)skipped('search','来源声明 searchable=false');else await run('search',()=>this.search(sourceId,first?.name??'test',1));
    let detail:DetailResult|undefined;if(first)detail=await run('detail',()=>this.getDetail(sourceId,[first.id])) as DetailResult|undefined;else missing('detail','首页与首分类均未返回可审计条目');
    const episode=detail?.episodes[0];
    if(episode){const descriptor=await run('play',()=>this.getPlayV2(sourceId,episode.flag,episode.id)) as PlaybackDescriptorV2|undefined;if(descriptor){const stage=stages.at(-1);if(stage?.stage==='play')stage.message='V2 播放描述已返回；本审计未调用 PlayerHost。';if(descriptor.runtimeLeaseId)await this.releaseLease(descriptor.runtimeLeaseId);}}
    else missing('play','详情未返回可审计播放线路');
    const result:SourceAuditResult={sourceId,ok:stages.length===5&&stages.every(stage=>stage.ok),stages,checkedAt:new Date().toISOString(),scope:'source-interface'};
    const notice=this.#notices.get(sourceId);if(notice)result.notice=notice;return result;
  }
  async pruneIdle():Promise<void>{await this.#runtime.pruneIdle();}
  runtimeSnapshot(){return this.#runtime.snapshot();}
  async destroy():Promise<void>{await this.#runtime.destroy();this.#configs.clear();this.#failures.clear();this.#notices.clear();this.#auditPending.clear();}
}

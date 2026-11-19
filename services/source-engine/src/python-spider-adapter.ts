import {spawn, type ChildProcessWithoutNullStreams} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {SourceAdapter, SourceConfig, SourceContext, HomeResult, CategoryResult, DetailResult, SearchResult, PlayResult} from '@free-new-desk/contracts';
import {assertExecutableTrusted, loadPythonExecutable} from './executable-trust.js';
import {executableEnvironment} from './trusted-worker.js';
import {PYTHON_HOST} from './python-host.js';
import {PYTHON_PROFILE} from './python-profile.js';
import {probePythonRuntime} from './python-runtime.js';
import {normalizeSpiderHome, normalizeSpiderCategory, normalizeSpiderDetail, normalizeSpiderSearch, normalizeSpiderPlay} from './result-normalizer.js';

const MAX_FRAME = 4 * 1024 * 1024;
export function pythonFailureDetail(value:unknown):string{
  // Source exception names are untrusted too; never echo arbitrary names or text.
  const details:Record<string,string>={TimeoutError:'请求超时',ConnectionError:'连接失败',ConnectionRefusedError:'连接被拒绝',URLError:'网络请求失败',HTTPError:'HTTP响应异常',SSLError:'TLS连接失败',ModuleNotFoundError:'缺少Python模块',ImportError:'模块导入失败',SyntaxError:'Python语法错误',TypeError:'调用参数或类型不兼容',AttributeError:'缺少属性或方法',NotImplementedError:'方法未实现',ValueError:'数据值不符合要求',AssertionError:'来源内部断言失败',OSError:'系统或网络操作失败'};
  return typeof value==='string'&&Object.hasOwn(details,value)?`；${value}：${details[value]}`:'';
}
type Pending = {resolve:(value:unknown)=>void; reject:(error:Error)=>void; cleanup:()=>void};
/** Trusted-code preview only. No OS sandbox or broker-enforced Python networking. */
export class PythonSpiderAdapter implements SourceAdapter {
  #child:ChildProcessWithoutNullStreams|undefined;
  #closed:Promise<void>|undefined;
  #stopping:Promise<void>|undefined;
  #stopError:Error|undefined;
  #directory='';
  #buffer=Buffer.alloc(0);
  readonly #pending=new Map<string,Pending>();
  constructor(private readonly config:SourceConfig, private readonly timeoutMs=15_000){}

  async init(ctx:SourceContext,signal?:AbortSignal):Promise<void>{
    signal?.throwIfAborted();
    if(process.env.FND_PYTHON_TRUSTED_RUNTIME!=='1')throw new Error('[SRC_PYTHON_RUNTIME_DISABLED] Python 可信代码预览未启用；需要 CPython 3.10+，不是安全沙箱');
    const loaded=await loadPythonExecutable(this.config,undefined,signal);
    signal?.throwIfAborted();
    await assertExecutableTrusted(this.config,ctx,loaded.artifacts);
    const runtime=await probePythonRuntime(signal);
    this.#directory=await mkdtemp(path.join(os.tmpdir(),'fnd-python-'));
    if(signal?.aborted){await this.#stop();signal.throwIfAborted();}
    const child=spawn(runtime.command,['-I','-S','-u','-X','utf8','-c',PYTHON_HOST],{
      cwd:this.#directory,env:executableEnvironment(),windowsHide:true,detached:process.platform!=='win32',stdio:['pipe','pipe','pipe'],
    });
    this.#child=child;
    this.#closed=new Promise(resolve=>child.once('close',()=>{this.#rejectAll(new Error('[SRC_PYTHON_EXITED] Python host stopped; reset the source to retry'));resolve();}));
    child.on('error',()=>{this.#rejectAll(new Error('[SRC_PYTHON_NOT_FOUND] CPython 3.10+ could not be started'));void this.#stop();});
    child.stdin.on('error',()=>{this.#rejectAll(new Error('[SRC_PYTHON_EXITED] Python input closed'));void this.#stop();});
    child.stdout.on('data',(chunk:Buffer)=>this.#consume(chunk));
    let stderrBytes=0;
    child.stderr.on('data',(chunk:Buffer)=>{stderrBytes+=chunk.length;if(stderrBytes>MAX_FRAME){this.#rejectAll(new Error('[SRC_PYTHON_OUTPUT_LIMIT] Python output exceeded limit'));void this.#stop();}});
    try{await this.#request('init',[loaded.code,this.config.ext===loaded.artifacts[0]?.location?'':this.config.ext??''],signal);}
    catch(error){await this.#stop();throw error;}
  }
  #rejectAll(error:Error):void{for(const pending of this.#pending.values()){pending.cleanup();pending.reject(error);}this.#pending.clear();}
  #consume(chunk:Buffer):void{
    if(this.#buffer.length+chunk.length>MAX_FRAME){this.#rejectAll(new Error('[SRC_PYTHON_OUTPUT_LIMIT] Python frame exceeded limit'));void this.#stop();return;}
    this.#buffer=Buffer.concat([this.#buffer,chunk]);
    for(;;){const newline=this.#buffer.indexOf(10);if(newline<0)return;const line=this.#buffer.subarray(0,newline);this.#buffer=this.#buffer.subarray(newline+1);
      try{const frame=JSON.parse(line.toString('utf8')) as {id?:unknown;ok?:unknown;result?:unknown;error?:unknown};
        if(typeof frame.id!=='string'||typeof frame.ok!=='boolean'||!this.#pending.has(frame.id))throw new Error('bad frame');
        const pending=this.#pending.get(frame.id)!;this.#pending.delete(frame.id);pending.cleanup();
        if(frame.ok)pending.resolve(frame.result);else pending.reject(new Error(`[SRC_PYTHON_INVOKE_FAILED] Spider failed the ${PYTHON_PROFILE} contract${pythonFailureDetail(frame.error)}`));
      }catch{this.#rejectAll(new Error('[SRC_PYTHON_PROTOCOL_INVALID] Invalid Python response'));void this.#stop();return;}
    }
  }
  #request(method:string,args:unknown[],signal?:AbortSignal):Promise<unknown>{
    if(signal?.aborted)return Promise.reject(new DOMException('Aborted','AbortError'));
    const child=this.#child;
    if(!child||this.#stopping||child.exitCode!==null)return Promise.reject(new Error('[SRC_PYTHON_EXITED] Reset the Python source before retrying'));
    const id=randomUUID(),payload=JSON.stringify({id,method,args})+'\n';
    if(Buffer.byteLength(payload)>MAX_FRAME)return Promise.reject(new Error('[SRC_PYTHON_INPUT_LIMIT] Python request exceeded limit'));
    return new Promise((resolve,reject)=>{
      const fail=(error:Error)=>{this.#rejectAll(error);void this.#stop();};
      const abort=()=>fail(new DOMException('Aborted','AbortError'));
      const timer=setTimeout(()=>fail(new Error('[SRC_PYTHON_TIMEOUT] Python request timed out')),this.timeoutMs);
      const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);};
      this.#pending.set(id,{resolve,reject,cleanup});signal?.addEventListener('abort',abort,{once:true});
      if(signal?.aborted){abort();return;}child.stdin.write(payload);
    });
  }
  async getHome(signal?:AbortSignal):Promise<HomeResult>{
    const home=normalizeSpiderHome(await this.#request('homeContent',[true],signal));
    if(!home.items.length)home.items=normalizeSpiderHome(await this.#request('homeVideoContent',[],signal)).items;
    return home;
  }
  async getCategory(id:string,page:number,filters:Record<string,string>={},signal?:AbortSignal):Promise<CategoryResult>{return normalizeSpiderCategory(await this.#request('categoryContent',[id,String(page),true,filters],signal),page);}
  async getDetail(ids:string[],signal?:AbortSignal):Promise<DetailResult>{return normalizeSpiderDetail(await this.#request('detailContent',[ids],signal));}
  async search(keyword:string,page=1,signal?:AbortSignal):Promise<SearchResult>{return normalizeSpiderSearch(await this.#request('searchContent',[keyword,false,String(page)],signal),page);}
  async getPlay(flag:string,id:string,signal?:AbortSignal):Promise<PlayResult>{
    const result=normalizeSpiderPlay(await this.#request('playerContent',[flag,id,[]],signal));
    if(!result.parse&&!/^https?:\/\//i.test(result.url))throw new Error('[SRC_PYTHON_PLAY_UNSUPPORTED] Python direct playback requires HTTP(S); proxy callbacks are unsupported');
    return result;
  }
  #stop():Promise<void>{
    if(this.#stopping)return this.#stopping;
    this.#stopping=(async()=>{
      const child=this.#child;this.#child=undefined;
      this.#rejectAll(new Error('[SRC_PYTHON_EXITED] Python host stopped'));
      if(child?.pid){
        if(process.platform==='win32'){
          // No shell interpolation. Job Object containment is not implemented in this preview.
          await new Promise<void>(resolve=>{const killer=spawn('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore',env:executableEnvironment()});const timer=setTimeout(()=>{killer.kill();resolve();},2_000);const done=()=>{clearTimeout(timer);resolve();};killer.once('error',done);killer.once('close',done);});
        }else{try{process.kill(-child.pid,'SIGKILL');}catch{/* already exited */}}
        child.kill('SIGKILL');
      }
      // Detached descendants can retain inherited pipes after the direct child exits.
      // Drop our pipe handles rather than waiting for their EOF indefinitely.
      child?.stdin.destroy();child?.stdout.destroy();child?.stderr.destroy();
      if(this.#closed){
        let timer:NodeJS.Timeout|undefined;
        const closed=await Promise.race([this.#closed.then(()=>true),new Promise<false>(resolve=>{timer=setTimeout(()=>resolve(false),2_000);})]);
        if(timer)clearTimeout(timer);
        if(!closed){child?.unref();this.#stopError=new Error('[SRC_PYTHON_STOP_TIMEOUT] Python host exit could not be confirmed; detached descendants are not contained');}
      }
      if(this.#directory)try{await rm(this.#directory,{recursive:true,force:true});}catch{this.#stopError??=new Error('[SRC_PYTHON_CLEANUP_FAILED] Python temporary directory could not be removed');}
      this.#directory='';this.#buffer=Buffer.alloc(0);
    })();return this.#stopping;
  }
  async destroy():Promise<void>{await this.#stop();if(this.#stopError)throw this.#stopError;}
}

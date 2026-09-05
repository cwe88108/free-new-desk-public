import { app,BrowserWindow } from 'electron';
import { Buffer } from 'node:buffer';
import { spawn,type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import type { PlayerCommand,PlayerLoadStatus,PlayerQuery,PlayerStats,PlayerTrack,PlayRequest } from '@free-new-desk/contracts';

type PlayerParams=Record<string,unknown>;
type CommandResult={ok:boolean;detail?:string};
type LoadAccepted=CommandResult&{accepted?:boolean;loadId?:string};
const browserUserAgent='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';
const compatibilityUserAgents=['okhttp/3.15','bingcha/1.1 (mianfeifenxiang) ','Goiptv/8.8.8'];
function headerKey(headers:Record<string,string>,name:string):string|undefined{return Object.keys(headers).find(key=>key.toLowerCase()===name.toLowerCase());}
function hasHeader(headers:Record<string,string>,name:string):boolean{return Boolean(headerKey(headers,name));}
function withUserAgent(headers:Record<string,string>,value:string):Record<string,string>{const next={...headers};const key=headerKey(next,'User-Agent');if(key&&key!=='User-Agent')delete next[key];next['User-Agent']=value;return next;}
function headerFields(headers:Record<string,string>):string{return Object.entries(headers).map(([key,value])=>`${key}: ${value}`).join(',');}
class PlayerRemoteError extends Error{constructor(message:string){super(message);this.name='PlayerRemoteError';}}

export class PlayerClient{
  #process:ChildProcessWithoutNullStreams|undefined;
  #pipeName='';
  #parentHwnd='';
  #loadQueueTail:Promise<void>=Promise.resolve();
  #startPromise:Promise<void>|undefined;

  setParentWindowHandle(handle:Buffer):void{
    try{
      if(handle.length<4)return;
      const value=handle.length>=8?handle.readBigUInt64LE(0):BigInt(handle.readUInt32LE(0));
      const next=value.toString();
      if(!next||next==='0'||next===this.#parentHwnd)return;
      const hadParent=Boolean(this.#parentHwnd);
      this.#parentHwnd=next;
      if(hadParent&&this.#process&&!this.#process.killed)this.stop();
    }catch{/* Invalid native window handle; parent PID remains as fallback. */}
  }

  async load(request:PlayRequest,onAccepted?:(loadId:string)=>void):Promise<CommandResult>{
    if(process.platform!=='win32')return{ok:false,detail:'Native PlayerHost is Windows-only'};
    const originalHeaders={...(request.headers??{})};
    const explicitUserAgent=Boolean(request.headerFields)||hasHeader(originalHeaders,'User-Agent');
    const isHttp=/^https?:\/\//i.test(request.url);
    const baseHeaders=isHttp&&!explicitUserAgent?withUserAgent(originalHeaders,browserUserAgent):originalHeaders;
    const attempts:Record<string,string>[]=[baseHeaders];
    if(isHttp&&!explicitUserAgent)for(const userAgent of compatibilityUserAgents)attempts.push(withUserAgent(originalHeaders,userAgent));
    return await this.#enqueueLoad(async()=>{
      let lastError:unknown;
      for(let index=0;index<attempts.length;index+=1){
        const fields=request.headerFields??headerFields(attempts[index]??{});
        const started=Date.now();
        try{const accepted=await this.#sendWithRecovery('player.load',{url:request.url,...(fields?{headerFields:fields}:{}),...(request.profile?{profile:request.profile}:{})}) as LoadAccepted;if(!accepted.ok||!accepted.accepted||!accepted.loadId)throw new PlayerRemoteError(accepted.detail??'PlayerHost did not accept media load');onAccepted?.(accepted.loadId);return await this.#waitForLoad(accepted.loadId);}
        catch(error){
          lastError=error;
          const quickRemoteFailure=error instanceof PlayerRemoteError&&(Date.now()-started)<=8_000;
          if(!quickRemoteFailure||index===attempts.length-1)throw error;
        }
      }
      throw lastError instanceof Error?lastError:new Error('PlayerHost failed to load media');
    });
  }

  async command(command:PlayerCommand):Promise<CommandResult>{
    if(process.platform!=='win32')return{ok:false,detail:'Native PlayerHost is Windows-only'};
    return await this.#sendWithRecovery('player.command',command as unknown as PlayerParams) as CommandResult;
  }

  async query(query:'stats'):Promise<PlayerStats>;
  async query(query:'tracks'):Promise<PlayerTrack[]>;
  async query(query:'load-status'):Promise<PlayerLoadStatus>;
  async query(query:PlayerQuery):Promise<PlayerStats|PlayerTrack[]|PlayerLoadStatus>;
  async query(query:PlayerQuery):Promise<PlayerStats|PlayerTrack[]|PlayerLoadStatus>{
    if(process.platform!=='win32')throw new Error('Native PlayerHost is Windows-only');
    return await this.#sendWithRecovery('player.query',{query}) as PlayerStats|PlayerTrack[]|PlayerLoadStatus;
  }

  async #waitForLoad(loadId:string):Promise<CommandResult>{const deadline=Date.now()+30_000;while(Date.now()<deadline){const state=await this.query('load-status');if(state.loadId===loadId){if(state.status==='loaded')return{ok:true};if(state.status==='failed'||state.status==='ended')throw new PlayerRemoteError(state.error||`PlayerHost media load ${state.status}`);}await new Promise(resolve=>setTimeout(resolve,75));}throw new PlayerRemoteError('Timed out waiting for mpv to open media');}

  stop():void{
    this.#process?.kill();
    this.#process=undefined;
    this.#pipeName='';
  }

  #enqueueLoad<T>(work:()=>Promise<T>):Promise<T>{
    const next=this.#loadQueueTail.then(()=>work(),()=>work());
    this.#loadQueueTail=next.then(()=>undefined,()=>undefined);
    return next;
  }

  async #sendWithRecovery(method:string,params:PlayerParams):Promise<unknown>{
    try{
      await this.#ensureStarted();
      return await this.#send(method,params);
    }catch(first){
      // A valid PlayerHost response is an application/media error, not a crashed transport.
      // Restarting here destroys successfully opened media when window-sync or another command
      // is rejected, which was the main cause of blank embedded playback in v1.3.5.
      if(first instanceof PlayerRemoteError)throw first;
      this.stop();
      try{
        await this.#ensureStarted();
        return await this.#send(method,params);
      }catch(second){
        if(second instanceof PlayerRemoteError)throw second;
        const primary=second instanceof Error?second:first;
        throw primary instanceof Error?new Error(`${method} failed after PlayerHost recovery: ${primary.message}`,{cause:primary}):primary;
      }
    }
  }

  async #ensureStarted():Promise<void>{
    if(this.#process&&!this.#process.killed&&this.#pipeName)return;
    if(this.#startPromise)return await this.#startPromise;
    const start=this.#start();
    this.#startPromise=start;
    try{await start;}finally{if(this.#startPromise===start)this.#startPromise=undefined;}
  }

  async #start():Promise<void>{
    if(!this.#parentHwnd){
      const parent=BrowserWindow.getAllWindows().find(window=>!window.isDestroyed()&&window.isVisible())??BrowserWindow.getAllWindows().find(window=>!window.isDestroyed());
      if(parent)this.setParentWindowHandle(parent.getNativeWindowHandle());
    }
    const executable=app.isPackaged?path.join(process.resourcesPath,'native','player-host','player-host.exe'):path.join(app.getAppPath(),'native','player-host','build','Release','player-host.exe');
    this.#pipeName=`\\\\.\\pipe\\free-new-desk-player-${randomUUID()}`;
    let startupError:Error|undefined;
    let stderrTail='';
    const args=['--pipe',this.#pipeName,'--parent-pid',String(process.pid),...(this.#parentHwnd?['--parent-hwnd',this.#parentHwnd]:[]),...(process.env.FND_UI_SMOKE==='1'?['--test-audio-output','null']:[])];
    const child=spawn(executable,args,{windowsHide:true});
    child.stdout.on('data',()=>{});
    child.stderr.on('data',chunk=>{stderrTail=(stderrTail+String(chunk)).slice(-4096);});
    child.once('error',error=>{startupError=error;});
    child.once('exit',(code,signal)=>{
      if(this.#process===child){this.#process=undefined;this.#pipeName='';}
      if(code!==0)startupError=new Error(`PlayerHost exited with code ${code}${signal?` (${signal})`:''}${stderrTail?`: ${stderrTail.trim()}`:''}`);
    });
    this.#process=child;
    await new Promise<void>((resolve,reject)=>{
      const deadline=Date.now()+10_000;
      const probe=()=>{
        if(startupError){reject(new Error(`Unable to start PlayerHost: ${startupError.message}`,{cause:startupError}));return;}
        if(!this.#pipeName){reject(new Error('PlayerHost exited before pipe became ready'));return;}
        const socket=net.createConnection(this.#pipeName);
        socket.once('connect',()=>{socket.end();resolve();});
        socket.once('error',()=>{socket.destroy();if(Date.now()>=deadline)reject(new Error(`PlayerHost did not open its named pipe: ${executable}`));else setTimeout(probe,25);});
      };
      probe();
    });
  }

  #send(method:string,params:PlayerParams):Promise<unknown>{
    return new Promise((resolve,reject)=>{
      if(!this.#pipeName){reject(new Error('PlayerHost pipe is unavailable'));return;}
      const socket=net.createConnection(this.#pipeName);
      let buffer='';
      const timeoutMs=10_000;
      const timer=setTimeout(()=>{socket.destroy();reject(new Error(`PlayerHost timeout after ${timeoutMs/1000}s: ${method}`));},timeoutMs);
      socket.setEncoding('utf8');
      socket.on('connect',()=>socket.write(`${JSON.stringify({id:randomUUID(),method,params})}\n`));
      socket.on('data',chunk=>{
        buffer+=chunk;
        const newline=buffer.indexOf('\n');
        if(newline<0)return;
        clearTimeout(timer);
        const line=buffer.slice(0,newline);
        socket.end();
        try{
          const response=JSON.parse(line) as{result?:unknown;error?:{message?:string}};
          if(response.error)reject(new PlayerRemoteError(response.error.message??'Player error'));
          else resolve(response.result);
        }catch(error){reject(error instanceof Error?error:new Error(String(error)));}
      });
      socket.on('error',error=>{clearTimeout(timer);reject(error);});
    });
  }
}

import { app,utilityProcess,type UtilityProcess } from 'electron';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EPG_MAX_DOWNLOAD_BYTES } from '@free-new-desk/epg-parser';
import type { EpgProgram } from '@free-new-desk/contracts';

export class EpgWorkerClient {
  #child:UtilityProcess|undefined;
  #pending=new Map<string,{resolve:(value:EpgProgram[])=>void;reject:(error:Error)=>void;timer:NodeJS.Timeout}>();
  #rejectPending(error:Error):void {
    for(const pending of this.#pending.values()){clearTimeout(pending.timer);pending.reject(error);}
    this.#pending.clear();
  }
  #start():void {
    if(this.#child)return;
    const child=utilityProcess.fork(path.join(app.getAppPath(),'apps','desktop','dist','main','epg-worker.js'),[],{serviceName:'Free New Desk EPG Parser'});
    child.on('message',message=>{
      if(this.#child!==child)return;
      const data=(message&&typeof message==='object'?message:{}) as{id?:string;result?:EpgProgram[];error?:string};
      const pending=this.#pending.get(data.id??'');if(!pending)return;
      clearTimeout(pending.timer);this.#pending.delete(data.id??'');
      if(data.error)pending.reject(new Error(data.error));else pending.resolve(data.result??[]);
    });
    child.on('exit',()=>{
      if(this.#child!==child)return;
      this.#child=undefined;this.#rejectPending(new Error('EPG worker exited'));
    });
    this.#child=child;
  }
  parse(bytes:Uint8Array):Promise<EpgProgram[]> {
    if(bytes.byteLength>EPG_MAX_DOWNLOAD_BYTES)return Promise.reject(new Error('EPG download exceeds byte safety limit'));
    if(this.#pending.size>=2)return Promise.reject(new Error('EPG parser capacity reached'));
    this.#start();const id=randomUUID();
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{
        const child=this.#child;this.#child=undefined;
        this.#rejectPending(new Error('EPG parse timeout'));child?.kill();
      },20_000);
      this.#pending.set(id,{resolve,reject,timer});
      try{this.#child?.postMessage({id,payload:Buffer.from(bytes).toString('base64')});}
      catch(error){clearTimeout(timer);this.#pending.delete(id);reject(error);}
    });
  }
  stop():void {
    const child=this.#child;this.#child=undefined;
    this.#rejectPending(new Error('EPG worker stopped'));child?.kill();
  }
}

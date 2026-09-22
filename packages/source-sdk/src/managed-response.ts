export interface ManagedResponseOptions{
  maxBytes?:number;
  signal:AbortSignal;
  finalize:()=>void;
  url?:string;
  redirected?:boolean;
}

export function managedResponse(response:Response,options:ManagedResponseOptions):Response{
  const declared=Number(response.headers.get('content-length'));
  if(options.maxBytes!==undefined&&Number.isFinite(declared)&&declared>options.maxBytes){
    void response.body?.cancel();options.finalize();throw new Error(`Response exceeds ${options.maxBytes} byte safety limit`);
  }
  if(!response.body){options.finalize();return response;}
  const reader=response.body.getReader();let total=0,ended=false,streamController:ReadableStreamDefaultController<Uint8Array>|undefined;
  const cleanup=()=>{options.signal.removeEventListener('abort',onAbort);options.finalize();};
  const complete=()=>{if(ended)return;ended=true;cleanup();};
  const fail=(reason:unknown)=>{
    if(ended)return;ended=true;cleanup();void reader.cancel(reason).catch(()=>undefined);
    try{streamController?.error(reason);}catch{/* stream already closed */}
  };
  const onAbort=()=>fail(options.signal.reason??new DOMException('Aborted','AbortError'));
  const stream=new ReadableStream<Uint8Array>({
    start(controller){
      streamController=controller;
      if(options.signal.aborted)queueMicrotask(onAbort);else options.signal.addEventListener('abort',onAbort,{once:true});
    },
    async pull(controller){
      if(ended)return;
      try{
        const part=await reader.read();
        if(part.done){controller.close();complete();return;}
        total+=part.value.byteLength;
        if(options.maxBytes!==undefined&&total>options.maxBytes){
          fail(new Error(`Response exceeds ${options.maxBytes} byte safety limit`));return;
        }
        controller.enqueue(part.value);
      }catch(error){fail(error);}
    },
    async cancel(reason){
      if(ended)return;try{await reader.cancel(reason);}finally{complete();}
    }
  });
  const limited=new Response(stream,{status:response.status,statusText:response.statusText,headers:response.headers});
  const url=options.url??response.url,redirected=options.redirected??response.redirected,type=response.type;
  return new Proxy(limited,{get(target,property){
    if(property==='url')return url;if(property==='redirected')return redirected;if(property==='type')return type;
    const value=Reflect.get(target,property,target);return typeof value==='function'?value.bind(target):value;
  }}) as Response;
}

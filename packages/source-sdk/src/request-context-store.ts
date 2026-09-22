import {CookieJar} from 'tough-cookie';

export interface RequestContextSpec{
  configRevision?:string;
  accountProfile?:string;
  defaultHeaders?:Record<string,string>;
}
interface StoredContext{
  ref:string;
  sourceId:string;
  configRevision:string;
  accountProfile:string;
  jar:CookieJar;
  defaultHeaders:Record<string,string>;
}

function contextRef(sourceId:string,spec:RequestContextSpec={}):string{
  return [sourceId,spec.configRevision??'legacy',spec.accountProfile??'default'].join('\u0000');
}
function setCookies(headers:Headers):string[]{
  return (headers as Headers&{getSetCookie?:()=>string[]}).getSetCookie?.()
    ??(headers.get('set-cookie')?[headers.get('set-cookie') as string]:[]);
}

export class RequestContextStore{
  readonly #contexts=new Map<string,StoredContext>();
  readonly #active=new Map<string,string>();
  bind(sourceId:string,spec:RequestContextSpec={}):string{
    const ref=contextRef(sourceId,spec),existing=this.#contexts.get(ref);
    if(existing){
      if(spec.defaultHeaders!==undefined)existing.defaultHeaders={...spec.defaultHeaders};
      this.#active.set(sourceId,ref);return ref;
    }
    this.#contexts.set(ref,{ref,sourceId,configRevision:spec.configRevision??'legacy',accountProfile:spec.accountProfile??'default',jar:new CookieJar(),defaultHeaders:{...(spec.defaultHeaders??{})}});
    this.#active.set(sourceId,ref);return ref;
  }
  #byRef(ref:string,sourceId?:string):StoredContext{
    const context=this.#contexts.get(ref);
    if(!context||(sourceId!==undefined&&context.sourceId!==sourceId))throw new Error('REQUEST_CONTEXT_UNAVAILABLE');
    return context;
  }
  resolveRef(sourceId:string,explicitRef?:string,spec?:RequestContextSpec):string{
    if(explicitRef){this.#byRef(explicitRef,sourceId);return explicitRef;}
    if(spec&&(spec.configRevision!==undefined||spec.accountProfile!==undefined||spec.defaultHeaders!==undefined))return this.bind(sourceId,spec);
    return this.activeRef(sourceId);
  }
  setDefaultHeaders(sourceId:string,headers?:Record<string,string>):void{
    this.#byRef(this.activeRef(sourceId),sourceId).defaultHeaders={...(headers??{})};
  }
  clearDefaultHeaders(sourceId:string):void{this.setDefaultHeaders(sourceId,{});}
  defaultHeadersFor(ref:string):Record<string,string>{return{...this.#byRef(ref).defaultHeaders};}
  async cookieHeaderFor(ref:string,url:string):Promise<string|undefined>{
    const value=await this.#byRef(ref).jar.getCookieString(url);return value||undefined;
  }
  async captureFor(ref:string,url:string,headers:Headers):Promise<void>{
    const context=this.#byRef(ref);
    for(const value of setCookies(headers))await context.jar.setCookie(value,url,{ignoreError:true});
  }
  async cookieHeader(sourceId:string,url:string):Promise<string|undefined>{return this.cookieHeaderFor(this.activeRef(sourceId),url);}
  async capture(sourceId:string,url:string,headers:Headers):Promise<void>{return this.captureFor(this.activeRef(sourceId),url,headers);}
  clearSource(sourceId:string):void{
    for(const[ref,context]of this.#contexts)if(context.sourceId===sourceId)this.#contexts.delete(ref);
    this.#active.delete(sourceId);
  }
  clearRef(ref:string):void{
    const context=this.#contexts.get(ref);if(!context)return;this.#contexts.delete(ref);
    if(this.#active.get(context.sourceId)===ref)this.#active.delete(context.sourceId);
  }
  activeRef(sourceId:string):string{
    const active=this.#active.get(sourceId);if(active&&this.#contexts.has(active))return active;
    return this.bind(sourceId);
  }
}

export function stripSensitiveRedirectHeaders(headers:Headers,fromUrl:string,toUrl:string):void{
  if(new URL(fromUrl).origin===new URL(toUrl).origin)return;
  for(const name of['authorization','cookie','proxy-authorization','origin','referer'])headers.delete(name);
}

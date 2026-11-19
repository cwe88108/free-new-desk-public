import type { RequestBroker } from '@free-new-desk/source-sdk';
import type { DiskCache } from './cache-service.js';

const IMAGE_MAX_BYTES=10*1024*1024;
const enc=(value:string)=>Buffer.from(value,'utf8').toString('base64url');
const dec=(value:string)=>Buffer.from(value,'base64url').toString('utf8');
const JPEG_TYPE=/^image\/(?:jpeg|pjpeg)(?:\s*;|$)/i;
const PNG_HEADER=Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]);

function validatedImageType(data:Buffer,contentType:string):string|undefined{
  if(!JPEG_TYPE.test(contentType))return contentType;
  if(data[0]===0xff&&data[1]===0xd8&&data[2]===0xff)return contentType;
  if(data.subarray(0,PNG_HEADER.length).equals(PNG_HEADER))return 'image/png';
  // Some upstream error pages carry an image/jpeg header with a text body.
  return undefined;
}

export class ImageService{
  constructor(readonly cache:DiskCache,readonly broker:RequestBroker){}
  url(remote:string,sourceId='image'):string{
    if(!/^https?:\/\//i.test(remote))return remote;
    return `fnd-image://cache/${enc(sourceId)}/${enc(remote)}`;
  }
  original(value:string):string{
    if(!value.startsWith('fnd-image://'))return value;
    try{
      const url=new URL(value);
      const parts=url.pathname.split('/').filter(Boolean);
      return parts.length>=2?dec(parts[1]??''):value;
    }catch{return value;}
  }
  async handle(value:string):Promise<Response>{
    try{
      const url=new URL(value);
      const parts=url.pathname.split('/').filter(Boolean);
      if(parts.length<2)return new Response('Bad image URL',{status:400});
      const sourceId=dec(parts[0]??'');
      const remote=dec(parts[1]??'');
      if(!/^https?:\/\//i.test(remote))return new Response('Bad image target',{status:400});
      const key=`${sourceId}|${remote}`;
      const cached=await this.cache.get('images',key,IMAGE_MAX_BYTES);
      if(cached){
        const cachedType=validatedImageType(cached.data,cached.contentType);
        if(cachedType)return new Response(new Uint8Array(cached.data),{headers:{'content-type':cachedType,'cache-control':'public,max-age=3600'}});
      }
      const response=await this.broker.request({sourceId:`image:${sourceId}`,url:remote,timeoutMs:10_000,retries:1,maxBytes:IMAGE_MAX_BYTES});
      if(!response.ok){
        await response.body?.cancel();
        return new Response('Image fetch failed',{status:response.status});
      }
      const type=response.headers.get('content-type')??'application/octet-stream';
      if(!type.startsWith('image/')){
        await response.body?.cancel();
        return new Response('Not an image',{status:415});
      }
      const declared=Number(response.headers.get('content-length')??0);
      if(declared>IMAGE_MAX_BYTES){
        await response.body?.cancel();
        return new Response('Image too large',{status:413});
      }
      const bytes=Buffer.from(await response.arrayBuffer());
      if(bytes.byteLength>IMAGE_MAX_BYTES)return new Response('Image too large',{status:413});
      const imageType=validatedImageType(bytes,type);
      if(!imageType)return new Response('Invalid JPEG image',{status:415});
      try{await this.cache.put('images',key,bytes,imageType,7*24*60*60*1000);}
      catch{/* Cache persistence is optional once validated image bytes are available. */}
      return new Response(new Uint8Array(bytes),{headers:{'content-type':imageType,'cache-control':'public,max-age=3600'}});
    }catch(error){
      return new Response('Image fetch failed',{status:error instanceof Error&&/byte safety limit/.test(error.message)?413:500});
    }
  }
}

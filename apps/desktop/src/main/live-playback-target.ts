import {RequestBroker,stripSensitiveRedirectHeaders} from '@free-new-desk/source-sdk';

// The pinned mpv resolves HLS variants against the dispatch URL, not the final
// CDN URL. Resolve the manifest base first; media still streams directly.
export async function resolveLivePlaybackTarget(url:string,headers:Record<string,string>,signal:AbortSignal,broker=new RequestBroker()):Promise<{url:string;headers:Record<string,string>}>{
  if(!/^https?:\/\//i.test(url)||!/\.m3u8(?:[?#]|$)/i.test(url))return{url,headers};
  const forwarded=new Headers(headers),deadline=AbortSignal.any([signal,AbortSignal.timeout(8000)]);
  for(let hops=0;hops<=8;hops++){
    const response=await broker.request({sourceId:'live-playback-target',url,headers:Object.fromEntries(forwarded),redirect:'manual',retries:0,signal:deadline,timeoutMs:8000});
    const location=response.headers.get('location');
    await response.body?.cancel();
    if(![301,302,303,307,308].includes(response.status)||!location)return{url,headers:Object.fromEntries(forwarded)};
    if(hops===8)throw new Error('Live manifest redirect limit exceeded');
    const next=new URL(location,url);
    if(!['http:','https:'].includes(next.protocol))throw new Error('Live manifest redirect protocol is not supported');
    stripSensitiveRedirectHeaders(forwarded,url,next.href);
    url=next.href;
  }
  throw new Error('Live manifest redirect limit exceeded');
}

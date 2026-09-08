const artworkCache=new Map<string,Promise<string|undefined>>();
const pending:Array<()=>void>=[];
let active=0;
const MAX_CONCURRENT=4;

function pump():void{while(active<MAX_CONCURRENT&&pending.length){const run=pending.shift();if(!run)break;active+=1;run();}}
function limited<T>(task:()=>Promise<T>):Promise<T>{return new Promise<T>((resolve,reject)=>{pending.push(()=>{void task().then(resolve,reject).finally(()=>{active-=1;pump();});});pump();});}

export function loadMusicArtwork(trackId:string,online=true):Promise<string|undefined>{
  if(!trackId)return Promise.resolve(undefined);
  const key=`${online?'online':'local'}:${trackId}`,existing=artworkCache.get(key);if(existing)return existing;
  const request=limited(()=>window.desktop.music.artwork(trackId,{online})).catch(()=>undefined);
  artworkCache.set(key,request);return request;
}

export function clearMusicArtworkMemoryCache():void{artworkCache.clear();}

import { createHash,randomUUID } from 'node:crypto';
import { mkdir,readFile,writeFile,rename,readdir,stat,unlink } from 'node:fs/promises';
import path from 'node:path';
import type { MusicTrack } from '@free-new-desk/contracts';
type Identity=Pick<MusicTrack,'title'|'artist'|'album'>&{duration?:number};
const MAX_BYTES=8*1024*1024,TTL=30*86400000;
const UA='Free-New-Desk/1.4.17 (+https://github.com/cwe88108/free-new-desk-public)';
const gates=new Map<string,Promise<unknown>>(),lastCall=new Map<string,number>();
const pending=new Map<string,Promise<unknown>>();
export function sanitizeMusicMetadata(value:string):string{
  return value.replace(/\[[^\]]*(?:无损音乐|资源下载|打包资源|https?:|www\.|xmwsyy)[^\]]*\]/gi,'').replace(/(?:https?:\/\/|www\.)\S+|\b[\w.-]+\.(?:com|net|cn|org)\b/gi,'').replace(/更多打包资源下载.*|资源下载.*|\b(?:320k|flac无损)\b/gi,'').trim();
}
export function normalizeMusicMatch(value:string):string{return value.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu,'');}
function fieldScore(a:string,b:string,weight:number):number{a=normalizeMusicMatch(a);b=normalizeMusicMatch(b);return !a||!b?0:a===b?weight:a.includes(b)||b.includes(a)?weight*.65:0;}
export function scoreMusicCandidate(track:Identity,candidate:{title?:string|undefined;artist?:string|undefined;album?:string|undefined;duration?:number|undefined}):number{
  const title=fieldScore(sanitizeMusicMetadata(track.title),candidate.title??'',.6),artist=fieldScore(sanitizeMusicMetadata(track.artist),candidate.artist??'',.3);
  if(!title||!artist)return 0;
  const versions=(v:string)=>[...v.toLowerCase().matchAll(/\blive\b|\bremix\b|\binstrumental\b|现场|伴奏|翻唱/g)].map(m=>m[0]).sort().join('|');
  if(versions(track.title)!==versions(candidate.title??''))return 0;
  if(sanitizeMusicMetadata(track.album)&&candidate.album&&!/download|promo|https?:|www\.|资源|无损/i.test(track.album)&&normalizeMusicMatch(sanitizeMusicMetadata(track.album))!==normalizeMusicMatch(candidate.album))return 0;
  if(track.duration&&candidate.duration&&Math.abs(track.duration-candidate.duration)>Math.max(3,track.duration*.02))return 0;
  return Math.round((title+artist+fieldScore(sanitizeMusicMetadata(track.album),candidate.album??'',.1))*1000)/1000;
}
function key(track:Identity):string{return createHash('sha256').update(JSON.stringify(['match-v4',track.title,track.artist,track.album,track.duration??null])).digest('hex');}
async function single<T>(id:string,task:()=>Promise<T>):Promise<T>{const old=pending.get(id);if(old)return old as Promise<T>;const work=task();pending.set(id,work);try{return await work;}finally{if(pending.get(id)===work)pending.delete(id);}}
async function request(url:string):Promise<{bytes:Buffer;type:string;status:number}>{
  const host=new URL(url).hostname,interval=host==='musicbrainz.org'?1100:300;
  const previous=gates.get(host)??Promise.resolve();
  const work=previous.catch(()=>undefined).then(async()=>{
    await new Promise(resolve=>setTimeout(resolve,Math.max(0,interval-(Date.now()-(lastCall.get(host)??0)))));lastCall.set(host,Date.now());
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
    try{const response=await fetch(url,{headers:{'User-Agent':UA,Accept:'application/json,image/*'},signal:controller.signal});
      if(response.status===429||response.status===503){const delay=Math.min(60000,Math.max(1000,Number(response.headers.get('retry-after')??5)*1000));lastCall.set(host,Date.now()+delay);throw new Error('METADATA_RATE_LIMITED');}
      if(response.status===404){await response.body?.cancel();return{bytes:Buffer.alloc(0),type:'',status:404};}
      if(!response.ok){await response.body?.cancel();throw new Error(`METADATA_HTTP_${response.status}`);}
      const reader=response.body?.getReader(),chunks:Uint8Array[]=[];let size=0;
      if(Number(response.headers.get('content-length')??0)>MAX_BYTES)throw new Error('METADATA_TOO_LARGE');
      if(reader)try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>MAX_BYTES){await reader.cancel();throw new Error('METADATA_TOO_LARGE');}chunks.push(part.value);}}finally{reader.releaseLock();}
      return{bytes:Buffer.concat(chunks),type:response.headers.get('content-type')??'',status:response.status};
    }finally{clearTimeout(timer);}
  });gates.set(host,work);try{return await work;}finally{if(gates.get(host)===work)gates.delete(host);}
}
async function json<T>(url:string):Promise<T|undefined>{const response=await request(url);return response.status===404?undefined:JSON.parse(response.bytes.toString('utf8')) as T;}
async function image(url:string):Promise<Uint8Array|undefined>{const u=new URL(url);if(u.protocol!=='https:')return;const response=await request(u.href);if(response.status===404||!/^image\/(?:jpeg|png|webp)/i.test(response.type)||!response.bytes.length)return;return response.bytes;}
async function cached<T>(root:string,id:string,task:()=>Promise<T|undefined>):Promise<T|undefined>{return single(root+id,async()=>{
  const file=path.join(root,`${id}.json`);
  try{const info=await stat(file);if(info.size<=MAX_BYTES*1.5){const row=JSON.parse(await readFile(file,'utf8')) as {expires:number;value?:T};if(row.expires>Date.now())return row.value;}}catch{/* no valid cached result */}
  let value:T|undefined;let ttl=TTL;
  try{value=await task();if(value===undefined)ttl=30*60_000;}catch{ttl=30_000;}
  await mkdir(root,{recursive:true});const temp=`${file}.${randomUUID()}.tmp`;
  await writeFile(temp,JSON.stringify({expires:Date.now()+ttl,...(value===undefined?{}:{value})}),'utf8');await rename(temp,file).catch(async()=>{await unlink(temp).catch(()=>undefined);});
  // Bounded disk cache; only owned cache files are evicted.
  void prune(root);return value;
});}
let pruning=false;
async function prune(root:string){if(pruning)return;pruning=true;try{const files=await readdir(root);const rows=await Promise.all(files.filter(f=>/^[a-f0-9]+\.json$/.test(f)).map(async name=>{const p=path.join(root,name);const s=await stat(p).catch(()=>undefined);return{p,size:s?.size??0,time:s?.mtimeMs??0};}));let size=rows.reduce((sum,row)=>sum+row.size,0);for(const row of rows.sort((a,b)=>a.time-b.time)){if(size<=256*1024*1024)break;await unlink(row.p).catch(()=>undefined);size-=row.size;}}finally{pruning=false;}}
export interface OnlineTextResult{text:string;provider:string;score:number;kind:'synced'|'plain'|'instrumental';}
export interface OnlineArtworkResult{bytes:Uint8Array;provider:string;score:number;}
export async function findOnlineLyrics(track:Identity,cacheRoot:string):Promise<OnlineTextResult|undefined>{return cached(path.join(cacheRoot,'lyrics-v4'),key(track),async()=>{
  const title=sanitizeMusicMetadata(track.title),artist=sanitizeMusicMetadata(track.artist);if(!title||!artist)return;
  type Row={trackName?:string;artistName?:string;albumName?:string;duration?:number;syncedLyrics?:string;plainLyrics?:string;instrumental?:boolean};
  let best:OnlineTextResult|undefined;
  for(const params of [new URLSearchParams({track_name:title,artist_name:artist}),new URLSearchParams({track_name:title})]){
    const rows=await json<Row[]>(`https://lrclib.net/api/search?${params}`);
    for(const row of Array.isArray(rows)?rows:[]){const score=scoreMusicCandidate(track,{title:row.trackName,artist:row.artistName,album:row.albumName,duration:row.duration});if(score<.8)continue;
      const synced=row.syncedLyrics?.trim(),plain=row.plainLyrics?.trim();const kind=synced&&/\[\d+:\d{2}/.test(synced)?'synced':plain?'plain':row.instrumental?'instrumental':undefined;if(!kind)continue;
      const candidate:OnlineTextResult={text:kind==='synced'?synced!:kind==='plain'?plain!:'',kind,provider:'LRCLIB',score};
      if(!best||(candidate.kind==='synced'&&best.kind!=='synced')||(candidate.kind===best.kind&&score>best.score))best=candidate;
    }if(best?.kind==='synced')break;
  }return best;
});}
async function musicBrainzCover(track:Identity):Promise<{url:string;score:number}|undefined>{
  const escape=(v:string)=>v.replace(/["\\]/g,' '),query=`recording:"${escape(track.title)}" AND artist:"${escape(track.artist)}"`;
  type Recording={title:string;length?:number;'artist-credit'?:Array<{name:string}>;releases?:Array<{id:string;title:string}>};
  const payload=await json<{recordings?:Recording[]}>(`https://musicbrainz.org/ws/2/recording/?${new URLSearchParams({query,fmt:'json',limit:'5'})}`);
  for(const row of payload?.recordings??[]){const score=scoreMusicCandidate(track,{title:row.title,artist:row['artist-credit']?.map(a=>a.name).join(' & '),duration:row.length?row.length/1000:undefined});if(score<.8)continue;
    for(const release of (row.releases??[]).slice(0,2)){if(!/^[a-f0-9-]{36}$/.test(release.id))continue;const cover=await json<{images?:Array<{front?:boolean;thumbnails?:{large?:string};image?:string}>}>(`https://coverartarchive.org/release/${release.id}`);const front=cover?.images?.find(i=>i.front),url=front?.thumbnails?.large??front?.image;if(url)return{url,score};}
  }
}
export async function findOnlineArtwork(track:Identity,cacheRoot:string):Promise<OnlineArtworkResult|undefined>{
  type Stored={base64:string;provider:string;score:number};
  const value=await cached<Stored>(path.join(cacheRoot,'artwork-v3'),key(track),async()=>{
    const clean={...track,title:sanitizeMusicMetadata(track.title),artist:sanitizeMusicMetadata(track.artist),album:sanitizeMusicMetadata(track.album)};if(!clean.title||!clean.artist)return;
    const terms=[`${clean.title} ${clean.artist}`,...(clean.album?[`${clean.artist} ${clean.album}`,`${clean.title} ${clean.artist} ${clean.album}`]:[])];
    for(const term of terms){const payload=await json<{results?:Array<{trackName?:string;artistName?:string;collectionName?:string;trackTimeMillis?:number;artworkUrl100?:string}>}>(`https://itunes.apple.com/search?${new URLSearchParams({term,entity:'song',limit:'10'})}`).catch(()=>undefined);
      const rows=(payload?.results??[]).map(row=>({row,score:scoreMusicCandidate(clean,{title:row.trackName,artist:row.artistName,album:row.collectionName,duration:row.trackTimeMillis?row.trackTimeMillis/1000:undefined})})).sort((a,b)=>b.score-a.score);
      for(const {row,score} of rows.slice(0,2)){if(score<.8||!row.artworkUrl100)continue;const bytes=await image(row.artworkUrl100.replace(/\d+x\d+bb/,'600x600bb')).catch(()=>undefined);if(bytes)return{base64:Buffer.from(bytes).toString('base64'),provider:'iTunes Search',score};}
    }
    const fallback=await musicBrainzCover(clean);if(fallback){const bytes=await image(fallback.url);if(bytes)return{base64:Buffer.from(bytes).toString('base64'),provider:'MusicBrainz / CAA',score:fallback.score};}
  });return value?{bytes:Buffer.from(value.base64,'base64'),provider:value.provider,score:value.score}:undefined;
}
export async function findArtistArtwork(name:string,cacheRoot:string):Promise<OnlineArtworkResult|undefined>{
  const identity={title:'artist-photo',artist:name,album:''};
  const value=await cached<{base64:string;provider:string;score:number}>(path.join(cacheRoot,'artist-v3'),key(identity),async()=>{
    const payload=await json<{artists?:Array<{id:string;name:string;score?:number}>}>(`https://musicbrainz.org/ws/2/artist/?${new URLSearchParams({query:`artist:"${name.replace(/["\\]/g,' ')}"`,fmt:'json',limit:'5'})}`);
    const candidates=(payload?.artists??[]).filter(a=>normalizeMusicMatch(a.name)===normalizeMusicMatch(name)&&Number(a.score)>=95);
    if(candidates.length!==1)return;const artist=candidates[0]!;if(!/^[a-f0-9-]{36}$/.test(artist.id))return;
    const entity=await json<{relations?:Array<{type:string;url?:{resource:string}}>}>(`https://musicbrainz.org/ws/2/artist/${artist.id}?inc=url-rels&fmt=json`);
    const link=entity?.relations?.find(r=>r.type==='wikidata')?.url?.resource,qid=link?.match(/wikidata\.org\/wiki\/(Q\d+)$/)?.[1];if(!qid)return;
    const data=await json<{entities?:Record<string,{claims?:{P18?:Array<{mainsnak?:{datavalue?:{value?:string}}}>}}>}>(`https://www.wikidata.org/wiki/Special:EntityData/${qid}.json`);
    const filename=data?.entities?.[qid]?.claims?.P18?.[0]?.mainsnak?.datavalue?.value;if(!filename)return;
    const bytes=await image(`https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(filename)}?width=600`);if(!bytes)return;
    return{base64:Buffer.from(bytes).toString('base64'),provider:`Wikimedia Commons: ${filename}`,score:1};
  });return value?{bytes:Buffer.from(value.base64,'base64'),provider:value.provider,score:value.score}:undefined;
}

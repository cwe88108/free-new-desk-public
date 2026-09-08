import { createHash } from 'node:crypto';
import { mkdir,readFile,stat,writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { MusicTrack } from '@free-new-desk/contracts';

const CACHE_TTL_MS=30*24*60*60_000;
const NEGATIVE_CACHE_TTL_MS=24*60*60_000;
const MAX_ARTWORK_BYTES=8*1024*1024;
const REQUEST_TIMEOUT_MS=10_000;
const MUSICBRAINZ_INTERVAL_MS=1_100;
const providerUserAgent='Free-New-Desk/1.4.12 (+https://github.com/cwe88108/free-new-desk-public)';
let nextMusicBrainzAt=0;
let musicBrainzGate=Promise.resolve();

const metadataNoise=[
  /\[[^\]]*(?:无损|资源|下载|xmwsyy|www\.|\.com|\.net|\.cn)[^\]]*\]/giu,
  /(?:https?:\/\/|www\.)\S+/giu,
  /(?:更多打包资源下载|打包资源|资源下载|无损音乐)/giu,
  /\b(?:320K|FLAC无损|APE无损)\b/giu,
];

export function sanitizeMusicMetadata(value:string):string{
  let cleaned=value.normalize('NFKC');
  for(const pattern of metadataNoise)cleaned=cleaned.replace(pattern,' ');
  return cleaned.replace(/[\s_-]{2,}/g,' ').replace(/^[\s_\-|·]+|[\s_\-|·]+$/g,'').trim();
}

export function normalizeMusicMatch(value:string):string{return sanitizeMusicMetadata(value).toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu,'');}
function fieldScore(expected:string,candidate:string,weight:number):number{const a=normalizeMusicMatch(expected),b=normalizeMusicMatch(candidate);if(!a||!b)return 0;if(a===b)return weight;if(a.includes(b)||b.includes(a))return weight*.65;return 0;}
export function scoreMusicCandidate(track:Pick<MusicTrack,'title'|'artist'|'album'>,candidate:{title?:string|undefined;artist?:string|undefined;album?:string|undefined}):number{
  const clean={title:sanitizeMusicMetadata(track.title),artist:sanitizeMusicMetadata(track.artist),album:sanitizeMusicMetadata(track.album)};
  const title=fieldScore(clean.title,candidate.title??'',.6),artist=fieldScore(clean.artist,candidate.artist??'',.3);
  if(!title||!artist)return 0;
  const versions=(v:string)=>[...v.toLowerCase().matchAll(/live|remix|instrumental|现场|伴奏|翻唱/g)].map(m=>m[0]).sort().join('|');
  if(versions(clean.title)!==versions(candidate.title??''))return 0;
  return Math.round((title+artist+fieldScore(clean.album,candidate.album??'',.1))*1000)/1000;
}

export function artworkSearchTerms(track:Pick<MusicTrack,'title'|'artist'|'album'>):string[]{
  const title=sanitizeMusicMetadata(track.title),artist=sanitizeMusicMetadata(track.artist),album=sanitizeMusicMetadata(track.album);
  const values=[`${artist} ${title}`,album?`${artist} ${album}`:'',album?`${artist} ${title} ${album}`:''].map(value=>value.trim()).filter(Boolean);
  return [...new Set(values)];
}

function cacheKey(track:Pick<MusicTrack,'title'|'artist'|'album'>):string{return createHash('sha256').update(`match-v3\0${normalizeMusicMatch(track.artist)}\0${normalizeMusicMatch(track.album)}\0${normalizeMusicMatch(track.title)}`).digest('hex');}
async function fresh(file:string,ttl=CACHE_TTL_MS):Promise<boolean>{const info=await stat(file).catch(()=>undefined);return Boolean(info?.isFile()&&Date.now()-info.mtimeMs<ttl);}
async function fetchTimed(url:string,init:RequestInit={}):Promise<Response>{const controller=new AbortController(),timer=setTimeout(()=>controller.abort(new Error('在线音乐元数据请求超时')),REQUEST_TIMEOUT_MS),headers=new Headers(init.headers);headers.set('User-Agent',providerUserAgent);try{return await fetch(url,{...init,headers,signal:controller.signal});}finally{clearTimeout(timer);}}
async function fetchMusicBrainz(url:string):Promise<Response>{
  let releaseGate!:()=>void;const previous=musicBrainzGate;musicBrainzGate=new Promise<void>(resolve=>{releaseGate=resolve;});await previous;
  const wait=Math.max(0,nextMusicBrainzAt-Date.now());if(wait)await new Promise(resolve=>setTimeout(resolve,wait));
  try{return await fetchTimed(url,{headers:{Accept:'application/json'}});}finally{nextMusicBrainzAt=Date.now()+MUSICBRAINZ_INTERVAL_MS;releaseGate();}
}

export interface OnlineTextResult{text:string;provider:string;score:number;}
export interface OnlineArtworkResult{bytes:Uint8Array;provider:string;score:number;}
export async function findOnlineLyrics(track:Pick<MusicTrack,'title'|'artist'|'album'>,cacheRoot:string):Promise<OnlineTextResult|undefined>{
  const clean={title:sanitizeMusicMetadata(track.title),artist:sanitizeMusicMetadata(track.artist),album:sanitizeMusicMetadata(track.album)};
  if(!clean.title||!clean.artist)return;
  const directory=path.join(cacheRoot,'lyrics'),key=cacheKey(track),textPath=path.join(directory,`${key}.lrc`),metaPath=path.join(directory,`${key}.json`);
  if(await fresh(textPath)){const [text,metaRaw]=await Promise.all([readFile(textPath,'utf8'),readFile(metaPath,'utf8').catch(()=>'{}')]);let meta:{provider?:string;score?:number}={};try{meta=JSON.parse(metaRaw) as typeof meta;}catch{/* optional */}if(text.trim())return{text,provider:meta.provider??'cache',score:Number(meta.score??1)};}
  const queries=[new URLSearchParams({track_name:clean.title,artist_name:clean.artist}),new URLSearchParams({track_name:clean.title})];
  let rows:Array<{trackName?:string;artistName?:string;albumName?:string;syncedLyrics?:string;plainLyrics?:string}>=[];
  for(const query of queries){const response=await fetchTimed(`https://lrclib.net/api/search?${query}`);if(!response.ok)continue;const found=await response.json() as typeof rows;if(Array.isArray(found)&&found.length){rows=found;break;}}
  let best:{text:string;score:number}|undefined;
  for(const row of rows){const text=(row.syncedLyrics??row.plainLyrics??'').trim();if(!text)continue;const value=scoreMusicCandidate(clean,{title:row.trackName,artist:row.artistName,album:row.albumName});if(!best||value>best.score)best={text,score:value};}
  if(!best||best.score<.8)return;
  await mkdir(directory,{recursive:true});await Promise.all([writeFile(textPath,best.text,'utf8'),writeFile(metaPath,JSON.stringify({provider:'LRCLIB',score:best.score}),'utf8')]);
  return{text:best.text,provider:'LRCLIB',score:best.score};
}

async function downloadArtwork(url:string):Promise<Uint8Array|undefined>{
  const response=await fetchTimed(url,{headers:{Accept:'image/*'}});if(!response.ok)return;
  const length=Number(response.headers.get('content-length')??0);if(length>MAX_ARTWORK_BYTES)return;
  const bytes=new Uint8Array(await response.arrayBuffer());return bytes.length&&bytes.length<=MAX_ARTWORK_BYTES?bytes:undefined;
}

async function findItunesArtwork(track:Pick<MusicTrack,'title'|'artist'|'album'>):Promise<OnlineArtworkResult|undefined>{
  let best:{url:string;score:number}|undefined;
  for(const term of artworkSearchTerms(track)){const query=new URLSearchParams({term,entity:'song',limit:'12'}),response=await fetchTimed(`https://itunes.apple.com/search?${query}`);if(!response.ok)continue;const payload=await response.json() as{results?:Array<{trackName?:string;artistName?:string;collectionName?:string;artworkUrl100?:string}>};for(const row of payload.results??[]){if(!row.artworkUrl100)continue;const value=scoreMusicCandidate(track,{title:row.trackName,artist:row.artistName,album:row.collectionName});if(!best||value>best.score)best={url:row.artworkUrl100.replace(/\d+x\d+bb/,'600x600bb'),score:value};}if(best&&best.score>=.9)break;}
  if(!best||best.score<.8)return;const bytes=await downloadArtwork(best.url);return bytes?{bytes,provider:'iTunes Search',score:best.score}:undefined;
}
function mbPhrase(value:string):string{return `"${sanitizeMusicMetadata(value).replace(/["\\]/g,' ')}"`;}
async function findMusicBrainzArtwork(track:Pick<MusicTrack,'title'|'artist'|'album'>):Promise<OnlineArtworkResult|undefined>{
  const title=sanitizeMusicMetadata(track.title),artist=sanitizeMusicMetadata(track.artist);if(!title||!artist)return;
  const query=new URLSearchParams({query:`recording:${mbPhrase(title)} AND artist:${mbPhrase(artist)}`,fmt:'json',limit:'8'});
  const response=await fetchMusicBrainz(`https://musicbrainz.org/ws/2/recording/?${query}`);if(!response.ok)return;
  const payload=await response.json() as{recordings?:Array<{title?:string;'artist-credit'?:Array<{name?:string;artist?:{name?:string}}> ;releases?:Array<{id?:string;title?:string}>}>};
  let best:{releaseId:string;score:number}|undefined;
  for(const recording of payload.recordings??[]){const candidateArtist=(recording['artist-credit']??[]).map(value=>value.name??value.artist?.name??'').filter(Boolean).join(' ');for(const release of recording.releases??[]){if(!release.id)continue;const score=scoreMusicCandidate(track,{title:recording.title,artist:candidateArtist,album:release.title});if(!best||score>best.score)best={releaseId:release.id,score};}}
  if(!best||best.score<.8)return;
  const bytes=await downloadArtwork(`https://coverartarchive.org/release/${encodeURIComponent(best.releaseId)}/front-500`);
  return bytes?{bytes,provider:'MusicBrainz + Cover Art Archive',score:best.score}:undefined;
}

async function persistArtwork(directory:string,key:string,result:OnlineArtworkResult):Promise<OnlineArtworkResult>{
  await mkdir(directory,{recursive:true});await Promise.all([writeFile(path.join(directory,`${key}.img`),result.bytes),writeFile(path.join(directory,`${key}.json`),JSON.stringify({provider:result.provider,score:result.score}),'utf8')]);return result;
}

export async function findOnlineArtwork(track:Pick<MusicTrack,'title'|'artist'|'album'>,cacheRoot:string):Promise<OnlineArtworkResult|undefined>{
  const title=sanitizeMusicMetadata(track.title),artist=sanitizeMusicMetadata(track.artist);if(!title||!artist)return;
  const directory=path.join(cacheRoot,'artwork'),key=cacheKey(track),imagePath=path.join(directory,`${key}.img`),metaPath=path.join(directory,`${key}.json`),missPath=path.join(directory,`${key}.miss`);
  if(await fresh(imagePath)){const [bytes,metaRaw]=await Promise.all([readFile(imagePath),readFile(metaPath,'utf8').catch(()=>'{}')]);let meta:{provider?:string;score?:number}={};try{meta=JSON.parse(metaRaw) as typeof meta;}catch{/* optional */}if(bytes.length&&bytes.length<=MAX_ARTWORK_BYTES)return{bytes,provider:meta.provider??'cache',score:Number(meta.score??1)};}
  if(await fresh(missPath,NEGATIVE_CACHE_TTL_MS))return;
  const clean={title,artist,album:sanitizeMusicMetadata(track.album)};
  const itunes=await findItunesArtwork(clean);if(itunes)return persistArtwork(directory,key,itunes);
  const musicBrainz=await findMusicBrainzArtwork(clean);if(musicBrainz)return persistArtwork(directory,key,musicBrainz);
  await mkdir(directory,{recursive:true});await writeFile(missPath,new Date().toISOString(),'utf8');return;
}

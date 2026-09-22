import { createHash } from 'node:crypto';
import { readdir, stat, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { MusicScanCheckpoint, MusicSource, MusicTrack } from '@free-new-desk/contracts';
import { readMusicTags } from './music-tags.js';
import { parseCueSheet } from './music-cue.js';

const audio = new Set(['.mp3','.ape','.flac','.wav','.m4a','.alac','.aac','.ogg','.opus','.aiff','.aif','.dsf','.dff','.tta','.tak']);
const coverNames = ['cover.jpg','cover.jpeg','cover.png','cover.webp','folder.jpg','folder.jpeg','folder.png','front.jpg','front.png'];
const MAX_DISCOVERED = 100_000;
const MAX_TRACKS = 50_000;
const IO_TIMEOUT_MS = 15_000;
const TAG_CONCURRENCY = 4;
export const METADATA_REVISION = 2;

function withTimeout<T>(label:string, work:Promise<T>, timeoutMs=IO_TIMEOUT_MS):Promise<T>{
  return new Promise<T>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error(`${label} 超时 (${timeoutMs}ms)`)),timeoutMs);work.then(value=>{clearTimeout(timer);resolve(value);},error=>{clearTimeout(timer);reject(error);});});
}
async function limited<T>(items:T[], limit:number, work:(item:T)=>Promise<void>):Promise<void>{
  let cursor=0;const runners=Array.from({length:Math.min(limit,items.length)},async()=>{while(cursor<items.length){const item=items[cursor++];if(item!==undefined)await work(item);}});await Promise.all(runners);
}
function relDir(root:string,dir:string):string{return path.relative(root,dir).replaceAll('\\','/');}
function resolveCheckpointDir(root:string,relative:string):string{const full=path.resolve(root,...relative.split('/').filter(Boolean));if(full!==root&&!full.startsWith(root+path.sep))throw new Error('扫描 checkpoint 越界');return full;}

export function albumIdentity(track:Pick<MusicTrack,'album'|'artist'|'relativePath'|'sourceId'> & Partial<MusicTrack>):string{
  const norm=(s:string)=>s.normalize('NFKC').trim().toLocaleLowerCase('en-US');
  const directory=path.posix.dirname(track.relativePath.replaceAll('\\','/')).replace(/\/(cd|disc|disk)\s*\d+$/i,'');
  const key=track.musicBrainzAlbumId?['mbid',track.musicBrainzAlbumId]:track.album?['tags',norm(track.album),norm(track.albumArtist||track.artist),track.releaseDate??'',track.albumVersion??'']:['unknown',track.sourceId,directory];
  return createHash('sha256').update(JSON.stringify(key)).digest('hex').slice(0,32);
}
function infer(relative:string){
  const parts=relative.replaceAll('\\','/').split('/'),stem=path.parse(parts.pop()??'').name;let album=parts.pop()??'';
  if(/^(cd|disc|disk)\s*\d+$/i.test(album))album=parts.pop()??'';
  const match=/^(.+?)\s+-\s+(.+?)\s*\[([^\]]+)\]$/.exec(stem);if(match)return{title:match[1]!,artist:match[2]!,album:match[3]!};
  const pair=/^(.+?)\s+-\s+(.+)$/.exec(stem);return{title:pair?.[2]??stem,artist:pair?.[1]??parts.pop()??'',album};
}

export async function scanMusicFilesystem(
  source:MusicSource,
  existing:MusicTrack[],
  send:(message:Record<string,unknown>)=>Promise<void>|void,
  checkpoint?:MusicScanCheckpoint
){
  const root=path.resolve(source.root),old=new Map(existing.map(t=>[t.id,t]));
  const pending=(checkpoint?.pendingDirectories?.length?checkpoint.pendingDirectories:['']).map(value=>resolveCheckpointDir(root,value));
  let discovered=checkpoint?.discovered??0,processed=checkpoint?.processed??0,failed=checkpoint?.failed??0,sequence=checkpoint?.sequence??0,truncated=false;
  let batch:MusicTrack[]=[];const referenced=new Set<string>();
  const key=(s:string)=>process.platform==='win32'?s.toLowerCase():s;
  const info=await withTimeout('读取音乐来源',stat(root));if(!info.isDirectory())throw new Error('来源不是可访问的目录');
  async function flush(){if(!batch.length)return;const sending=batch;batch=[];sequence++;await send({type:'batch',tracks:sending,processed,discovered,failed,sequence});}
  async function emitCheckpoint(){
    await flush();
    const value:MusicScanCheckpoint={pendingDirectories:pending.map(dir=>relDir(root,dir)),sequence,discovered,processed,failed};
    await send({type:'checkpoint',checkpoint:value,processed,discovered,failed,sequence});
  }
  async function buildTrack(full:string,relative:string,names:Map<string,string>,overrides:Partial<MusicTrack>={}){
    if(processed>=MAX_TRACKS){truncated=true;return;}
    const id=createHash('sha256').update(`${source.id}\0${relative.replaceAll('\\','/')}`).digest('hex').slice(0,32),previous=old.get(id);
    let data;try{data=await withTimeout(`读取文件属性 ${relative}`,stat(full));}catch{failed++;return;}if(!data.isFile())return;
    const unchanged=previous&&previous.size===data.size&&previous.modifiedAt===data.mtime.toISOString()&&previous.metadataRevision===METADATA_REVISION&&previous.metadataStatus!=='failed';
    let tags;try{tags=unchanged?previous:await withTimeout(`读取音乐标签 ${relative}`,readMusicTags(full));}catch{failed++;tags={failed:true,title:'',artist:'',album:''};}
    const guess=infer(relative),sidecar=(overrides.title?names.get(`${overrides.title}.lrc`.toLowerCase()):undefined)??names.get(`${path.parse(full).name}.lrc`.toLowerCase());
    const cover=coverNames.map(name=>names.get(name)).find(Boolean);
    const result={id,sourceId:source.id,path:full,relativePath:relative,title:tags.title||guess.title,artist:tags.artist||guess.artist,album:tags.album||guess.album,albumArtist:tags.albumArtist,trackNumber:tags.trackNumber,discNumber:tags.discNumber,releaseDate:tags.releaseDate,musicBrainzAlbumId:tags.musicBrainzAlbumId,duration:tags.duration,format:path.extname(full).slice(1).toUpperCase(),size:data.size,modifiedAt:data.mtime.toISOString(),favorite:previous?.favorite??false,available:true,cover,lyricsPath:sidecar,metadataRevision:METADATA_REVISION,metadataStatus:'failed' in tags&&tags.failed?'failed':tags.album?'embedded':'inferred',...overrides} as MusicTrack;
    if(result.metadataStatus==='failed')failed++;
    result.albumId=albumIdentity(result);batch.push(result);processed++;
    if(batch.length>=200)await flush();
  }

  while(pending.length&&!truncated){
    const dir=pending.shift()!;let entries;
    try{entries=await withTimeout(`枚举目录 ${relDir(root,dir)||'.'}`,readdir(dir,{withFileTypes:true}));}catch(error){throw new Error(`目录读取失败 ${dir}: ${error instanceof Error?error.message:String(error)}`);}
    entries.sort((a,b)=>a.name.localeCompare(b.name,'en',{sensitivity:'base'}));
    const names=new Map<string,string>(),files:string[]=[],cues:string[]=[],children:string[]=[];
    for(const entry of entries){
      if(++discovered>MAX_DISCOVERED){truncated=true;break;}
      if(entry.isSymbolicLink())continue;const full=path.join(dir,entry.name);
      if(entry.isDirectory()){if(!entry.name.startsWith('.'))children.push(full);continue;}
      if(!entry.isFile())continue;names.set(entry.name.toLowerCase(),full);const ext=path.extname(entry.name).toLowerCase();
      if(ext==='.cue')cues.push(full);else if(audio.has(ext))files.push(full);
    }
    pending.push(...children);
    await send({type:'progress',phase:'discovering',discovered,processed,failed,pendingDirectories:pending.length});
    for(const cue of cues){
      if(processed>=MAX_TRACKS){truncated=true;break;}
      try{
        const ci=await withTimeout('读取 CUE 属性',stat(cue));if(ci.size>2*1024*1024){failed++;continue;}
        const text=(await withTimeout('读取 CUE',readFile(cue))).toString('utf8');const specs=parseCueSheet(text,cue,root);
        await limited(specs,TAG_CONCURRENCY,async spec=>{if(processed>=MAX_TRACKS){truncated=true;return;}referenced.add(key(spec.audioFile));const specNames=path.dirname(spec.audioFile)===dir?names:new Map<string,string>();await buildTrack(spec.audioFile,`${path.relative(root,cue).replaceAll('\\','/')}#${String(spec.trackNumber).padStart(2,'0')}`,specNames,{title:spec.title,artist:spec.performer,albumArtist:spec.performer,album:spec.album,cueFile:spec.cueFile,cueTrack:spec.trackNumber,cueStart:spec.start,...(spec.end!==undefined?{cueEnd:spec.end}:{})});});
      }catch{failed++;}
    }
    const regular=files.filter(full=>!referenced.has(key(full)));
    await limited(regular,TAG_CONCURRENCY,async full=>{if(!truncated)await buildTrack(full,path.relative(root,full).replaceAll('\\','/'),names);});
    await send({type:'progress',phase:'extracting',discovered,processed,failed,pendingDirectories:pending.length});
    await emitCheckpoint();
  }
  await flush();await send({type:'done',processed,discovered,failed,truncated,sequence});
}
// Works in an Electron utility process and in Node's integration-test child process.
const port=(process as typeof process & {parentPort?:{on(name:string,fn:(event:{data:unknown})=>void):void;postMessage(message:unknown):void}}).parentPort;
const post=(message:unknown)=>port?port.postMessage(message):process.send?.(message);
let ack:(()=>void)|undefined,started=false,lastProgress=0,lastPhase='';
async function receive(input:unknown){
  const message=input as {type:string;source:MusicSource;existing:MusicTrack[];checkpoint?:MusicScanCheckpoint};
  if(message.type==='ack'){ack?.();ack=undefined;return;}
  if(message.type!=='start'||started)return;started=true;
  try{
    await scanMusicFilesystem(message.source,message.existing,async output=>{
      if(output.type==='progress'){
        if(output.phase===lastPhase&&Date.now()-lastProgress<300)return;
        lastPhase=String(output.phase);lastProgress=Date.now();post(output);return;
      }
      if(output.type==='batch')await new Promise<void>(resolve=>{ack=resolve;post(output);});
      else post(output);
    },message.checkpoint);
  }catch(error){post({type:'error',message:error instanceof Error?error.message:String(error)});}
}
if(port)port.on('message',event=>{void receive(event.data);});
else if(process.send)process.on('message',message=>{void receive(message);});

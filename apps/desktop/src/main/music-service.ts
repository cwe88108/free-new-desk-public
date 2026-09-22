import {decodeMusicLyrics} from './music-lyrics-file.js';
import { readMusicTags,type MusicTags } from './music-tags.js';
import { app,dialog,ipcMain,nativeImage,safeStorage,utilityProcess,type IpcMainInvokeEvent } from 'electron';
import { createHash,randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { readFile,readdir,realpath,stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath,pathToFileURL } from 'node:url';
import type { MusicLyricsInfo,MusicSource,MusicTrack,MusicScanJob,MusicLibraryQuery } from '@free-new-desk/contracts';
import { MusicNetworkSourceRequestSchema,MusicPlayRequestSchema } from '@free-new-desk/contracts';
import { DataService } from '@free-new-desk/data-service';
import { parseCueSheet } from './music-cue.js';
import { disconnectSmbConnections,ensureSmbConnection,musicRequestHeaders,scanWebDav,type MusicCredentials } from './music-network.js';
import { listSmbConnections,disconnectSmbShare,normalizeSmbPath,sameSmbServer,smbShareRoot } from './smb-session-manager.js';
import { findOnlineArtwork,findOnlineLyrics,findArtistArtwork } from './music-online.js';
import { parseLrc } from '@free-new-desk/contracts';
import { getCurrentPlayerClient,getPlayerRuntimeSession } from './player-client.js';

const audioExtensions=new Set(['.mp3','.ape','.flac','.wav','.m4a','.alac','.aac','.ogg','.opus','.aiff','.aif','.dsf','.dff','.tta','.tak']);
const coverNames=['cover.jpg','cover.jpeg','cover.png','cover.webp','folder.jpg','folder.jpeg','folder.png','front.jpg','front.png'];
const MAX_TRACKS=50_000;
const MAX_DISCOVERED_FILES=100_000;
const MAX_CUE_BYTES=2*1024*1024;
const MAX_ARTWORK_BYTES=8*1024*1024;
const MAX_LYRICS_BYTES=512*1024;
const scanControllers=new Map<string,AbortController>();
const transientCredentials=new Map<string,MusicCredentials>();
const artworkMemory=new Map<string,string|undefined>();
const artworkPending=new Map<string,Promise<string|undefined>>();
const artworkWaiters:Array<()=>void>=[];let artworkActive=0;
async function withArtworkSlot<T>(work:()=>Promise<T>):Promise<T>{if(artworkActive>=4)await new Promise<void>(resolve=>artworkWaiters.push(resolve));artworkActive++;try{return await work();}finally{artworkActive--;artworkWaiters.shift()?.();}}
let store:DataService|undefined;
let registered=false;

function db():DataService{if(store)return store;const directory=path.join(app.getPath('userData'),'data');mkdirSync(directory,{recursive:true});store=new DataService(path.join(directory,'app.db'));return store;}
function requireLocalSender(event:IpcMainInvokeEvent):void{const sender=event.senderFrame?.url??'';if(!sender.startsWith('file://'))throw new Error('Untrusted IPC sender');}
function stableTrackId(sourceId:string,relativePath:string):string{return createHash('sha256').update(`${sourceId}\0${relativePath.replaceAll('\\','/')}`).digest('hex').slice(0,32);}
function relativeKey(value:string):string{const normalized=value.replaceAll('\\','/');return process.platform==='win32'?normalized.toLocaleLowerCase('en-US'):normalized;}
function pathKey(value:string):string{const normalized=path.normalize(value);return process.platform==='win32'?normalized.toLocaleLowerCase('en-US'):normalized;}
async function canonicalRoot(value:string):Promise<string>{const resolved=path.resolve(value);try{return await realpath(resolved);}catch{return resolved;}}
function basicTagsFromRelative(relative:string):Pick<MusicTrack,'title'|'artist'|'album'>{const normalized=relative.replaceAll('\\','/'),parts=normalized.split('/').filter(Boolean),file=parts.at(-1)??relative,stem=file.slice(0,Math.max(0,file.length-path.extname(file).length)),tagged=/^(.+?)\s+-\s+(.+?)\s*\[([^\]]+)\]$/.exec(stem),match=/^(.+?)\s+-\s+(.+)$/.exec(stem);if(tagged)return{title:(tagged[1]??'').trim(),artist:(tagged[2]??'').trim(),album:(tagged[3]??'').trim()};const title=(match?.[2]??stem).trim(),artist=(match?.[1]??(parts.length>=3?parts.at(-3):'')??'').trim(),album=(parts.length>=2?parts.at(-2):'')?.trim()??'';return{title,artist,album};}
async function firstExisting(paths:string[]):Promise<string|undefined>{for(const candidate of paths)try{const info=await stat(candidate);if(info.isFile())return candidate;}catch{/* optional sidecar */}return undefined;}
function throwIfAborted(signal:AbortSignal):void{if(signal.aborted)throw signal.reason instanceof Error?signal.reason:new DOMException('音乐扫描已取消','AbortError');}
function credentialSettingKey(ref:string):string{return`music.credential.${ref}`;}
function encodeCredential(credentials:MusicCredentials):string{if(!safeStorage.isEncryptionAvailable())throw new Error('Windows 安全凭据加密当前不可用，无法持久保存音乐来源密码');return safeStorage.encryptString(JSON.stringify(credentials)).toString('base64');}
function decodeCredential(value:string):MusicCredentials|undefined{try{if(!safeStorage.isEncryptionAvailable())return;const parsed=JSON.parse(safeStorage.decryptString(Buffer.from(value,'base64'))) as Record<string,unknown>;return{...(typeof parsed.username==='string'?{username:parsed.username}:{}),...(typeof parsed.password==='string'?{password:parsed.password}:{})};}catch{return;}}
function credentialsFor(source:MusicSource):MusicCredentials|undefined{const transient=transientCredentials.get(source.id);if(transient)return transient;if(!source.credentialRef)return;const saved=db().getSetting(credentialSettingKey(source.credentialRef));return saved?decodeCredential(saved):undefined;}
function saveCredentials(sourceId:string,credentials:MusicCredentials,remember:boolean):string|undefined{if(!credentials.username&&!credentials.password)return;transientCredentials.set(sourceId,credentials);if(!remember)return;const ref=randomUUID();db().setSetting(credentialSettingKey(ref),encodeCredential(credentials));return ref;}
function clearCredentials(source:MusicSource):void{transientCredentials.delete(source.id);if(source.credentialRef)db().setSetting(credentialSettingKey(source.credentialRef),'');}
function musicCacheRoot():string{return path.join(app.getPath('userData'),'cache','music-online');}
function trackIdentity(track:MusicTrack):string{return`${track.id}\0${track.path}\0${track.modifiedAt??track.etag??''}\0${track.cueStart??''}\0${track.cueEnd??''}`;}
function currentIdentity(track:MusicTrack):boolean{const latest=db().getMusicTrack(track.id);return Boolean(latest&&trackIdentity(latest)===trackIdentity(track));}
function segmentUrl(url:string,track:MusicTrack):string{if(track.cueStart===undefined&&track.cueEnd===undefined)return url;const start=Math.max(0,track.cueStart??0),end=track.cueEnd!==undefined&&track.cueEnd>start?String(track.cueEnd):'';return`${url}#fnd-segment=${start},${end}`;}

async function scanWebDavSource(source:MusicSource,signal:AbortSignal,existing:Map<string,MusicTrack>):Promise<{tracks:MusicTrack[];truncated:boolean}>{const remote=await scanWebDav(source.root,credentialsFor(source),signal,MAX_TRACKS,relative=>audioExtensions.has(path.posix.extname(relative).toLowerCase())),tracks:MusicTrack[]=[];for(const file of remote){const relative=file.relativePath.replaceAll('\\','/'),previous=existing.get(relativeKey(relative)),tags=previous&&previous.size===file.size&&previous.modifiedAt===file.modifiedAt&&previous.etag===file.etag?{title:previous.title,artist:previous.artist,album:previous.album}:basicTagsFromRelative(relative),ext=path.posix.extname(relative).toLowerCase();tracks.push({id:stableTrackId(source.id,relative),sourceId:source.id,path:file.url,relativePath:relative,title:tags.title,artist:tags.artist,album:tags.album,format:ext.slice(1).toUpperCase(),favorite:previous?.favorite??false,available:true,...(file.size!==undefined?{size:file.size}:{}),...(file.modifiedAt?{modifiedAt:file.modifiedAt}:{}),...(file.etag?{etag:file.etag}:{})});}return{tracks,truncated:tracks.length>=MAX_TRACKS};}
const scanTasks=new Map<string,{job:MusicScanJob;controller:AbortController;worker?:ReturnType<typeof utilityProcess.fork>;lastActivity:number;timer?:ReturnType<typeof setInterval>}>();
let scansClosing=false;
function jobKey(id:string){return 'music.scan.job.'+id;}
function scanSourceRevision(source:MusicSource):string{return createHash('sha256').update(JSON.stringify({kind:source.kind,root:pathKey(source.root)})).digest('hex').slice(0,24);}
function credentialFailure(error:unknown):boolean{const message=error instanceof Error?error.message:String(error);return /(?:1219|1326|logon failure|user name or password|用户名或密码|凭据|credential|authentication|access denied|拒绝访问)/i.test(message);}
function scanErrorCategory(error:unknown):NonNullable<MusicScanJob['errorCategory']>{const message=error instanceof Error?error.message:String(error);if(credentialFailure(message))return 'auth';if(/timeout|超时|timed out/i.test(message))return 'timeout';if(/offline|unreachable|not found|network|ENET|EHOST|断网|离线/i.test(message))return 'offline';if(/tag|metadata|parse|解析/i.test(message))return 'parse';return 'io';}
function storedJob(id:string):MusicScanJob|undefined{try{const value=db().getSetting(jobKey(id));return value?JSON.parse(value) as MusicScanJob:undefined;}catch{return;}}
function sourceWithJob(source:MusicSource):MusicSource{const job=scanTasks.get(source.id)?.job??storedJob(source.id);return job?{...source,scanJob:job}:source;}
function saveJob(job:MusicScanJob){if(scansClosing)return;db().setSetting(jobKey(job.sourceId),JSON.stringify(job));}
function recoverMusicScans(){
  for(const source of db().listMusicSources()){
    const previous=storedJob(source.id);
    if(source.scanState!=='scanning'&&!(previous&&['queued','probing','discovering','extracting','committing','retry_wait'].includes(previous.state)))continue;
    const job:MusicScanJob={jobId:previous?.jobId??randomUUID(),sourceId:source.id,generation:previous?.generation??previous?.jobId??randomUUID(),state:'interrupted',processed:previous?.processed??0,discovered:previous?.discovered??0,failed:previous?.failed??0,updatedAt:new Date().toISOString(),message:'上次扫描中断；可从 checkpoint 继续，已入库音乐保留',sourceRevision:previous?.sourceRevision??scanSourceRevision(source),sequence:previous?.sequence??0,...(previous?.checkpoint?{checkpoint:previous.checkpoint}:{})};
    saveJob(job);db().saveMusicSource({...source,scanState:'idle',message:job.message!,updatedAt:job.updatedAt});
  }
}
function queueScan(sourceId:string):{count:number;truncated:boolean;jobId:string;queued:true}{
  if(scansClosing)throw new Error('应用正在退出');
  const database=db(),source=database.listMusicSources().find(item=>item.id===sourceId);if(!source)throw new Error('音乐来源不存在');
  const running=scanTasks.get(sourceId);
  if(running&&['completed','failed','interrupted','paused','canceled','awaiting_credentials'].includes(running.job.state))throw new Error('上次扫描进程仍在退出，请稍候重试');
  if(running)return{count:running.job.processed,truncated:false,jobId:running.job.jobId,queued:true};
  const revision=scanSourceRevision(source),previous=storedJob(sourceId);
  const resumable=previous&&['paused','interrupted','awaiting_credentials'].includes(previous.state)&&previous.sourceRevision===revision&&previous.checkpoint;
  const now=new Date().toISOString(),freshId=randomUUID();
  const job:MusicScanJob=resumable?{...previous,generation:previous.generation??previous.jobId,state:'queued',updatedAt:now,heartbeatAt:now,message:'从上次 checkpoint 继续扫描'}:{jobId:freshId,sourceId,generation:randomUUID(),state:'queued',processed:0,discovered:0,failed:0,startedAt:now,heartbeatAt:now,updatedAt:now,sourceRevision:revision,sequence:0};
  const controller=new AbortController();
  const task:{job:MusicScanJob;controller:AbortController;worker?:ReturnType<typeof utilityProcess.fork>;lastActivity:number;timer?:ReturnType<typeof setInterval>}={job,controller,lastActivity:Date.now()};
  scanTasks.set(sourceId,task);scanControllers.set(sourceId,controller);saveJob(job);database.saveMusicSource({...source,scanState:'scanning',message:job.message??'已加入后台扫描',updatedAt:job.updatedAt});
  const current=()=>!scansClosing&&scanTasks.get(sourceId)===task&&!['completed','failed','interrupted','canceled','paused','awaiting_credentials'].includes(job.state)&&!controller.signal.aborted&&database.listMusicSources().some(item=>item.id===sourceId);
  async function withTransientRetry<T>(label:string,work:()=>Promise<T>):Promise<T>{let last:unknown;for(let attempt=0;attempt<3;attempt++){if(!current())throw controller.signal.reason??new DOMException('扫描已取消','AbortError');try{const value=await work();delete job.errorCategory;return value;}catch(error){last=error;const category=scanErrorCategory(error);job.errorCategory=category;if(!['offline','timeout'].includes(category)||attempt===2)throw error;const delayMs=attempt===0?1_000:3_000;job.state='retry_wait';job.message=`${label}暂时不可用，${delayMs/1000} 秒后重试（${attempt+1}/2）`;job.updatedAt=new Date().toISOString();saveJob(job);const latest=database.listMusicSources().find(item=>item.id===sourceId);if(latest)database.saveMusicSource({...latest,scanState:'scanning',message:job.message!,updatedAt:job.updatedAt});await new Promise<void>(resolve=>setTimeout(resolve,delayMs));job.state='probing';}}throw last;}
  function finish(state:MusicScanJob['state'],message:string){
    if(scanTasks.get(sourceId)!==task)return;if(task.timer)clearInterval(task.timer);
    const latest=!scansClosing?database.listMusicSources().find(item=>item.id===sourceId):undefined;
    job.state=state;job.message=message;job.updatedAt=new Date().toISOString();
    if(latest){saveJob(job);const scanState=state==='completed'?'ready':state==='failed'?'error':state==='awaiting_credentials'?'awaiting_credentials':'idle';database.saveMusicSource({...latest,scanState,message,updatedAt:job.updatedAt,...(state==='completed'?{lastScannedAt:job.updatedAt}:{})});}
    scanControllers.delete(sourceId);
    if(task.worker){const worker=task.worker;worker.once('exit',()=>{if(scanTasks.get(sourceId)===task)scanTasks.delete(sourceId);});worker.kill();}else scanTasks.delete(sourceId);
  }
  controller.signal.addEventListener('abort',()=>finish(job.state==='paused'?'paused':'canceled',job.state==='paused'?'扫描已暂停；继续时将从 checkpoint 恢复':'扫描已取消；已入库音乐保留'),{once:true});
  setImmediate(()=>{void (async()=>{try{
    while([...scanTasks.values()].some(other=>other!==task&&other.job.state!=='queued')){if(!current())return;await new Promise(resolve=>setTimeout(resolve,250));}
    if(!current())return;job.state='probing';saveJob(job);
    if(source.kind==='smb')await withTransientRetry('NAS 连接',()=>ensureSmbConnection(source.root,credentialsFor(source)));if(!current())return;
    if(source.kind==='webdav'){
      const existing=new Map(database.listMusicTracks(sourceId,undefined,MAX_TRACKS).map(track=>[relativeKey(track.relativePath),track]));
      const result=await withTransientRetry('WebDAV 扫描',()=>scanWebDavSource(source,controller.signal,existing));
      for(let index=0;index<result.tracks.length;index+=200){if(!current())return;database.markMusicScanBatch(sourceId,job.generation,result.tracks.slice(index,index+200));job.processed=Math.min(result.tracks.length,index+200);job.sequence=(job.sequence??0)+1;saveJob(job);await new Promise<void>(resolve=>setImmediate(resolve));}
      if(!current())return;if(!result.truncated)database.finishMusicScan(sourceId,job.generation);finish('completed',`已扫描 ${job.processed} 首`);return;
    }
    const existing:MusicTrack[]=[];let after='';for(;;){if(!current())return;const page=database.listMusicTracksPage(sourceId,after);existing.push(...page);if(page.length<500)break;after=page.at(-1)!.id;await new Promise<void>(resolve=>setImmediate(resolve));}
    if(!current())return;
    const worker=utilityProcess.fork(fileURLToPath(new URL('./music-scan-worker.js',import.meta.url)),[],{serviceName:'Music Library Scanner',stdio:'ignore'});task.worker=worker;task.lastActivity=Date.now();
    worker.on('message',(message:{type:string;phase?:MusicScanJob['state'];tracks?:MusicTrack[];processed?:number;discovered?:number;failed?:number;truncated?:boolean;message?:string;sequence?:number;checkpoint?:MusicScanJob['checkpoint']})=>{
      if(!current())return;
      try{
        task.lastActivity=Date.now();job.updatedAt=new Date().toISOString();job.processed=message.processed??job.processed;job.discovered=message.discovered??job.discovered;job.failed=message.failed??job.failed;
        if(message.type==='batch'){
          const incoming=message.sequence??((job.sequence??0)+1);
          if(incoming>(job.sequence??0)){job.state='committing';database.markMusicScanBatch(sourceId,job.generation,message.tracks??[]);job.sequence=incoming;saveJob(job);}
          worker.postMessage({type:'ack'});
        }else if(message.type==='checkpoint'){
          if(message.checkpoint){job.checkpoint=message.checkpoint;job.sequence=Math.max(job.sequence??0,message.checkpoint.sequence);saveJob(job);}
        }else if(message.type==='progress'){job.state=message.phase??'extracting';saveJob(job);}
        else if(message.type==='done'){
          if(!message.truncated&&!job.failed)database.finishMusicScan(sourceId,job.generation);
          finish('completed',`已入库 ${job.processed} 首${job.failed?'；部分标签或文件读取失败，保留旧记录':''}${message.truncated?'；达到扫描上限':''}`);
        }else if(message.type==='error'){
          const category=scanErrorCategory(message.message);job.errorCategory=category;
          const state:MusicScanJob['state']=source.kind==='smb'&&credentialFailure(message.message)?'awaiting_credentials':['offline','timeout'].includes(category)?'interrupted':'failed';
          finish(state,state==='awaiting_credentials'?'NAS 凭据失效；请更新用户名/密码后继续扫描':state==='interrupted'?'NAS 暂时不可用；已保存 checkpoint，可在连接恢复后继续扫描':'扫描失败；保留已有音乐。'+(message.message??''));
        }
      }catch(error){finish('failed',error instanceof Error?error.message:String(error));}
    });
    worker.once('exit',()=>{if(current())finish('failed','扫描进程退出；已有音乐保留');if(scanTasks.get(sourceId)===task)scanTasks.delete(sourceId);});
    task.timer=setInterval(()=>{if(current()&&Date.now()-task.lastActivity>30_000){job.errorCategory='timeout';finish('interrupted','NAS 长时间无响应，扫描进程已隔离；已保存 checkpoint，可在连接恢复后继续。');}},1000);
    worker.postMessage({type:'start',source:{...source,credentialRef:undefined},existing,...(job.checkpoint?{checkpoint:job.checkpoint}:{})});
  }catch(error){
    if(!current())return;
    const category=scanErrorCategory(error);job.errorCategory=category;const state:MusicScanJob['state']=source.kind==='smb'&&credentialFailure(error)?'awaiting_credentials':['offline','timeout'].includes(category)?'interrupted':'failed';
    finish(state,state==='awaiting_credentials'?'NAS 凭据无效或已过期；请更新凭据后继续扫描':state==='interrupted'?'网络暂时不可用；已保存 checkpoint，可恢复后继续扫描':error instanceof Error?error.message:String(error));
  }})();});
  return{count:database.musicTrackCount(sourceId),truncated:false,jobId:job.jobId,queued:true};
}

function imageDataUrl(bytes:Buffer|Uint8Array):string|undefined{const image=nativeImage.createFromBuffer(Buffer.from(bytes));if(image.isEmpty())return;const size=image.getSize(),scale=Math.min(1,1024/Math.max(size.width,size.height,1)),normalized=scale<1?image.resize({width:Math.max(1,Math.round(size.width*scale)),height:Math.max(1,Math.round(size.height*scale))}):image;return normalized.toDataURL();}
async function resolveArtwork(track:MusicTrack):Promise<string|undefined>{const manual=db().getSetting('music.track.artwork.'+track.id);if(manual)return manual;if(!/^https?:/i.test(track.path)){const embedded=await readMusicTags(track.path,true);if(embedded.picture){const value=imageDataUrl(embedded.picture);if(value)return value;}}const stem=track.path.slice(0,-path.extname(track.path).length),directory=path.dirname(track.path);const candidates=/^https?:/i.test(track.path)?[]:[...['.jpg','.png','.webp'].map(ext=>stem+ext),...(!/[\\/]/.test(track.album)&&track.album?['.jpg','.png'].map(ext=>path.join(directory,track.album+ext)):[]),...(track.cover?[track.cover]:[]),...coverNames.map(name=>path.join(directory,name))];for(const cover of candidates)try{const info=await stat(cover);if(info.isFile()&&info.size<=MAX_ARTWORK_BYTES){const value=imageDataUrl(await readFile(cover));if(value)return value;}}catch{/* fall through to online provider */}const online=await findOnlineArtwork(track,musicCacheRoot()).catch(()=>undefined);if(!online||!currentIdentity(track))return;return imageDataUrl(online.bytes);}
async function readArtwork(track:MusicTrack):Promise<string|undefined>{
  const manual=db().getSetting('music.track.artwork.'+track.id)??'',cacheKey=trackIdentity(track)+'\0'+createHash('sha256').update(manual).digest('hex');
  if(artworkMemory.has(cacheKey))return artworkMemory.get(cacheKey);
  const existing=artworkPending.get(cacheKey);if(existing)return existing;
  const pending=withArtworkSlot(()=>resolveArtwork(track)).then(value=>{artworkMemory.set(cacheKey,value);while(artworkMemory.size>256)artworkMemory.delete(artworkMemory.keys().next().value!);return value;}).finally(()=>{if(artworkPending.get(cacheKey)===pending)artworkPending.delete(cacheKey);});
  artworkPending.set(cacheKey,pending);return pending;
}async function readLyricsInfo(track:MusicTrack):Promise<MusicLyricsInfo>{
  let local='';if(track.lyricsPath)try{const info=await stat(track.lyricsPath);if(info.isFile()&&info.size<=MAX_LYRICS_BYTES)local=decodeMusicLyrics(await readFile(track.lyricsPath));}catch{/* optional */}
  if(!currentIdentity(track))return{text:'',kind:'not-found'};
  if(parseLrc(local).length)return{text:local,kind:'synced',provider:'本地 LRC',timeBase:track.cueStart!==undefined&&path.parse(track.lyricsPath??'').name!==track.title?'file':'track'};
  const online=await findOnlineLyrics(track,musicCacheRoot()).catch(()=>undefined);
  if(!currentIdentity(track))return{text:'',kind:'not-found'};
  if(online?.kind==='synced')return{text:online.text,kind:'synced',provider:online.provider,score:online.score};
  if(online?.kind==='instrumental')return{text:'',kind:'instrumental',provider:online.provider,score:online.score};
  if(online?.kind==='plain')return{text:online.text,kind:'plain',provider:online.provider,score:online.score};
  if(local.trim())return{text:local,kind:'plain',provider:'本地歌词'};
  return{text:'',kind:'not-found'};
}
async function readLyrics(track:MusicTrack):Promise<string>{return(await readLyricsInfo(track)).text;}

async function addNetworkSource(input:unknown):Promise<{source:MusicSource;count:number;truncated:boolean}>{const request=MusicNetworkSourceRequestSchema.parse(input),database=db(),now=new Date().toISOString(),id=randomUUID(),root=request.kind==='webdav'?(()=>{const url=new URL(request.root);if(url.protocol!=='http:'&&url.protocol!=='https:')throw new Error('WebDAV 地址必须使用 http:// 或 https://');if(!url.pathname.endsWith('/'))url.pathname+='/';return url.toString();})():(()=>{const value=normalizeSmbPath(request.root);if(!value)throw new Error('SMB 地址必须是 \\\\server\\share、\\server\\share 或 smb://server/share 形式');return value;})(),credentials:MusicCredentials={...(request.username?{username:request.username}:{}),...(request.password?{password:request.password}:{})},credentialRef=saveCredentials(id,credentials,request.rememberCredential===true),source:MusicSource={id,name:request.name.trim(),kind:request.kind,root,enabled:true,createdAt:now,updatedAt:now,scanState:'idle',...(credentialRef?{credentialRef}:{})};const duplicate=database.listMusicSources().find(item=>item.kind===source.kind&&pathKey(item.root)===pathKey(root));if(duplicate){clearCredentials(source);if(credentials.username||credentials.password){clearCredentials(duplicate);const ref=saveCredentials(duplicate.id,credentials,request.rememberCredential===true);const updated={...duplicate,...(ref?{credentialRef:ref}:{})};if(!ref)delete updated.credentialRef;database.saveMusicSource(updated);}const result=queueScan(duplicate.id);return{source:sourceWithJob(database.listMusicSources().find(item=>item.id===duplicate.id)!),count:result.count,truncated:false};}database.saveMusicSource(source);try{const result=queueScan(id);return{source:database.listMusicSources().find(item=>item.id===id)??source,count:result.count,truncated:result.truncated};}catch(error){database.removeMusicSource(id);clearCredentials(source);throw error;}}

export function getMusicDiagnostics(){const database=db(),sources=database.listMusicSources().map(source=>{const job=scanTasks.get(source.id)?.job??storedJob(source.id);return{sourceId:source.id,kind:source.kind,scanState:source.scanState,trackCount:database.musicTrackCount(source.id),...(job?{job:{jobId:job.jobId,state:job.state,processed:job.processed,discovered:job.discovered,failed:job.failed,updatedAt:job.updatedAt,sourceRevision:job.sourceRevision,sequence:job.sequence??0,checkpointPending:job.checkpoint?.pendingDirectories.length??0}}:{})};});return{schemaVersion:16,generatedAt:new Date().toISOString(),sourceCount:sources.length,trackCount:database.musicTrackCount(),sources,sync:musicSyncDiagnostics};}
let musicSyncDiagnostics:Record<string,unknown>={};
export function registerMusicIpc():void{if(registered)return;registered=true;recoverMusicScans();
  ipcMain.handle('music:resolveSmbConflict',async(event,input)=>{
    requireLocalSender(event);const root=String((input as {root?:unknown})?.root??'');const share=smbShareRoot(root);if(!share)throw new Error('无效共享路径');
    const shares=await listSmbConnections(root);if(!shares.length)return{ok:false,message:'未枚举到可安全处理的连接，请在 Windows 中检查该服务器连接。'};
    const choice=await dialog.showMessageBox({type:'warning',title:'切换 NAS 凭据',message:'仅断开以下目标服务器连接？',detail:shares.join('\n')+'\n\n其他程序可能正在使用这些连接。列表可能不完整；占用时不会强制断开。',buttons:['取消','断开列出的连接'],defaultId:0,cancelId:0});
    if(choice.response!==1)return{ok:false,message:'已取消，现有连接未变更。'};
    const smbSources=db().listMusicSources().filter(s=>s.kind==='smb');const flags=await Promise.all(smbSources.map(async source=>({source,same:await sameSmbServer(share,source.root)})));const affected=flags.filter(item=>item.same).map(item=>item.source);
    for(const source of affected)scanControllers.get(source.id)?.abort(new DOMException('用户切换 NAS 凭据','AbortError'));
    if(affected.some(s=>s.id===getPlayerRuntimeSession().sourceId))await getCurrentPlayerClient()?.command({command:'stop'});
    for(const value of shares)await disconnectSmbShare(value);
    return{ok:true,message:'已断开列出的连接，请重新添加并扫描。'};
  });
  ipcMain.handle('music:listSources' ,event=>{requireLocalSender(event);return db().listMusicSources().map(sourceWithJob);});
  ipcMain.handle('music:addLocalSource',async event=>{requireLocalSender(event);const selected=await dialog.showOpenDialog({title:'添加本地音乐文件夹',properties:['openDirectory']});const selectedRoot=selected.filePaths[0];if(selected.canceled||!selectedRoot)return{canceled:true};const root=await canonicalRoot(selectedRoot),database=db(),duplicate=database.listMusicSources().find(item=>item.kind==='local'&&pathKey(item.root)===pathKey(root));if(duplicate){const scanned=queueScan(duplicate.id);return{canceled:false,duplicate:true,source:database.listMusicSources().find(item=>item.id===duplicate.id)??duplicate,...scanned};}const now=new Date().toISOString(),source:MusicSource={id:randomUUID(),name:path.basename(root)||root,kind:'local',root,enabled:true,createdAt:now,updatedAt:now,scanState:'idle'};database.saveMusicSource(source);const scanned=queueScan(source.id);return{canceled:false,source:database.listMusicSources().find(item=>item.id===source.id)??source,...scanned};});
  ipcMain.handle('music:addNetworkSource',async(event,input)=>{requireLocalSender(event);return addNetworkSource(input);});
  ipcMain.handle('music:scan',async(event,input)=>{requireLocalSender(event);const sourceId=String((input as{sourceId?:unknown}|undefined)?.sourceId??'');if(!sourceId)throw new Error('缺少音乐来源');return queueScan(sourceId);});
  ipcMain.handle('music:syncDiagnostics',(event,input)=>{requireLocalSender(event);const value=input as Record<string,unknown>;musicSyncDiagnostics={updatedAt:new Date().toISOString(),activeIndex:Number(value.activeIndex),offset:Number(value.offset),stale:Boolean(value.stale),sampleAgeMs:Number(value.sampleAgeMs),rejected:Number(value.rejected),timeBase:value.timeBase==='file'?'file':'track',reason:typeof value.reason==='string'?value.reason.slice(0,80):''};return true;});
  ipcMain.handle('music:pauseScan',(event,input)=>{requireLocalSender(event);const id=String((input as {sourceId?:string})?.sourceId??'');const task=scanTasks.get(id);if(!task)return false;task.job.state='paused';task.controller.abort();return true;});
  ipcMain.handle('music:listTracksPage',(event,input)=>{requireLocalSender(event);const value=input as {sourceId?:string;after?:string};return db().listMusicTracksPage(value?.sourceId,value?.after??'');});
  ipcMain.handle('music:cancelScan',(event,input)=>{requireLocalSender(event);const sourceId=String((input as{sourceId?:unknown}|undefined)?.sourceId??'');if(!sourceId)throw new Error('缺少音乐来源');const controller=scanControllers.get(sourceId);if(!controller){const source=db().listMusicSources().find(s=>s.id===sourceId);if(source?.scanState==='scanning'){db().saveMusicSource({...source,scanState:'idle',message:'上次扫描已中断'});return true;}return false;}controller.abort(new DOMException('用户取消音乐扫描','AbortError'));return true;});
  ipcMain.handle('music:removeSource',(event,input)=>{requireLocalSender(event);const sourceId=String((input as{sourceId?:unknown}|undefined)?.sourceId??'');if(!sourceId)throw new Error('缺少音乐来源');const source=db().listMusicSources().find(item=>item.id===sourceId);scanControllers.get(sourceId)?.abort(new DOMException('音乐来源已删除','AbortError'));if(source)clearCredentials(source);return db().removeMusicSource(sourceId);});
  ipcMain.handle('music:catalog',(event,input)=>{requireLocalSender(event);const value=(input??{}) as MusicLibraryQuery;return db().musicCatalog({...(typeof value.sourceId==='string'?{sourceId:value.sourceId}:{}),...(typeof value.query==='string'?{query:value.query}:{}),...(typeof value.albumId==='string'?{albumId:value.albumId}:{}),...(typeof value.artist==='string'?{artist:value.artist}:{}),...(value.favorite===true?{favorite:true}:{}),...(typeof value.after==='string'?{after:value.after}:{}),limit:500});});
  ipcMain.handle('music:getTrack',(event,input)=>{requireLocalSender(event);return db().getMusicTrack(String((input as {trackId?:string})?.trackId??''));});
  ipcMain.handle('music:listTracks',(event,input)=>{requireLocalSender(event);const value=(input&&typeof input==='object'?input:{}) as Record<string,unknown>,sourceId=typeof value.sourceId==='string'&&value.sourceId?value.sourceId:undefined,query=typeof value.query==='string'?value.query:undefined,limit=Number.isFinite(Number(value.limit))?Math.min(MAX_TRACKS,Math.max(1,Number(value.limit))):5000;return db().listMusicTracks(sourceId,query,limit);});
  ipcMain.handle('music:toggleFavorite',(event,input)=>{requireLocalSender(event);const trackId=String((input as{trackId?:unknown}|undefined)?.trackId??'');if(!trackId)throw new Error('缺少曲目');return db().toggleMusicFavorite(trackId);});
  ipcMain.handle('music:artistArtwork',async(event,input)=>{requireLocalSender(event);const name=String((input as {name?:unknown})?.name??'').trim();if(!name||name.length>512||!db().listMusicTracks(undefined,undefined,MAX_TRACKS).some(t=>t.artist===name))return;const manual=db().getSetting('music.artist.artwork.'+createHash('sha256').update(name).digest('hex'));if(manual)return{url:manual,provider:'用户指定'};const value=await findArtistArtwork(name,musicCacheRoot());return value?{url:imageDataUrl(value.bytes),provider:value.provider}:undefined;});
  ipcMain.handle('music:chooseArtwork',async(event,input)=>{requireLocalSender(event);const value=input as {trackId?:string;artist?:string};const track=value.trackId?db().getMusicTrack(value.trackId):undefined;const artist=value.artist?.trim();if(!track&&(!artist||artist.length>512||!db().listMusicTracks(undefined,undefined,MAX_TRACKS).some(t=>t.artist===artist)))throw new Error('无效图片目标');const selected=await dialog.showOpenDialog({title:'选择音乐图片',properties:['openFile'],filters:[{name:'图片',extensions:['jpg','jpeg','png','webp']}]});const file=selected.filePaths[0];if(selected.canceled||!file)return;const info=await stat(file);if(info.size>MAX_ARTWORK_BYTES)throw new Error('图片不能超过 8 MiB');const url=imageDataUrl(await readFile(file));if(!url)throw new Error('图片不可用');db().setSetting(track?'music.track.artwork.'+track.id:'music.artist.artwork.'+createHash('sha256').update(artist!).digest('hex'),url);return url;});
  ipcMain.handle('music:artwork',async(event,input)=>{requireLocalSender(event);const track=db().getMusicTrack(String((input as{trackId?:unknown}|undefined)?.trackId??''));return track?readArtwork(track):undefined;});
  ipcMain.handle('music:lyrics',async(event,input)=>{requireLocalSender(event);const track=db().getMusicTrack(String((input as{trackId?:unknown}|undefined)?.trackId??''));return track?readLyrics(track):'';});
  ipcMain.handle('music:lyricsInfo',async(event,input)=>{requireLocalSender(event);const track=db().getMusicTrack(String((input as{trackId?:unknown}|undefined)?.trackId??''));return track?readLyricsInfo(track):{text:'',kind:'not-found'};});
  ipcMain.handle('music:capabilities',event=>{requireLocalSender(event);return{local:{scan:true,incrementalReuse:true,cancel:true,offlineRetention:true,pathDeduplication:true,lyrics:'sidecar-lrc+online',artwork:'embedded+folder+online'},webdav:{implemented:true,scan:'PROPFIND',playback:'native-http-range',credentials:'safeStorage'},smb:{implemented:true,scan:'UNC',playback:'UNC',credentials:'Windows-session+safeStorage'},onlineLyrics:{implemented:true,provider:'LRCLIB',scoredMatch:true,cache:true},onlineArtwork:{implemented:true,provider:'iTunes Search',scoredMatch:true,cache:true},cue:{implemented:true,singleFile:true,multiFile:true,boundedSegments:true},dsdNative:{implemented:false,pcmFallback:true,reason:'原生 DSD/DoP 必须由真实 DAC/驱动能力验证，源码不伪报'}};});
  ipcMain.handle('music:play',async(event,input)=>{requireLocalSender(event);const request=MusicPlayRequestSchema.parse(input),track=db().getMusicTrack(request.trackId);if(!track||!track.available)throw new Error('曲目不存在或当前不可用');const source=db().listMusicSources().find(item=>item.id===track.sourceId);if(!source)throw new Error('音乐来源不存在');let url:string,headers:Record<string,string>|undefined;if(source.kind==='webdav'){url=track.path;headers=musicRequestHeaders(credentialsFor(source));}else{if(source.kind==='smb')await ensureSmbConnection(source.root,credentialsFor(source));const exists=await stat(track.path).catch(()=>undefined);if(!exists?.isFile())throw new Error('音乐文件当前不可访问；来源可能离线，请重新扫描后重试');url=pathToFileURL(track.path).href;}const player=getCurrentPlayerClient();if(!player)throw new Error('PlayerHost 尚未初始化');await player.command({command:'window-sync',x:0,y:0,width:1,height:1,scale:1,visible:false}).catch(()=>undefined);const result=await player.load({url:segmentUrl(url,track),profile:'music',...(headers&&Object.keys(headers).length?{headers}:{})},undefined,{initiator:request.initiator??'user',sourceId:track.sourceId,trackId:track.id});return{...result,track,session:getPlayerRuntimeSession()};});
  app.once('before-quit',()=>{scansClosing=true;for(const task of scanTasks.values()){if(task.timer)clearInterval(task.timer);task.worker?.kill();}for(const controller of scanControllers.values())controller.abort(new DOMException('应用退出','AbortError'));scanControllers.clear();transientCredentials.clear();void disconnectSmbConnections();try{store?.close();}catch{/* main process owns shutdown ordering */}store=undefined;});
}

registerMusicIpc();

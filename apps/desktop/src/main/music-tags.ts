import { Worker,isMainThread,parentPort,workerData } from 'node:worker_threads';
import { parseFile } from 'music-metadata';
export interface MusicTags{title?:string;artist?:string;album?:string;albumArtist?:string;trackNumber?:number;discNumber?:number;releaseDate?:string;musicBrainzAlbumId?:string;failed?:boolean;duration?:number;picture?:Uint8Array;}
type Job={file:string;picture:boolean;resolve:(value:MusicTags)=>void;timer?:ReturnType<typeof setTimeout>};
type Slot={worker:Worker;job?:Job;terminating:boolean};
const pending:Job[]=[],slots=new Set<Slot>();
// A bounded reusable pool avoids starting a JS runtime for every NAS file.
// A timed-out worker retains its slot until exit is confirmed.
export function readMusicTags(file:string,picture=false):Promise<MusicTags>{return new Promise(resolve=>{if(pending.length>=32){resolve({failed:true});return;}pending.push({file,picture,resolve});pump();});}
function finish(slot:Slot,value:MusicTags){const job=slot.job;if(!job)return;delete slot.job;if(job.timer)clearTimeout(job.timer);job.resolve(value);slot.worker.unref();}
function createSlot():Slot{
  const worker=new Worker(new URL(import.meta.url),{workerData:{pool:true},resourceLimits:{maxOldGenerationSizeMb:96}}),slot:Slot={worker,terminating:false};slots.add(slot);worker.unref();
  worker.on('message',(value:MusicTags)=>{if(slot.terminating)return;finish(slot,value);pump();});
  worker.on('error',()=>{slot.terminating=true;finish(slot,{failed:true});void worker.terminate();});
  worker.once('exit',()=>{finish(slot,{failed:true});slots.delete(slot);pump();});return slot;
}
function pump(){while(pending.length){const slot=[...slots].find(s=>!s.job&&!s.terminating)??(slots.size<2?createSlot():undefined);if(!slot)return;const job=pending.shift()!;slot.job=job;slot.worker.ref();job.timer=setTimeout(()=>{slot.terminating=true;finish(slot,{failed:true});void slot.worker.terminate();},8000);slot.worker.postMessage({file:job.file,picture:job.picture});}}
async function parse(input:{file:string;picture:boolean}):Promise<MusicTags>{try{const meta=await parseFile(input.file,{skipCovers:!input.picture,duration:false});const result={title:meta.common.title,artist:meta.common.artist,album:meta.common.album,albumArtist:meta.common.albumartist,trackNumber:meta.common.track.no??undefined,discNumber:meta.common.disk.no??undefined,releaseDate:meta.common.date??(meta.common.year?String(meta.common.year):undefined),musicBrainzAlbumId:meta.common.musicbrainz_albumid,duration:meta.format.duration} as MusicTags;const cover=meta.common.picture?.[0]?.data;if(cover&&cover.length<=8*1024*1024)result.picture=cover;return result;}catch{return{failed:true};}}
if(!isMainThread&&workerData?.pool)parentPort?.on('message',(input:{file:string;picture:boolean})=>{void parse(input).then(result=>parentPort?.postMessage(result));});

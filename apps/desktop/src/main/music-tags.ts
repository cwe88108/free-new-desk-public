import { Worker,isMainThread,parentPort,workerData } from 'node:worker_threads';
import { parseFile } from 'music-metadata';

export interface MusicTags{title?:string;artist?:string;album?:string;duration?:number;picture?:Uint8Array;}
// Isolate malformed/oversized tags from playback control; one file is parsed at a time by the scanner.
export function readMusicTags(file:string,picture=false):Promise<MusicTags>{
  return new Promise(resolve=>{
    const worker=new Worker(new URL(import.meta.url),{workerData:{file,picture},resourceLimits:{maxOldGenerationSizeMb:96}});
    const timer=setTimeout(()=>finish({}),8000);let settled=false;
    function finish(value:MusicTags){if(settled)return;settled=true;clearTimeout(timer);void worker.terminate();resolve(value);}
    worker.once('message',finish);worker.once('error',()=>finish({}));worker.once('exit',()=>finish({}));
  });
}
if(!isMainThread){
  const input=workerData as{file:string;picture:boolean};
  void parseFile(input.file,{skipCovers:!input.picture,duration:false}).then(meta=>{
    const result:MusicTags={};
    if(meta.common.title)result.title=meta.common.title;
    if(meta.common.artist)result.artist=meta.common.artist;
    if(meta.common.album)result.album=meta.common.album;
    if(meta.format.duration!==undefined)result.duration=meta.format.duration;
    const cover=meta.common.picture?.[0]?.data;if(cover&&cover.length<=8*1024*1024)result.picture=cover;
    parentPort?.postMessage(result);
  }).catch(()=>parentPort?.postMessage({}));
}

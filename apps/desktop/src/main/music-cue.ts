import path from 'node:path';

export interface CueTrackSpec{
  cueFile:string;
  audioFile:string;
  trackNumber:number;
  title:string;
  performer:string;
  album:string;
  start:number;
  end?:number;
}

type MutableTrack={audioFile?:string;trackNumber:number;title?:string;performer?:string;album:string;start?:number};

function unquote(value:string):string{const trimmed=value.trim();return trimmed.startsWith('"')&&trimmed.endsWith('"')?trimmed.slice(1,-1).replace(/\\"/g,'"'):trimmed;}
function cueTime(value:string):number|undefined{const match=/^(\d{1,4}):(\d{2}):(\d{2})$/.exec(value.trim());if(!match)return;const minutes=Number(match[1]),seconds=Number(match[2]),frames=Number(match[3]);if(!Number.isFinite(minutes)||seconds>59||frames>74)return;return minutes*60+seconds+frames/75;}
function pathKey(value:string):string{const normalized=path.resolve(value);return process.platform==='win32'?normalized.toLocaleLowerCase('en-US'):normalized;}
function withinRoot(root:string,candidate:string):boolean{const base=pathKey(root),value=pathKey(candidate);return value===base||value.startsWith(base.endsWith(path.sep)?base:base+path.sep);}
function fileValue(line:string):string|undefined{const quoted=/^FILE\s+"((?:[^"\\]|\\.)+)"\s+\S+\s*$/i.exec(line);if(quoted?.[1])return quoted[1].replace(/\\"/g,'"');const plain=/^FILE\s+(.+?)\s+\S+\s*$/i.exec(line);return plain?.[1]?.trim();}

export function parseCueSheet(text:string,cueFile:string,libraryRoot:string):CueTrackSpec[]{
  const cueDirectory=path.dirname(cueFile),root=path.resolve(libraryRoot);let currentFile:string|undefined;let album='';let albumPerformer='';let active:MutableTrack|undefined;const parsed:MutableTrack[]=[];
  const flush=()=>{if(active){parsed.push(active);active=undefined;}};
  for(const rawLine of text.replace(/^\uFEFF/,'').split(/\r?\n/)){
    const line=rawLine.trim();if(!line||/^REM(?:\s|$)/i.test(line))continue;
    const file=fileValue(line);if(file!==undefined){flush();const resolved=path.resolve(cueDirectory,file);currentFile=withinRoot(root,resolved)?resolved:undefined;continue;}
    const track=/^TRACK\s+(\d{1,3})\s+AUDIO\s*$/i.exec(line);if(track){flush();active={...(currentFile?{audioFile:currentFile}:{}),trackNumber:Number(track[1]),album};continue;}
    const title=/^TITLE\s+(.+)$/i.exec(line);if(title?.[1]){const value=unquote(title[1]);if(active)active.title=value;else album=value;continue;}
    const performer=/^PERFORMER\s+(.+)$/i.exec(line);if(performer?.[1]){const value=unquote(performer[1]);if(active)active.performer=value;else albumPerformer=value;continue;}
    const index=/^INDEX\s+01\s+(\d{1,4}:\d{2}:\d{2})\s*$/i.exec(line);if(index?.[1]&&active){const start=cueTime(index[1]);if(start!==undefined)active.start=start;}
  }
  flush();
  const valid=parsed.filter((item):item is MutableTrack&{audioFile:string;start:number}=>Boolean(item.audioFile&&item.start!==undefined&&Number.isFinite(item.start)));
  const output:CueTrackSpec[]=valid.map(item=>({cueFile,audioFile:item.audioFile,trackNumber:item.trackNumber,title:item.title?.trim()||`Track ${String(item.trackNumber).padStart(2,'0')}`,performer:item.performer?.trim()||albumPerformer,album:item.album||album,start:item.start}));
  for(let index=0;index<output.length-1;index+=1){const current=output[index],next=output[index+1];if(current&&next&&pathKey(current.audioFile)===pathKey(next.audioFile)&&next.start>current.start)current.end=next.start;}
  return output;
}

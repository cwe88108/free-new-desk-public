import type {MusicTrack} from './index.js';
export function musicTrackPosition(filePosition:number,track:Pick<MusicTrack,'cueStart'>|null|undefined):number{return Math.max(0,filePosition-(track?.cueStart??0));}
export function musicTrackDuration(fileDuration:number,track:Pick<MusicTrack,'cueStart'|'cueEnd'>|null|undefined):number{return Math.max(0,(track?.cueEnd??fileDuration)-(track?.cueStart??0));}
export function musicFilePosition(trackPosition:number,track:Pick<MusicTrack,'cueStart'>|null|undefined):number{return Math.max(0,trackPosition)+(track?.cueStart??0);}
export function musicLyricPosition(filePosition:number,track:Pick<MusicTrack,'cueStart'>|null|undefined,timeBase:'track'|'file',delay:number):number{return (timeBase==='file'?filePosition:musicTrackPosition(filePosition,track))-delay;}

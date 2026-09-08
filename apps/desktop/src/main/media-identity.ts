import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type MediaIdentity=
  | {kind:'local-file';canonicalPath:string}
  | {kind:'unc-file';canonicalPath:string}
  | {kind:'url';canonicalUrl:string};

function normalizeWindowsPath(value:string):string{
  return path.win32.normalize(value)
    .replace(/\\/g,'/')
    .replace(/\/$/,'')
    .toLocaleLowerCase('en-US');
}

export function identifyMedia(value:string):MediaIdentity{
  const input=value.trim();
  if(/^[A-Za-z]:[\\/]/.test(input))return{kind:'local-file',canonicalPath:normalizeWindowsPath(input)};
  if(/^\\\\/.test(input))return{kind:'unc-file',canonicalPath:normalizeWindowsPath(input)};
  if(/^file:/i.test(input))return{kind:'local-file',canonicalPath:normalizeWindowsPath(fileURLToPath(input))};
  try{
    const url=new URL(input);
    url.hash='';
    return{kind:'url',canonicalUrl:decodeURI(url.toString()).replace(/\/$/,'')};
  }catch{
    return{kind:'local-file',canonicalPath:normalizeWindowsPath(decodeURI(input))};
  }
}

export function sameMediaPath(actual:string|undefined,expected:string):boolean{
  if(!actual)return false;
  const a=identifyMedia(actual),b=identifyMedia(expected);
  if(a.kind==='url'&&b.kind==='url')return a.canonicalUrl===b.canonicalUrl;
  if(a.kind==='url'||b.kind==='url')return false;
  return a.canonicalPath===b.canonicalPath;
}

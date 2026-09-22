import {createHash} from 'node:crypto';

type UnknownRecord=Record<string,unknown>;

export interface ConfigSnapshotV2{
  snapshotId:string;
  schemaVersion:2;
  importedAt:string;
  contentDigest:string;
  configRevision:string;
  shell:string;
  sourceUrl?:string;
  finalUrl?:string;
  rawConfig:UnknownRecord;
  sites:unknown[];
  parses:unknown[];
  flags:unknown[];
  rules:unknown[];
  headers:UnknownRecord;
  unknownTopLevel:UnknownRecord;
}

const knownTopLevel=new Set([
  'sites','lives','spider','parses','flags','rules','headers','wallpaper','logo','notice','ads'
]);

function record(value:unknown):UnknownRecord{
  return value&&typeof value==='object'&&!Array.isArray(value)?value as UnknownRecord:{};
}
export function configLocationLabel(value:string|undefined):string|undefined{
  if(!value)return;
  try{const url=new URL(value);url.username='';url.password='';url.search='';url.hash='';return url.toString();}catch{return;}
}
export function createConfigSnapshotV2(input:{
  decodedText:string;
  parsed:UnknownRecord;
  shell:string;
  sourceUrl?:string;
  finalUrl?:string;
  importedAt?:string;
}):ConfigSnapshotV2{
  const contentDigest=createHash('sha256').update(input.decodedText,'utf8').digest('hex');
  const unknownTopLevel=Object.fromEntries(Object.entries(input.parsed).filter(([key])=>!knownTopLevel.has(key)));
  return{
    snapshotId:`cfg-${contentDigest.slice(0,24)}`,
    schemaVersion:2,
    importedAt:input.importedAt??new Date().toISOString(),
    contentDigest,
    configRevision:contentDigest,
    shell:input.shell,
    ...(input.sourceUrl?{sourceUrl:input.sourceUrl}:{}),
    ...(input.finalUrl?{finalUrl:input.finalUrl}:{}),
    rawConfig:structuredClone(input.parsed),
    sites:Array.isArray(input.parsed.sites)?structuredClone(input.parsed.sites):[],
    parses:Array.isArray(input.parsed.parses)?structuredClone(input.parsed.parses):[],
    flags:Array.isArray(input.parsed.flags)?structuredClone(input.parsed.flags):[],
    rules:Array.isArray(input.parsed.rules)?structuredClone(input.parsed.rules):[],
    headers:structuredClone(record(input.parsed.headers)),
    unknownTopLevel:structuredClone(unknownTopLevel)
  };
}

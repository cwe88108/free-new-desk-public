import {createHash} from 'node:crypto';
import type {LiveSourceConfig,SourceAuditResult,SourceConfig} from '@free-new-desk/contracts';

export function sourceHealthFingerprint(source:SourceConfig|LiveSourceConfig):string{
  const vod='kind' in source?source:undefined;
  return createHash('sha256').update(JSON.stringify({
    endpoint:source.endpoint,headers:Object.entries(source.headers??{}).sort(([a],[b])=>a.localeCompare(b)),
    kind:vod?.kind??'live',ext:vod?.ext??'',jar:vod?.jar??'',searchable:vod?.searchable??true,
    categories:vod?.categories??[],playUrl:vod?.playUrl??'',playerType:vod?.playerType??null,
    configRevision:vod?.configRevision??'',type4Dialect:vod?.type4Dialect??''
  })).digest('hex');
}

export function readHealthEvidence(text:string|null,sourceId:string):{fingerprint:string;audit?:SourceAuditResult}|undefined{
  if(!text)return;
  try{
    const value=JSON.parse(text);if(typeof value?.fingerprint!=='string')return;
    const audit=value.audit;
    if(!audit)return{fingerprint:value.fingerprint};
    if(audit.sourceId!==sourceId||typeof audit.ok!=='boolean'||typeof audit.checkedAt!=='string'||!['source-interface','playback-e2e'].includes(audit.scope)||!Array.isArray(audit.stages)||audit.stages.length>16)return;
    if(!audit.stages.every((stage:Record<string,unknown>)=>stage&&typeof stage.stage==='string'&&typeof stage.ok==='boolean'&&typeof stage.durationMs==='number'&&Number.isFinite(stage.durationMs)&&stage.durationMs>=0&&(stage.message===undefined||typeof stage.message==='string')))return;
    return{fingerprint:value.fingerprint,audit};
  }catch{return;}
}

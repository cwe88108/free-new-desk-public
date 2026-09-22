import type {PlaybackDescriptorV2,PlayResult} from '@free-new-desk/contracts';

type JsonRecord=Record<string,unknown>;
function parsed(value:unknown):unknown{if(typeof value!=='string')return value;const text=value.trim();if(!text)return{};try{return JSON.parse(text) as unknown;}catch{return value;}}
function record(value:unknown):JsonRecord{const input=parsed(value);return input&&typeof input==='object'&&!Array.isArray(input)?input as JsonRecord:{};}

export interface LegacyPlaybackBridgeInput{
  sourceId:string;
  configRevision?:string;
  originProfileId?:string;
  flag?:string;
  rawValue?:unknown;
  result:PlayResult;
}

export function legacyPlayResultToDescriptorV2(input:LegacyPlaybackBridgeInput):PlaybackDescriptorV2{
  const raw=record(input.rawValue),parseHint=raw.parse,jxHint=raw.jx,requiresParser=input.result.parse===true;
  const rawPlayUrl=typeof raw.playUrl==='string'?raw.playUrl:typeof raw.play_url==='string'?raw.play_url:undefined;
  const subtitles=input.result.subtitles?.map(item=>({url:item.url,...(item.name?{name:item.name}:{})}));
  return{
    schemaVersion:2,
    sourceId:input.sourceId,
    configRevision:input.configRevision??'legacy',
    originProfileId:input.originProfileId??'legacy-play-result-v1',
    rawHints:{...(parseHint!==undefined?{parse:parseHint}:{}),...(jxHint!==undefined?{jx:jxHint}:{}),...(input.flag?{flag:input.flag}:{}),...(rawPlayUrl?{playUrl:rawPlayUrl}:{})},
    resolutionIntent:requiresParser?'parser':'direct',
    candidates:[{id:'primary',target:requiresParser?{kind:'parser-input',value:input.result.url,parserIds:[]}:{kind:'media',url:input.result.url},seekability:'unknown',...(input.result.headers?{headers:input.result.headers}:{})}],
    ...(subtitles?.length?{subtitles}:{}),drmStatus:input.result.drm?'declared-unsupported':'none'
  };
}

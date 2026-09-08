import type { SourceConfig } from '@free-new-desk/contracts';
export type RuntimeFlavor='legacy-t3-js'|'drpy2-esm'|'unsupported';
export type RuntimeHint='drpy2'|'legacy'|'unknown';
export interface RuntimeClassification{flavor:RuntimeFlavor;score:number;signals:string[];engineVersion?:string;}
export function runtimeHint(config:Pick<SourceConfig,'endpoint'|'ext'>):RuntimeHint{const locator=`${config.endpoint??''} ${config.ext??''}`;if(/drpy2(?:\.min)?\.js(?:[?#]|\s|$)/i.test(locator))return'drpy2';if(/(?:^|[/_-])drpy(?:\.min)?\.js(?:[?#]|\s|$)/i.test(locator))return'legacy';return'unknown';}
export function classifyRuntimeFlavor(config:Pick<SourceConfig,'endpoint'|'ext'>,sourceCode=''):RuntimeClassification{
  const signals:string[]=[];let score=0;const locator=`${config.endpoint??''} ${config.ext??''}`;
  if(runtimeHint(config)==='drpy2'){score+=2;signals.push('url:drpy2');}
  if(/\bexport\s+default\b/.test(sourceCode)){score+=3;signals.push('source:export-default');}
  if(/\bimport\s+(?:[^'";]+from\s*)?['"][^'"]+['"]/.test(sourceCode)){score+=2;signals.push('source:esm-import');}
  if(/\bfunction\s+DRPY\b|\bclass\s+DRPY\b/.test(sourceCode)){score+=2;signals.push('source:drpy-core');}
  for(const name of ['getRule','init','home','category','detail','search','play'])if(new RegExp(`\\b${name}\\b`).test(sourceCode)){score+=.25;signals.push(`api:${name}`);}
  const version=/\b(?:drpy2\D{0,20})?(3\.9(?:\.\d+)?(?:beta\d+)?)/i.exec(sourceCode)?.[1];if(version){score+=1;signals.push(`version:${version}`);}
  if(score>=5&&/\bexport\s+default\b/.test(sourceCode))return{flavor:'drpy2-esm',score,signals,...(version?{engineVersion:version}:{})};
  if(/\bexport\s+default\b|\bimport\s+/.test(sourceCode))return{flavor:'unsupported',score,signals,...(version?{engineVersion:version}:{})};
  return{flavor:'legacy-t3-js',score,signals,...(version?{engineVersion:version}:{})};
}

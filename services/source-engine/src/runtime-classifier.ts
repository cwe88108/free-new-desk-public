import type { SourceConfig } from '@free-new-desk/contracts';
export type RuntimeFlavor='legacy-t3-js'|'drpy2-esm'|'unsupported';
export type RuntimeHint='drpy2'|'legacy'|'unknown';
export interface RuntimeClassification{flavor:RuntimeFlavor;score:number;signals:string[];engineVersion?:string;}
export function runtimeHint(config:Pick<SourceConfig,'endpoint'|'ext'>):RuntimeHint{const locator=`${config.endpoint??''} ${config.ext??''}`;if(/drpy2(?:\.min)?\.js(?:[?#]|\s|$)/i.test(locator))return'drpy2';if(/(?:^|[/_-])drpy(?:\.min)?\.js(?:[?#]|\s|$)/i.test(locator))return'legacy';return'unknown';}
export function classifyRuntimeFlavor(config:Pick<SourceConfig,'endpoint'|'ext'>,sourceCode=''):RuntimeClassification{
  const signals:string[]=[];let score=0;const hint=runtimeHint(config);
  if(hint==='drpy2'){score+=2;signals.push('url:drpy2');}
  const hasDefault=/\bexport\s+default\b/.test(sourceCode),hasImport=/\bimport\s+(?:[^'";]+from\s*)?['"][^'"]+['"]/.test(sourceCode),hasDrpyCore=/\bfunction\s+DRPY\b|\bclass\s+DRPY\b/.test(sourceCode),hasDrpy2Identity=/\bdrpy2(?:\.1)?\b/i.test(sourceCode);
  if(hasDefault){score+=3;signals.push('source:export-default');}if(hasImport){score+=2;signals.push('source:esm-import');}if(hasDrpyCore){score+=2;signals.push('source:drpy-core');}if(hasDrpy2Identity){score+=1;signals.push('source:drpy2');}
  for(const name of ['getRule','init','home','category','detail','search','play'])if(new RegExp(`\\b${name}\\b`).test(sourceCode)){score+=.25;signals.push(`api:${name}`);}
  const version=/\bdrpy2(?:\.1)?\D{0,20}(3\.9(?:\.\d+)?(?:beta\d+)?)/i.exec(sourceCode)?.[1];if(version)signals.push(`version:${version}`);
  const drpyIdentity=hint==='drpy2'||hasDrpy2Identity;
  if(drpyIdentity&&score>=5&&hasDefault)return{flavor:'drpy2-esm',score,signals,...(version?{engineVersion:version}:{})};
  if(hasDefault||hasImport)return{flavor:'unsupported',score,signals,...(version?{engineVersion:version}:{})};
  return{flavor:'legacy-t3-js',score,signals,...(version?{engineVersion:version}:{})};
}

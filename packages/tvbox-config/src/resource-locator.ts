export type ResourceSemantic='url'|'ext'|'jar'|'parser';

const absoluteScheme=/^[a-z][a-z0-9+.-]*:/i;
const windowsDrive=/^[A-Za-z]:[\\/]/;
const uncPath=/^\\\\/;
const cspClass=/^csp_/i;

function looksInline(value:string):boolean{
  const text=value.trim();
  return text.startsWith('{')||text.startsWith('[')||text.startsWith('(');
}

function looksPathLike(value:string):boolean{
  return /^(?:\.\.?[\\/]|[\\/])/.test(value)||/[\\/]/.test(value)||/\.(?:js|json|jar|mjs|cjs|txt)(?:[?#]|$)/i.test(value);
}

export function resolveConfigResource(value:string,baseUrl?:string,semantic:ResourceSemantic='url'):string{
  const text=value.trim();
  if(!text||!baseUrl||absoluteScheme.test(text)||windowsDrive.test(text)||uncPath.test(text)||cspClass.test(text)||looksInline(text))return text;
  if(semantic==='ext'&&!looksPathLike(text))return text;
  if(/\s/.test(text))return text;
  try{return new URL(text,baseUrl).toString();}catch{return text;}
}

export function resolveResourceSpec(value:string,baseUrl?:string):string{
  const parts=value.split(';');
  const location=resolveConfigResource((parts.shift()??'').trim(),baseUrl,'jar');
  return[location,...parts].join(';');
}

export function resolveParserResource(value:string,baseUrl?:string):string{
  const text=value.trim();
  if(!text)return'';
  if(/^json:/i.test(text))return'json:'+resolveConfigResource(text.slice(5),baseUrl,'parser');
  return resolveConfigResource(text,baseUrl,'parser');
}

import { load } from 'cheerio';

const NO_ADD=/:eq|:lt|:gt|:first|:last|:not|:even|:odd|:has|:contains|:matches|:empty|^body$|^#/;
const JOIN_URL=/(url|src|href|-original|-src|-play|-url|style)$|^(data-|url-|src-)/i;
const SPECIAL_URL=/^(ftp|magnet|thunder|ws):/i;
const STYLE_URL=/url\((.*?)\)/is;

function normalizeRule(parse:string,first:boolean):string{
  const clean=parse.trim();if(!clean)return'';
  if(!clean.includes('&&')){const parts=clean.split(/\s+/),last=parts.at(-1)??'';return first&&!NO_ADD.test(last)?`${clean}:eq(0)`:clean;}
  const parts=clean.split('&&');return parts.map((part,index)=>{const value=part.trim(),last=value.split(/\s+/).at(-1)??'';if(NO_ADD.test(last))return value;return!first&&index===parts.length-1?value:`${value}:eq(0)`;}).join(' ');
}
function splitExcludes(rule:string):{selector:string;excludes:string[]}{const parts=rule.split('--').map(value=>value.trim()).filter(Boolean);return{selector:parts.shift()??'',excludes:parts};}
function applyRule(html:string,parse:string,first:boolean){
  const $=load(html);let current:any=$.root().find('*').slice(0,0);
  const normalized=normalizeRule(parse,first);if(!normalized)return{$,current};
  for(const raw of normalized.split(/\s+/).filter(Boolean)){
    const eq=/^(.*):eq\((-?\d+)\)$/.exec(raw),base=(eq?.[1]??raw).trim();
    const {selector,excludes}=splitExcludes(base);if(!selector)return{$,current:current.slice(0,0)};
    current=current.length?current.find(selector):$(selector);
    if(eq){const index=Number(eq[2]);current=current.eq(index<0?current.length+index:index);}
    if(excludes.length){current=current.clone();for(const exclude of excludes)current.find(exclude).remove();}
    if(!current.length)break;
  }
  return{$,current};
}
export function joinUrl(base:string,value:string):string{
  const target=String(value??'').trim();if(!target)return'';if(SPECIAL_URL.test(target))return target;
  try{if(/^https?:/i.test(target))return new URL(target).toString();if(target.startsWith('//')){const protocol=new URL(base).protocol;return`${protocol}${target}`;}return new URL(target,base).toString();}catch{return target;}
}
export function pdfh(html:string,rule:string):string{
  if(!html||!rule?.trim())return'';const clean=rule.trim(),$=load(html);
  if(clean==='body&&Text'||clean==='Text')return $.root().text().replace(/\s+/g,' ').trim();
  if(clean==='body&&Html'||clean==='Html')return $.html();
  const parts=clean.split('&&'),option=parts.length>1?(parts.pop()??''):'';
  const selected=applyRule(html,parts.join('&&')||clean,true);if(!selected.current.length)return'';
  if(!option)return selected.current.toString();if(option==='Text')return selected.current.text();if(option==='Html')return selected.current.html()??'';
  for(const name of option.split('||').map(value=>value.trim()).filter(Boolean)){
    let result=selected.current.attr(name)??'';
    if(/style/i.test(name)&&STYLE_URL.test(result)){result=STYLE_URL.exec(result)?.[1]??result;result=result.replace(/^['"]|['"]$/g,'');}
    if(result)return result;
  }
  return'';
}
export function pdfa(html:string,rule:string):string[]{
  if(!html||!rule?.trim())return[];const selected=applyRule(html,rule,false);return selected.current.toArray().map((node:unknown)=>selected.$.html(node as never));
}
export function pd(html:string,rule:string,baseUrl=''):string{
  let result=pdfh(html,rule);if(!result||!baseUrl)return result;
  const option=rule.includes('&&')?(rule.split('&&').at(-1)??''):(rule.split(/\s+/).at(-1)??'');
  if(!JOIN_URL.test(option)||SPECIAL_URL.test(result))return result;
  if(result.includes('http'))result=result.slice(result.indexOf('http'));else result=joinUrl(baseUrl,result);return result;
}
export function createDrpyHostParser(){return{pdfh,pdfa,pd,joinUrl};}

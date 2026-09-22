import { load } from 'cheerio';

const NO_ADD=/:eq|:lt|:gt|:first|:last|:not|:even|:odd|:has|:contains|:matches|:empty|^body$|^#/;
const JOIN_URL=/(url|src|href|-original|-src|-play|-url|style)$|^(data-|url-|src-)/i;
const SPECIAL_URL=/^(ftp|magnet|thunder|ws):/i;
const STYLE_URL=/url\((.*?)\)/is;

function splitChain(parse:string):string[]{
  const parts:string[]=[];let value='',quote='',square=0,paren=0;
  for(let index=0;index<parse.length;index++){
    const char=parse[index]??'';
    if(quote){value+=char;if(char===quote&&parse[index-1]!==String.fromCharCode(92))quote='';continue;}
    if(char==='"'||char==="'"){quote=char;value+=char;continue;}
    if(char==='[')square++;else if(char===']'&&square)square--;else if(char==='(')paren++;else if(char===')'&&paren)paren--;
    if(char==='&'&&parse[index+1]==='&'&&square===0&&paren===0){parts.push(value.trim());value='';index++;continue;}
    value+=char;
  }
  parts.push(value.trim());return parts.filter(Boolean);
}
function normalizeSegments(parse:string,first:boolean):string[]{
  const parts=splitChain(parse);return parts.map((value,index)=>{
    const last=value.split(/\s+/).at(-1)??'',takeFirst=first||index<parts.length-1;
    return takeFirst&&!NO_ADD.test(last)?`${value}:eq(0)`:value;
  });
}
function splitExcludes(rule:string):{selector:string;excludes:string[]}{const parts=rule.split('--').map(value=>value.trim()).filter(Boolean);return{selector:parts.shift()??'',excludes:parts};}
function normalizedText(nodes:any[]):string{
  const chunks:string[]=[];
  const visit=(node:any):void=>{
    const name=String(node?.name??'').toLowerCase();if(name==='script'||name==='style')return;
    if(node?.type==='text'){const text=String(node.data??'').replace(/\s+/g,' ').trim();if(text)chunks.push(text);return;}
    for(const child of node?.children??[])visit(child);
  };
  for(const node of nodes)visit(node);return chunks.join(' ').replace(/\s+/g,' ').trim();
}
function applyRule(html:string,parse:string,first:boolean){
  const $=load(html);let current:any=$.root().find('*').slice(0,0);
  const segments=normalizeSegments(parse,first);if(!segments.length)return{$,current};
  for(const raw of segments){
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
  if(!html||!rule?.trim())return'';const clean=rule.trim(),$=load(html),chain=splitChain(clean);
  if(chain.length===1&&chain[0]==='Text')return normalizedText($.root().toArray());
  if(chain.length===1&&chain[0]==='Html')return $.root().html()??'';
  const option=chain.length>1?(chain.pop()??''):'';
  const selected=applyRule(html,chain.join('&&')||clean,true);if(!selected.current.length)return'';
  if(!option)return selected.current.toString();if(option==='Text')return normalizedText(selected.current.toArray());if(option==='Html')return selected.current.html()??'';
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
  const chain=splitChain(rule),option=chain.length>1?(chain.at(-1)??''):(rule.split(/\s+/).at(-1)??'');
  if(!JOIN_URL.test(option)||SPECIAL_URL.test(result))return result;
  if(result.includes('http'))result=result.slice(result.indexOf('http'));else result=joinUrl(baseUrl,result);return result;
}
export function createDrpyHostParser(){return{pdfh,pdfa,pd,joinUrl};}

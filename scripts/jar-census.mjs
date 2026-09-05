import { inspectJar } from '../services/source-engine/dist/jar-inspector.js';
import { unshell } from '../packages/tvbox-config/dist/index.js';

const inputs=process.argv.slice(2);
if(!inputs.length){console.error('Usage: node scripts/jar-census.mjs <config-url> [more...]');process.exit(2);}
const timeoutMs=20_000;
function withTimeout(){const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),timeoutMs);return{signal:controller.signal,dispose:()=>clearTimeout(timer)};}
async function get(url){const guard=withTimeout();try{return await fetch(url,{redirect:'follow',headers:{'User-Agent':'Mozilla/5.0 Free-New-Desk-Jar-Census/2.0'},signal:guard.signal});}finally{guard.dispose();}}
function resolveSpec(base,spec){const raw=spec.split(';')[0]?.trim()??'';if(!raw)return'';try{return new URL(raw,base).toString();}catch{return raw;}}
const configs=[];const jarRefs=new Map();
for(const configUrl of inputs){try{const response=await get(configUrl);const raw=await response.text();const shell=unshell(raw);configs.push({configUrl,status:response.status,shell:shell.shell,bytes:raw.length});const text=shell.text;for(const match of text.matchAll(/"(?:spider|jar)"\s*:\s*"([^"]+)"/g)){const spec=match[1]??'';const url=resolveSpec(response.url||configUrl,spec);if(/^https?:\/\//i.test(url)&&!jarRefs.has(url))jarRefs.set(url,{url,configUrl,spec});}}catch(error){configs.push({configUrl,status:0,error:error instanceof Error?error.message:String(error)});}}
const jars=[];
for(const item of [...jarRefs.values()].slice(0,20)){try{const response=await get(item.url);const bytes=Buffer.from(await response.arrayBuffer());const report=inspectJar(bytes);jars.push({...item,status:response.status,finalUrl:response.url||item.url,bytes:bytes.length,...report});}catch(error){jars.push({...item,status:0,error:error instanceof Error?error.message:String(error)});}}
const counts={JVM:0,DEX:0,HYBRID:0,NATIVE:0,ANDROID_REQUIRED:0,INVALID:0,FAILED:0};for(const item of jars){if('kind'in item&&item.kind in counts)counts[item.kind]+=1;else counts.FAILED+=1;}
function rank(field){const values=new Map();for(const jar of jars)for(const name of Array.isArray(jar[field])?jar[field]:[])values.set(name,(values.get(name)??0)+1);return[...values.entries()].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])).slice(0,30).map(([name,count])=>({name,count}));}
const report={generatedAt:new Date().toISOString(),configs,uniqueJarRefs:jarRefs.size,inspected:jars.length,counts,androidApiRanking:rank('androidRefs'),catvodApiRanking:rank('catvodRefs'),jars};
console.log(JSON.stringify(report,null,2));

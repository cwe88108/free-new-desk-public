import {createRequire} from 'node:module';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
const [archive,output]=process.argv.slice(2);
if(!archive||!output)throw Error('Usage: node benchmark-disk-cache.mjs baseline.asar output.json');
const asar=createRequire(import.meta.url)('@electron/asar');
const dir=await mkdtemp(path.resolve(path.dirname(output),'cache-perf-'));
const entry=asar.listPackage(archive).find(x=>x.replaceAll('\\','/').endsWith('/apps/desktop/dist/main/cache-service.js'));
if(!entry)throw Error('Baseline cache module missing');
await writeFile(path.join(dir,'baseline.mjs'),asar.extractFile(archive,entry.replace(/^[/\\]/,'')));
const Baseline=(await import(pathToFileURL(path.join(dir,'baseline.mjs')))).DiskCache;
const Candidate=(await import('../apps/desktop/dist/main/cache-service.js')).DiskCache;
const results=[];
for(const [round,kind] of ['baseline','candidate','candidate','baseline'].entries()){
  const pending=new Set();
  const writer=(file,data,enc)=>{const p=writeFile(file,data,enc);pending.add(p);p.then(()=>pending.delete(p),()=>pending.delete(p));return p;};
  const cache=new (kind==='baseline'?Baseline:Candidate)(path.join(dir,'round-'+round),64*1024*1024,writer);
  await cache.init();const payload=Buffer.alloc(32768,7);let start=performance.now();
  for(let i=0;i<100;i++)await cache.put('images','poster-'+i,payload);
  const seedMs=performance.now()-start;start=performance.now();const latency=[];
  for(let i=0;i<100;i+=10)await Promise.all(Array.from({length:10},async(_,j)=>{
    const at=performance.now(),hit=await cache.get('images','poster-'+(i+j));
    if(hit?.data.length!==payload.length)throw Error('Cache miss/corruption');
    latency.push(performance.now()-at);
  }));
  await Promise.all([...pending]);const readMs=performance.now()-start;
  latency.sort((a,b)=>a-b);results.push({round,kind,seedMs,readMs,p95Ms:latency[Math.ceil(latency.length*.95)-1],count:latency.length});
}
await writeFile(output,JSON.stringify({dir,archive,concurrency:10,entryBytes:32768,results},null,2));
console.log(JSON.stringify(results));

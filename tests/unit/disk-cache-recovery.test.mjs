import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,readFile,writeFile,readdir,rm,stat,utimes} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {DiskCache} from '../../apps/desktop/dist/main/cache-service.js';
async function fixture(t,writer,touch){const root=await mkdtemp(path.join(os.tmpdir(),'fnd-cache-recovery-'));t.after(()=>rm(root,{recursive:true,force:true}));const cache=new DiskCache(root,40,writer,touch);await cache.init();return{root,cache};}
test('a cache read issued during startup waits for orphan cleanup',async t=>{
  const {root,cache}=await fixture(t);
  await cache.put('images','valid',Buffer.alloc(20));
  const dir=path.join(root,'images');
  const orphan='a'.repeat(64)+'.bin';
  await writeFile(path.join(dir,orphan),Buffer.alloc(20));
  const filesDuringTouch=[];
  const reopened=new DiskCache(root,40,undefined,async(file,atime,mtime)=>{
    filesDuringTouch.push(...await readdir(dir));
    await utimes(file,atime,mtime);
  });
  const initializing=reopened.init();
  const trackedCount=reopened.fileCount();
  const hit=await reopened.get('images','valid');
  await initializing;
  assert.equal(hit?.data.length,20);
  assert.equal(filesDuringTouch.length,2);
  assert.ok(!filesDuringTouch.includes(orphan));
  assert.equal(await trackedCount,1);
});
test('prune removes orphan and malformed managed pairs but preserves unrelated files',async t=>{
  const {root,cache}=await fixture(t);await cache.put('images','valid',Buffer.alloc(20));
  const dir=path.join(root,'images');
  await writeFile(path.join(dir,'a'.repeat(64)+'.bin'),Buffer.alloc(60));
  await writeFile(path.join(dir,'b'.repeat(64)+'.json'),'{}');
  await writeFile(path.join(dir,'c'.repeat(64)+'.bin'),Buffer.alloc(60));
  await writeFile(path.join(dir,'c'.repeat(64)+'.json'),'{broken');
  await writeFile(path.join(dir,'notes.txt'),'keep');
  await cache.prune();
  const files=await readdir(dir);assert.equal(files.length,3);assert.ok(files.includes('notes.txt'));
  let actual=0;for(const file of files)if(file.endsWith('.bin'))actual+=(await stat(path.join(dir,file))).size;
  assert.equal(actual,20);assert.equal((await cache.stats()).bytes,actual);
  assert.equal((await cache.get('images','valid')).data.length,20);
});
test('pruning repairs incomplete pairs across scan batches before queued reads',async t=>{
  const {root}=await fixture(t);
  const dir=path.join(root,'images');
  await mkdir(dir);
  const started=Date.now();
  const keyFor=index=>'seed-'+index;
  const idFor=index=>createHash('sha256').update(keyFor(index)).digest('hex');
  const invalid=new Set([0,7,14]);
  for(let i=0;i<24;i++){
    const base=path.join(dir,idFor(i));
    const timestamp=started-60_000+i*1000;
    await writeFile(base+'.bin',Buffer.alloc(10,i));
    if(invalid.has(i))continue;
    await writeFile(base+'.json',JSON.stringify({contentType:'image/jpeg',size:10,accessedAt:timestamp,expiresAt:started+60_000}));
    await utimes(base+'.json',timestamp/1000,timestamp/1000);
  }
  const cache=new DiskCache(root,30);
  const pruning=cache.prune();
  const kept=await Promise.all([21,22,23].map(index=>cache.get('images',keyFor(index))));
  await pruning;
  assert.deepEqual(kept.map(value=>value?.data[0]),[21,22,23]);
  assert.deepEqual((await readdir(dir)).sort(),[21,22,23].flatMap(index=>[idFor(index)+'.bin',idFor(index)+'.json']).sort());
  assert.equal((await cache.stats()).bytes,30);
});
test('prune waits for a live write and clear cannot be undone by a late write',async t=>{
  let started,release;
  const writing=new Promise(r=>started=r),gate=new Promise(r=>release=r);
  let hold=true;
  const {cache,root}=await fixture(t,async(file,data,encoding)=>{
    await writeFile(file,data,encoding);
    if(hold&&file.endsWith('.bin')){hold=false;started();await gate;}
  });
  const put=cache.put('images','inflight',Buffer.alloc(20));await writing;
  const prune=cache.prune(),clear=cache.clear('images');
  release();await Promise.all([put,prune,clear]);
  assert.equal(await cache.get('images','inflight'),undefined);
  assert.equal(await cache.fileCount(),0);
  assert.deepEqual(await readdir(root),[]);
});
test('failed metadata write cleans its data file and does not poison the operation queue',async t=>{
  let fail=true;
  const {cache,root}=await fixture(t,async(file,data,encoding)=>{
    if(fail&&file.endsWith('.json')){fail=false;throw Object.assign(new Error('write denied'),{code:'EACCES'});}
    await writeFile(file,data,encoding);
  });
  await assert.rejects(cache.put('images','bad',Buffer.alloc(20)),/write denied/);
  assert.deepEqual(await readdir(path.join(root,'images')),[]);
  await cache.put('images','good',Buffer.alloc(20));assert.equal((await cache.get('images','good')).data.length,20);
});
test('access promotes an entry before budget eviction and expired entries are removed',async t=>{
  const {cache}=await fixture(t);
  const tick=()=>new Promise(r=>setTimeout(r,10));
  await cache.put('images','a',Buffer.alloc(20));await tick();await cache.put('images','b',Buffer.alloc(20));await tick();
  await cache.get('images','a');await tick();await cache.put('images','c',Buffer.alloc(20));
  assert.equal(await cache.get('images','b'),undefined);assert.ok(await cache.get('images','a'));assert.ok(await cache.get('images','c'));
  await cache.put('images','expired',Buffer.alloc(1),'image/png',-1);
  assert.equal(await cache.get('images','expired'),undefined);assert.equal((await cache.stats()).bytes,40);
});
test('a write below the budget still removes entries whose TTL has elapsed',async t=>{
  const {cache,root}=await fixture(t);
  await cache.put('images','short-lived',Buffer.alloc(10),'image/png',20);
  await new Promise(resolve=>setTimeout(resolve,35));
  await cache.put('vod-data','small',Buffer.alloc(10),'application/json');
  assert.deepEqual(await readdir(path.join(root,'images')),[]);
  assert.equal((await cache.get('vod-data','small'))?.data.length,10);
});
test('recalculating after repeated replacements preserves entries that fit the budget',async t=>{
  const {cache}=await fixture(t);
  await cache.put('images','old',Buffer.alloc(20));
  for(let i=0;i<6;i++)await cache.put('vod-data','same',Buffer.alloc(20,i));
  assert.equal((await cache.stats()).bytes,40);
  assert.deepEqual((await cache.get('images','old'))?.data,Buffer.alloc(20));
  assert.deepEqual((await cache.get('vod-data','same'))?.data,Buffer.alloc(20,5));
});
test('repeated ENOSPC is bounded and leaves no partial cache pair',async t=>{
  let failures=0;
  const {cache,root}=await fixture(t,async(file,data,encoding)=>{
    if(file.endsWith('.json')){failures++;throw Object.assign(new Error('disk remains full'),{code:'ENOSPC'});}
    await writeFile(file,data,encoding);
  });
  await assert.rejects(cache.put('images','bad',Buffer.alloc(20)),/disk remains full/);
  assert.equal(failures,2);assert.deepEqual(await readdir(path.join(root,'images')),[]);
  assert.equal((await cache.stats()).bytes,0);
});
test('a failed timestamp update preserves metadata and a leftover scratch is removed on restart',async t=>{
  let failures=0;
  const {cache,root}=await fixture(t,undefined,async()=>{
    failures++;
    throw Object.assign(new Error('disk full'),{code:'ENOSPC'});
  });
  const payload=Buffer.from('valid image');
  await cache.put('images','keep',payload,'image/png');
  const dir=path.join(root,'images');
  const files=await readdir(dir);
  assert.equal(files.length,2);
  const meta=path.join(dir,files.find(file=>file.endsWith('.json')));
  const original=await readFile(meta);
  assert.deepEqual(await cache.get('images','keep'),{data:payload,contentType:'image/png'});
  assert.deepEqual(await readFile(meta),original);
  assert.equal(failures,1);
  await writeFile(meta+'.touch','{');
  const reopened=new DiskCache(root,64);
  await reopened.init();
  assert.deepEqual(await readdir(dir),files);
  assert.deepEqual(await reopened.get('images','keep'),{data:payload,contentType:'image/png'});
});
test('a read promotes its persisted timestamp before eviction after restart',async t=>{
  const {cache,root}=await fixture(t);
  const tick=()=>new Promise(r=>setTimeout(r,20));
  await cache.put('images','visited',Buffer.alloc(20));
  await tick();
  await cache.put('images','older access',Buffer.alloc(20));
  await tick();
  assert.ok(await cache.get('images','visited'));
  const reopened=new DiskCache(root,40);
  await reopened.init();
  await reopened.put('images','newest',Buffer.alloc(20));
  assert.equal(await reopened.get('images','older access'),undefined);
  assert.ok(await reopened.get('images','visited'));
});
test('independent reads overlap while clear waits for pending access-time writes',async t=>{
  let hold=false,started,release;
  const entered=new Promise(r=>started=r),gate=new Promise(r=>release=r);
  t.after(()=>release());
  const {cache,root}=await fixture(t,undefined,async(file,atime,mtime)=>{
    if(hold){hold=false;started();await gate;}
    await utimes(file,atime,mtime);
  });
  await cache.put('images','a',Buffer.alloc(10));await cache.put('images','b',Buffer.alloc(10));
  hold=true;const first=cache.get('images','a');await entered;
  assert.ok(await cache.get('images','b'),'different keys must not wait for the blocked reader');
  const clear=cache.clear('images');release();await first;await clear;
  assert.deepEqual(await readdir(root),[]);
});

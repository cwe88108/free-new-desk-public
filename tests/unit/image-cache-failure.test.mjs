import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {ImageService} from '../../apps/desktop/dist/main/image-service.js';
import {DiskCache} from '../../apps/desktop/dist/main/cache-service.js';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=','base64');

test('JPEG error pages are neither served nor cached and legacy error entries can recover',async()=>{
  const invalid={data:Buffer.from('error code: 503'),contentType:'image/jpeg'};
  const valid=Buffer.from([0xff,0xd8,0xff,0xe0,0,2,0xff,0xd9]);
  let cached=invalid,fetches=0,writes=0;
  const image=new ImageService({
    get:async()=>cached,
    put:async(_namespace,_key,data,contentType)=>{writes++;cached={data,contentType};},
  },{request:async()=>new Response(++fetches===1?invalid.data:valid,{headers:{'content-type':'image/jpeg'}})});
  const url=image.url('https://example.invalid/poster.jpg');
  assert.equal((await image.handle(url)).status,415);
  assert.equal(fetches,1);
  assert.equal(writes,0);
  assert.deepEqual(Buffer.from(await (await image.handle(url)).arrayBuffer()),valid);
  assert.deepEqual(Buffer.from(await (await image.handle(url)).arrayBuffer()),valid);
  assert.equal(fetches,2);
  assert.equal(writes,1);
});

test('PNG bytes declared as JPEG retain the correct response and cache type',async()=>{
  let cached,fetches=0;
  const image=new ImageService({
    get:async()=>cached,
    put:async(_namespace,_key,data,contentType)=>{cached={data,contentType};},
  },{request:async()=>{fetches++;return new Response(png,{headers:{'content-type':'image/jpeg'}});}});
  const url=image.url('https://example.invalid/poster.jpg');
  for(const expected of [undefined,{data:png,contentType:'image/jpeg'}]){
    cached=expected;
    const response=await image.handle(url);
    assert.equal(response.headers.get('content-type'),'image/png');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()),png);
    if(!expected)assert.equal(cached.contentType,'image/png');
  }
  assert.equal(fetches,1);
});

test('downloaded images remain displayable when cache persistence fails',async()=>{
  for(const code of ['ENOSPC','EACCES','EIO']){
    let writes=0,requests=0;
    const image=new ImageService({get:async()=>undefined,put:async()=>{writes++;throw Object.assign(new Error('cache unavailable'),{code});}},
      {request:async()=>{requests++;return new Response(png,{headers:{'content-type':'image/png'}});}});
    const response=await image.handle(image.url('https://example.invalid/poster.png'));
    assert.equal(response.status,200,code);
    assert.equal(response.headers.get('content-type'),'image/png');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()),png);
    assert.equal(writes,1);assert.equal(requests,1);
  }
});

test('cache-hit access-time write failures do not produce an unhandled rejection',async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'fnd-cache-touch-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  let failures=0;
  const cache=new DiskCache(dir,1024,undefined,async()=>{
    failures++;
    throw Object.assign(new Error('readonly cache'),{code:'EACCES'});
  });
  await cache.init();await cache.put('images','poster',Buffer.from('cached'));
  assert.equal((await cache.get('images','poster')).data.toString(),'cached');
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(failures,1);
  // node:test treats unhandled rejections as failures, including after a test finishes.
});

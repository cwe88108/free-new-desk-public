import test from 'node:test';
import assert from 'node:assert/strict';
import {gzipSync} from 'node:zlib';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {parseXmltvPayload,parseXmltv,EPG_MAX_DOWNLOAD_BYTES} from '../../packages/epg-parser/dist/index.js';
import {RequestBroker} from '../../packages/source-sdk/dist/index.js';
import {ImageService} from '../../apps/desktop/dist/main/image-service.js';
import {DiskCache} from '../../apps/desktop/dist/main/cache-service.js';
import {JsonLogger} from '../../apps/desktop/dist/main/logger.js';
import {redactDiagnosticArtifact,redactDiagnosticText} from '../../apps/desktop/dist/main/diagnostic-redaction.js';
import {DataService} from '../../services/data-service/dist/index.js';

const xml='<tv><programme channel="a" start="20261103000000 Z"><title>Test</title></programme></tv>';
test('EPG caps compressed input, expanded XML, and programme count, including invalid records',()=>{
  assert.equal(parseXmltvPayload(gzipSync(xml)).length,1);
  assert.throws(()=>parseXmltvPayload(Buffer.alloc(65),{maxInputBytes:64}),/download exceeds/);
  assert.throws(()=>parseXmltvPayload(gzipSync('x'.repeat(4096)),{maxXmlBytes:128}));
  assert.throws(()=>parseXmltvPayload(Buffer.from('x'.repeat(129)),{maxXmlBytes:128}),/XML exceeds/);
  assert.throws(()=>parseXmltv('中'.repeat(10),{maxXmlBytes:29}),/XML exceeds/);
  assert.throws(()=>parseXmltv('<programme></programme>'.repeat(3),{maxPrograms:2}),/programme count/);
});

test('images cancel chunked or understated bodies at the broker byte limit and do not cache failures',async t=>{
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
  for(const declared of [undefined,'1']){
    let cancelled=false,puts=0;
    globalThis.fetch=async()=>new Response(new ReadableStream({pull(controller){controller.enqueue(new Uint8Array(6*1024*1024));},cancel(){cancelled=true;}}),{headers:{'content-type':'image/png',...(declared?{'content-length':declared}:{})}});
    const image=new ImageService({get:async()=>undefined,put:async()=>{puts++;}},new RequestBroker());
    const result=await image.handle(image.url('https://image.test/a.png'));
    assert.equal(result.status,413);assert.equal(cancelled,true);assert.equal(puts,0);
  }
});

test('images cancel non-image or error bodies without reading them',async t=>{
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
  for(const status of [200,404]){
    let cancelled=false;
    globalThis.fetch=async()=>new Response(new ReadableStream({cancel(){cancelled=true;}}),{status,headers:{'content-type':'text/html'}});
    const image=new ImageService({get:async()=>undefined},new RequestBroker());
    assert.equal((await image.handle(image.url('https://image.test/a.png'))).status,status===200?415:404);
    assert.equal(cancelled,true);
  }
});

test('disk cache enforces per-read and total-entry budgets',async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'fnd-resource-cache-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const cache=new DiskCache(dir,64);await cache.init();await cache.put('images','small',Buffer.alloc(32));
  assert.equal(await cache.get('images','small',16),undefined);
  assert.equal((await cache.get('images','small',32)).data.length,32);
  await assert.rejects(cache.put('images','large',Buffer.alloc(65)),/budget/);
});

test('Bearer, Basic, cookie lists, folded headers and nested errors leave no canary in exports or local logs',async t=>{
  const secret='CANARY_NEVER_WRITE';
  const samples=[`Authorization: Bearer ${secret}`,`AUTHORIZATION: Basic ${secret}`,`Cookie: a=one; b=${secret}`,`Set-Cookie: session=${secret}; Path=/`,`Authorization:\r\n Bearer ${secret}`,`{"Authorization":"Bearer ${secret}"}`,`failed https://user:${secret}@example.test/?token=${secret}`];
  samples.push(`access_token=${secret}`,`refreshToken: ${secret}`,`passwd=${secret}`,`passphrase: ${secret}`,`x-api-key=${secret}`,JSON.stringify({access_token:secret}),JSON.stringify({refreshToken:secret}),JSON.stringify(JSON.stringify({passwd:secret})));
  for(const key of ['client_secret','id_token','auth_token','customPassword','db_passwd','client-secret','session.cookie','privateApiKey']){
    samples.push(`${key}=${secret}`,`${key}: ${secret}`,JSON.stringify({[key]:secret}));
    assert.ok(!JSON.stringify(redactDiagnosticArtifact({[key]:secret})).includes(secret),key);
  }
  for(const sample of samples)assert.ok(!redactDiagnosticText(sample).includes(secret),sample);
  const error=new Error('request failed',{cause:new Error(samples[0])});
  const fields={error,details:samples,'x-api-key':secret,'X_API_KEY':secret,'proxy-authorization':secret,'set-cookie':secret};
  assert.ok(!JSON.stringify(redactDiagnosticArtifact(fields)).includes(secret));
  const dir=await mkdtemp(path.join(os.tmpdir(),'fnd-resource-log-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const log=new JsonLogger(dir);for(const sample of samples)log.error('test',sample,fields);
  const lines=(await readFile(log.filePath,'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(!JSON.stringify(lines).includes(secret));
  assert.ok(lines.every(line=>line.category==='test'&&line.level==='ERROR'&&typeof line.time==='string'));
  assert.equal(redactDiagnosticText('Playback completed: 120 seconds, status=ok'),'Playback completed: 120 seconds, status=ok');
  assert.deepEqual(redactDiagnosticArtifact({duration:120,position:42,status:'ok'}),{duration:120,position:42,status:'ok'});
});

test('favorites reject oversized lists before touching any entry or serializing input',t=>{
  const db=new DataService(':memory:');t.after(()=>db.close());
  for(const key of ['vod','live']){
    const values=Array(5001).fill(null);Object.defineProperty(values,0,{get(){throw new Error('ENTRY_MUST_NOT_BE_READ');}});
    assert.throws(()=>db.importFavorites({[key]:values}),/超过5000/);
  }
  const urls=Array(17).fill(null);Object.defineProperty(urls,0,{get(){throw new Error('ENTRY_MUST_NOT_BE_READ');}});
  assert.throws(()=>db.importFavorites({live:[{urls}]}),/超过16/);
  assert.deepEqual(db.vodFavoriteState().items,[]);
});

test('EPG worker bounds pending work, kills timed-out parsing, and ignores stale child exits',async()=>{
  const {EventEmitter}=await import('node:events');
  const {createRequire}=await import('node:module');
  const vm=await import('node:vm');const ts=await import('typescript');
  const require=createRequire(import.meta.url),children=[],timers=new Set();
  const fakeElectron={app:{getAppPath:()=>'/app'},utilityProcess:{fork(){const child=new EventEmitter();child.postMessage=()=>{};child.kill=()=>{child.killed=true;};children.push(child);return child;}}};
  const source=await readFile(new URL('../../apps/desktop/src/main/epg-worker-client.ts',import.meta.url),'utf8');
  const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
  const exports={};vm.runInNewContext(compiled,{exports,require:name=>name==='electron'?fakeElectron:require(name),Buffer,setTimeout:fn=>{timers.add(fn);return fn;},clearTimeout:fn=>timers.delete(fn)});
  const client=new exports.EpgWorkerClient();
  await assert.rejects(client.parse(new Uint8Array(EPG_MAX_DOWNLOAD_BYTES+1)),/byte safety limit/);assert.equal(children.length,0);
  const p1=client.parse(Buffer.from(xml)),p2=client.parse(Buffer.from(xml));
  const r1=assert.rejects(p1,/timeout/),r2=assert.rejects(p2,/timeout/);
  await assert.rejects(client.parse(Buffer.from(xml)),/capacity/);
  [...timers][0]();await Promise.all([r1,r2]);assert.equal(children[0].killed,true);assert.equal(timers.size,0);
  const next=client.parse(Buffer.from(xml)),nextRejected=assert.rejects(next,/stopped/);
  children[0].emit('exit');assert.equal(children.length,2);client.stop();await nextRejected;assert.equal(children[1].killed,true);assert.equal(timers.size,0);
});

test('plain XML, HTTP gzip and gzip files share the same expanded XML budget',async t=>{
  const {createServer}=await import('node:http');
  const payloads={small:xml,large:xml+' '.repeat(400)};
  const server=createServer((req,res)=>{
    const [format,size]=req.url.slice(1).split('/');const body=payloads[size];
    if(format==='http-gzip')res.setHeader('Content-Encoding','gzip');
    res.end(format==='plain'?body:gzipSync(body));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const broker=new RequestBroker(),limit=256;
  for(const format of ['plain','http-gzip','gzip-file'])for(const size of ['small','large']){
    const parse=async()=>{
      const response=await broker.request({sourceId:'epg-test',url:`http://127.0.0.1:${server.address().port}/${format}/${size}`,maxBytes:limit,retries:0});
      return parseXmltvPayload(new Uint8Array(await response.arrayBuffer()),{maxInputBytes:limit,maxXmlBytes:limit});
    };
    if(size==='small')assert.equal((await parse()).length,1);else await assert.rejects(parse);
  }
});

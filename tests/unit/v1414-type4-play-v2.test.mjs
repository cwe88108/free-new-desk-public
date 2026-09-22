import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {Type4Adapter} from '../../packages/source-adapters/dist/index.js';
import {legacyPlayResultToDescriptorV2} from '../../services/source-engine/dist/playback-descriptor.js';
import {sourceFailure} from '../../services/source-engine/dist/source-failure.js';

async function withServer(handler,run){const requests=[];const server=http.createServer((req,res)=>{requests.push({method:req.method,url:req.url});handler(req,res);});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();if(!address||typeof address==='string')throw new Error('fixture port missing');try{await run(`http://127.0.0.1:${address.port}/api`,requests);}finally{await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}}

test('v1.4.14 Type4 auth failure is not hidden by protocol fallback',async()=>{
  await withServer((req,res)=>{res.setHeader('content-type','application/json');if(req.method==='POST'){res.statusCode=403;res.end('{"error":"login"}');return;}res.end('{"url":"https://media.example/fallback.m3u8"}');},async(endpoint,requests)=>{
    const adapter=new Type4Adapter(endpoint,undefined,undefined,'rev');await adapter.init({sourceId:'auth'});await assert.rejects(()=>adapter.getPlay('main','ep1'),/HTTP 403/);assert.equal(requests.filter(item=>item.method==='GET').length,0);await adapter.destroy();
  });
});

test('v1.4.14 Type4 falls back once only for method-not-supported and returns V2 raw hints',async()=>{
  await withServer((req,res)=>{res.setHeader('content-type','application/json');if(req.method==='POST'){res.statusCode=405;res.end('{}');return;}const url=new URL(req.url??'/','http://fixture');if(url.searchParams.get('ac')==='play'){res.end('{"url":"https://media.example/v.m3u8","parse":0,"jx":1,"header":{"Referer":"https://ref.example/"}}');return;}res.end('{}');},async(endpoint,requests)=>{
    const adapter=new Type4Adapter(endpoint,undefined,undefined,'rev-2');await adapter.init({sourceId:'t4'});const v2=await adapter.getPlayV2('line-a','ep2');assert.equal(v2.configRevision,'rev-2');assert.equal(v2.rawHints.parse,0);assert.equal(v2.rawHints.jx,1);assert.equal(v2.resolutionIntent,'parser');assert.equal(v2.candidates[0]?.target.kind,'parser-input');assert.equal(v2.candidates[0]?.headers?.Referer,'https://ref.example/');assert.deepEqual(requests.map(item=>item.method),['POST','GET']);await adapter.destroy();
  });
});

test('v1.4.14 Type4 invalid play shape fails instead of treating episode id as a URL',async()=>{
  await withServer((_req,res)=>{res.setHeader('content-type','application/json');res.end('{"ok":true}');},async endpoint=>{const adapter=new Type4Adapter(endpoint);await adapter.init({sourceId:'shape'});await assert.rejects(()=>adapter.getPlay('main','opaque-id'),/TYPE4_RESULT_SHAPE_UNSUPPORTED/);await adapter.destroy();});
});

test('v1.4.14 legacy bridge preserves separate parse and jx hints',()=>{
  const descriptor=legacyPlayResultToDescriptorV2({sourceId:'legacy',configRevision:'r1',flag:'line',rawValue:{url:'opaque',parse:0,jx:1},result:{url:'opaque',parse:true}});assert.equal(descriptor.rawHints.parse,0);assert.equal(descriptor.rawHints.jx,1);assert.equal(descriptor.resolutionIntent,'parser');assert.equal(descriptor.candidates[0]?.target.kind,'parser-input');
});

test('v1.4.14 source errors classify auth shape timeout and upstream failures',()=>{
  assert.equal(sourceFailure(new Error('HTTP 403 for source request')).code,'AUTH_REQUIRED');assert.equal(sourceFailure(new Error('[TYPE4_RESULT_SHAPE_UNSUPPORTED] bad')).code,'RESULT_SHAPE_UNSUPPORTED');assert.equal(sourceFailure(new Error('DRPY_WORKER_HARD_TIMEOUT')).code,'RESOLVE_TIMEOUT');assert.equal(sourceFailure(new Error('HTTP 503 for source request')).code,'UPSTREAM_HTTP_ERROR');
});

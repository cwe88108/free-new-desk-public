import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {RequestBroker,RequestContextStore} from '../../packages/source-sdk/dist/index.js';
import {RuntimeManager} from '../../services/source-engine/dist/runtime-manager.js';

const config=(id,revision)=>({id,name:id,kind:'T3_JS',endpoint:'https://engine.example/rule.js',enabled:true,trust:'A',configRevision:revision});
const mockAdapter=(revision,destroyed)=>({
  init:async()=>{},getHome:async()=>({items:[]}),
  getCategory:async(_id,page)=>({page,hasMore:false,items:[]}),
  getDetail:async ids=>({id:ids[0]??'',name:'x',episodes:[]}),
  search:async(_q,page=1)=>({page,items:[]}),getPlay:async()=>({url:'https://media.example/a.mp4',parse:false}),
  destroy:async()=>{destroyed.push(revision);}
});
test('v1.4.14 S2 CookieJar honors path secure expiry domain and account isolation',async()=>{
  const store=new RequestContextStore(),a=store.bind('source',{configRevision:'r1',accountProfile:'a'}),b=store.bind('source',{configRevision:'r1',accountProfile:'b'});
  await store.captureFor(a,'https://media.example.com/api/login',new Headers({'set-cookie':'sid=api; Path=/api; Secure; Max-Age=3600'}));
  await store.captureFor(a,'https://media.example.com/api/login',new Headers({'set-cookie':'root=1; Domain=example.com; Path=/; Max-Age=3600'}));
  const api=await store.cookieHeaderFor(a,'https://media.example.com/api/list');
  assert.match(api??'',/sid=api/);assert.match(api??'',/root=1/);
  assert.equal((await store.cookieHeaderFor(a,'http://media.example.com/api/list'))?.includes('sid=api')??false,false);
  assert.match(await store.cookieHeaderFor(a,'https://sub.example.com/')??'',/root=1/);
  assert.equal(await store.cookieHeaderFor(b,'https://media.example.com/api/list'),undefined);
  await store.captureFor(a,'https://media.example.com/api/login',new Headers({'set-cookie':'sid=gone; Path=/api; Max-Age=0'}));
  assert.equal((await store.cookieHeaderFor(a,'https://media.example.com/api/list'))?.includes('sid=' )??false,false);
});

test('v1.4.14 S2 full-body timeout aborts stalled body and POST is not retried',async t=>{
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
  globalThis.fetch=async()=>new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('x'));}}),{status:200});
  const broker=new RequestBroker();
  await assert.rejects(()=>broker.text({sourceId:'stall',url:'https://example.test/body',timeoutMs:40,retries:0}),/timeout|abort/i);
  let calls=0;globalThis.fetch=async()=>{calls+=1;throw new TypeError('network down');};
  await assert.rejects(()=>broker.request({sourceId:'post',url:'https://example.test/post',method:'POST',body:'x'}),/network down/);
  assert.equal(calls,1);
  calls=0;await assert.rejects(()=>broker.request({sourceId:'get',url:'https://example.test/get',method:'GET',retries:2}),/network down/);
  assert.equal(calls,3);
});

test('v1.4.14 S2 cancellation does not retry a source request',async t=>{
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});let calls=0;
  globalThis.fetch=async(_url,init)=>{calls+=1;return new Promise((_resolve,reject)=>{
    const signal=init?.signal;if(signal?.aborted){reject(signal.reason);return;}
    signal?.addEventListener('abort',()=>reject(signal.reason),{once:true});
  });};
  const controller=new AbortController(),broker=new RequestBroker();
  const pending=broker.request({sourceId:'cancel',url:'https://example.test/a',retries:3,signal:controller.signal});
  await delay(10);controller.abort(new DOMException('cancelled','AbortError'));
  await assert.rejects(()=>pending,/cancelled|abort/i);assert.equal(calls,1);
});

test('v1.4.14 S2 RuntimeManager single-flights init and serializes one mutable runtime',async()=>{
  let creates=0,active=0,maxActive=0;const destroyed=[];
  const manager=new RuntimeManager({maxExecutable:2,idleMs:50,isExecutable:()=>true,create:async cfg=>{creates+=1;await delay(20);return mockAdapter(cfg.configRevision,destroyed);}});
  const cfg=config('same','r1');await manager.reconcile([cfg]);
  await Promise.all([1,2,3].map(()=>manager.withRuntime(cfg,undefined,async()=>{
    active+=1;maxActive=Math.max(maxActive,active);await delay(15);active-=1;return true;
  })));
  assert.equal(creates,1);assert.equal(maxActive,1);assert.equal(manager.snapshot()[0]?.inFlightCount,0);
  await manager.destroy();
});

test('RuntimeManager caller can abort while shared initialization continues safely',async()=>{
  let creates=0;const destroyed=[];let releaseInit;
  const gate=new Promise(resolve=>{releaseInit=resolve;});
  const manager=new RuntimeManager({maxExecutable:2,idleMs:50,initWaitMs:500,isExecutable:()=>true,create:async cfg=>{creates+=1;await gate;return mockAdapter(cfg.configRevision,destroyed);}});
  const cfg=config('cancel-init','r1');await manager.reconcile([cfg]);const controller=new AbortController();
  const pending=manager.withRuntime(cfg,controller.signal,async()=>true);await delay(10);controller.abort(new DOMException('superseded','AbortError'));
  await assert.rejects(()=>pending,/superseded|abort/i);releaseInit();await delay(20);
  assert.equal(creates,1);assert.equal(manager.snapshot()[0]?.inFlightCount,0);
  await manager.destroy();
});

test('RuntimeManager bounds how long a caller waits for runtime initialization',async()=>{
  const destroyed=[];let releaseInit;const gate=new Promise(resolve=>{releaseInit=resolve;});
  const manager=new RuntimeManager({maxExecutable:2,idleMs:50,initWaitMs:25,isExecutable:()=>true,create:async cfg=>{await gate;return mockAdapter(cfg.configRevision,destroyed);}});
  const cfg=config('slow-init','r1');await manager.reconcile([cfg]);
  await assert.rejects(()=>manager.withRuntime(cfg,undefined,async()=>true),/RUNTIME_INIT_TIMEOUT/);
  releaseInit();await delay(20);await manager.destroy();
});

test('v1.4.14 S2 revision replacement keeps leased runtime until release and LRU never reclaims a lease',async()=>{
  let creates=0;const destroyed=[];
  const manager=new RuntimeManager({maxExecutable:2,idleMs:10,isExecutable:()=>true,create:async cfg=>{creates+=1;return mockAdapter(cfg.configRevision,destroyed);}});
  const first=config('lease','r1'),second=config('lease','r2');await manager.reconcile([first]);
  let oldLease='';await manager.withRuntime(first,undefined,async(_adapter,controls)=>{oldLease=controls.acquireLease();return true;});
  await manager.reconcile([second]);
  const old=manager.snapshot().find(item=>item.revision==='r1');assert.equal(old?.retiring,true);assert.equal(old?.playbackLeaseCount,1);
  let newLease='';await manager.withRuntime(second,undefined,async(_adapter,controls)=>{newLease=controls.acquireLease();return true;});
  assert.equal(creates,2);assert.equal(destroyed.includes('r1'),false);
  await manager.pruneIdle(Date.now()+10_000);assert.ok(manager.snapshot().some(item=>item.revision==='r2'));
  await manager.releaseLease(oldLease);assert.ok(destroyed.includes('r1'));
  await manager.releaseLease(newLease);await manager.pruneIdle(Date.now()+10_000);assert.ok(destroyed.includes('r2'));
  await manager.destroy();
});

test('v1.4.14 S2 capacity gate never evicts a just-created or active runtime',async()=>{
  let creates=0;const destroyed=[];
  const manager=new RuntimeManager({maxExecutable:1,idleMs:10,isExecutable:()=>true,create:async cfg=>{creates+=1;await delay(15);return mockAdapter(cfg.configRevision,destroyed);}});
  const a=config('a','r1'),b=config('b','r1');await manager.reconcile([a,b]);
  const first=manager.withRuntime(a,undefined,async()=>{await delay(60);return true;});
  await delay(5);
  await assert.rejects(()=>manager.withRuntime(b,undefined,async()=>true),/RUNTIME_CAPACITY_EXCEEDED/);
  await first;assert.equal(creates,1);assert.equal(destroyed.length,0);
  await manager.withRuntime(b,undefined,async()=>true);
  assert.equal(creates,2);assert.ok(destroyed.includes('r1'));
  await manager.destroy();
});

test('v1.4.14 S2 Drpy2 sync req carries its source callId for broker cancellation',async()=>{
  const code=await readFile(new URL('../../services/drpy2-worker/src/worker.ts',import.meta.url),'utf8');
  assert.match(code,/AsyncLocalStorage<string>/);
  assert.match(code,/callId:callStore\.getStore\(\)\?\?''/);
  const adapter=await readFile(new URL('../../services/source-engine/src/drpy2-adapter.ts',import.meta.url),'utf8');
  assert.match(adapter,/callPending=callId\?this\.#pending\.get\(callId\)/);
  assert.match(adapter,/callPending\?\.signal/);
});


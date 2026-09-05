import assert from 'node:assert/strict';
import test from 'node:test';
import {RequestBroker} from '../../packages/source-sdk/dist/index.js';

test('RequestBroker aborts chunked bodies when maxBytes is exceeded',async t=>{const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});globalThis.fetch=async()=>new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array([1,2,3]));controller.enqueue(new Uint8Array([4,5,6]));controller.close();}}),{status:200});const broker=new RequestBroker();const response=await broker.request({sourceId:'unit-limit',url:'https://config.example/test',maxBytes:4,retries:0});await assert.rejects(()=>response.arrayBuffer(),/safety limit/);});

test('config-import rejects declared responses above the default 8 MB cap',async t=>{const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});globalThis.fetch=async()=>new Response('x',{status:200,headers:{'content-length':String(8*1024*1024+1)}});const broker=new RequestBroker();await assert.rejects(()=>broker.request({sourceId:'config-import',url:'https://config.example/large',retries:0}),/safety limit/);});

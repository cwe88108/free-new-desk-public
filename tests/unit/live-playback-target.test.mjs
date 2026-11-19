import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveLivePlaybackTarget} from '../../apps/desktop/dist/main/live-playback-target.js';

test('live manifest handoff uses final CDN base and never restores credentials after crossing origins',async()=>{
  const calls=[],replies=[new Response(null,{status:302,headers:{Location:'http://cdn.example/a/master.m3u8?ticket=test'}}),new Response(null,{status:302,headers:{Location:'http://dispatch.example/edge/master.m3u8'}}),new Response('#EXTM3U')];
  const broker={request:async request=>{calls.push(request);return replies.shift();}};
  const headers={'User-Agent':'TV test',Authorization:'Bearer secret',Cookie:'private=1',Referer:'http://dispatch.example/'};
  const result=await resolveLivePlaybackTarget('http://dispatch.example/master.m3u8',headers,new AbortController().signal,broker);
  assert.equal(result.url,'http://dispatch.example/edge/master.m3u8');
  assert.equal(result.headers['user-agent'],'TV test');
  for(const key of ['authorization','cookie','referer']){assert.equal(result.headers[key],undefined);assert.equal(calls[1].headers[key],undefined);assert.equal(calls[2].headers[key],undefined);}
  assert.equal(headers.Authorization,'Bearer secret');
  assert.ok(calls.every(request=>request.redirect==='manual'&&request.retries===0));
});

test('live manifest redirects reject loops and non-HTTP targets; non-HLS inputs are untouched',async()=>{
  const signal=new AbortController().signal;
  let calls=0;
  await assert.rejects(resolveLivePlaybackTarget('http://example.test/a.m3u8',{},signal,{request:async()=>{calls++;return new Response(null,{status:302,headers:{Location:'/a.m3u8'}});}}),/limit/);
  assert.equal(calls,9);
  await assert.rejects(resolveLivePlaybackTarget('http://example.test/a.m3u8',{},signal,{request:async()=>new Response(null,{status:302,headers:{Location:'file:///secret'}})}),/protocol/);
  const unchanged=await resolveLivePlaybackTarget('rtsp://example.test/live',{},signal,{request:async()=>{throw Error('must not probe');}});
  assert.equal(unchanged.url,'rtsp://example.test/live');
});

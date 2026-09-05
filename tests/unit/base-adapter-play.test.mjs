import test from 'node:test';
import assert from 'node:assert/strict';
import { BaseAdapter } from '../../packages/source-adapters/dist/index.js';

class TestAdapter extends BaseAdapter{
  async getHome(){return{items:[]};}
  async getCategory(_categoryId,page){return{page,hasMore:false,items:[]};}
  async getDetail(ids){return{id:ids[0]??'',name:'test',episodes:[]};}
  async search(_keyword,page=1){return{page,items:[]};}
}

test('treats non-http media protocols as direct playback',async()=>{
  const adapter=new TestAdapter('https://source.example');
  assert.deepEqual(await adapter.getPlay('live','rtsp://stream.example/channel'),{url:'rtsp://stream.example/channel',parse:false});
  assert.deepEqual(await adapter.getPlay('live','udp://239.0.0.1:1234'),{url:'udp://239.0.0.1:1234',parse:false});
});

test('extracts pipe-suffixed playback headers from direct media URL',async()=>{
  const adapter=new TestAdapter('https://source.example');
  const result=await adapter.getPlay('line','https://stream.example/video.m3u8|User-Agent=TV%20Client&Referer=https%3A%2F%2Fref.example%2F');
  assert.equal(result.url,'https://stream.example/video.m3u8');
  assert.equal(result.parse,false);
  assert.deepEqual(result.headers,{'User-Agent':'TV Client',Referer:'https://ref.example/'});
});

test('routes generic HTTP pages through the parser path',async()=>{const adapter=new TestAdapter('https://source.example');assert.deepEqual(await adapter.getPlay('qq','https://v.qq.com/x/cover/demo.html'),{url:'https://v.qq.com/x/cover/demo.html',parse:true});});

test('keeps opaque episode ids on the parser path',async()=>{
  const adapter=new TestAdapter('https://source.example');
  assert.deepEqual(await adapter.getPlay('parse','opaque-episode-id'),{url:'opaque-episode-id',parse:true});
});

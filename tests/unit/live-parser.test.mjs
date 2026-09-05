import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLivePlaylist } from '../../packages/live-parser/dist/index.js';

test('parses m3u groups metadata and merges duplicate channel routes',()=>{
  const groups=parseLivePlaylist('#EXTM3U\n#EXTINF:-1 tvg-id="cctv1" group-title="央视",CCTV-1\nhttps://a.example/1.m3u8\n#EXTINF:-1 tvg-id="cctv1" group-title="央视",CCTV-1\nhttps://b.example/1.m3u8');
  const channel=groups[0].channels[0];
  assert.equal(groups[0].name,'央视');
  assert.equal(channel.tvgId,'cctv1');
  assert.deepEqual(channel.urls,['https://a.example/1.m3u8','https://b.example/1.m3u8']);
});

test('parses TVBox txt genre format with hash-separated routes',()=>{
  const groups=parseLivePlaylist('央视,#genre#\nCCTV-1,https://a.example/1.m3u8#https://b.example/1.m3u8');
  assert.equal(groups[0].channels[0].name,'CCTV-1');
  assert.equal(groups[0].channels[0].urls.length,2);
});

test('parses JSON channel urls array',()=>{
  const groups=parseLivePlaylist(JSON.stringify({channels:[{name:'News',group:'News',urls:['https://a.example/live','https://b.example/live']}]}));
  assert.equal(groups[0].channels[0].url,'https://a.example/live');
  assert.equal(groups[0].channels[0].urls.length,2);
});

test('preserves EXTVLCOPT user agent and referer headers',()=>{
  const groups=parseLivePlaylist('#EXTM3U\n#EXTINF:-1 group-title="测试",Channel\n#EXTVLCOPT:http-user-agent=Mozilla/5.0 Test\n#EXTVLCOPT:http-referrer=https://ref.example/\nhttps://stream.example/live.m3u8');
  assert.deepEqual(groups[0].channels[0].headers,{'User-Agent':'Mozilla/5.0 Test',Referer:'https://ref.example/'});
});

test('parses pipe-suffixed IPTV headers without polluting playback URL',()=>{
  const groups=parseLivePlaylist('测试,#genre#\nChannel,https://stream.example/live.m3u8|User-Agent=TV%20Client&Referer=https%3A%2F%2Fref.example%2F');
  const channel=groups[0].channels[0];
  assert.equal(channel.url,'https://stream.example/live.m3u8');
  assert.equal(channel.headers?.['User-Agent'],'TV Client');
  assert.equal(channel.headers?.Referer,'https://ref.example/');
});

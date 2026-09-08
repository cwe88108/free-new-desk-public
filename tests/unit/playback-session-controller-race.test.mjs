import test from 'node:test';
import assert from 'node:assert/strict';
import { PlaybackSessionController,PlaybackSupersededError } from '../../apps/desktop/dist/main/playback-session-controller.js';

function controller(){const events=[];return{events,controller:new PlaybackSessionController(snapshot=>events.push(snapshot))};}

test('A slow / B fast: once B begins A can no longer commit',()=>{
  const {controller:c}=controller();
  const a=c.begin('vod',{sourceId:'s',videoId:'v',episodeId:'a'});
  const b=c.begin('vod',{sourceId:'s',videoId:'v',episodeId:'b'});
  assert.throws(()=>c.patch(a.requestId,{status:'playing'}),PlaybackSupersededError);
  const current=c.playing(b.requestId,'load-b');
  assert.equal(current.requestId,b.requestId);
  assert.equal(current.loadId,'load-b');
  assert.equal(current.status,'playing');
});

test('A -> B -> C reverse completion: only C can mutate authoritative session',()=>{
  const {controller:c}=controller();
  const a=c.begin('vod',{episodeId:'a'}),b=c.begin('live',{channelId:'b'}),cc=c.begin('music',{trackId:'c'});
  assert.throws(()=>c.loading(b.requestId,'load-b'),PlaybackSupersededError);
  assert.throws(()=>c.loading(a.requestId,'load-a'),PlaybackSupersededError);
  c.loading(cc.requestId,'load-c');
  const current=c.playing(cc.requestId,'load-c');
  assert.equal(current.domain,'music');
  assert.equal(current.trackId,'c');
});

test('stop during load prevents stale load completion from becoming playing',()=>{
  const {controller:c}=controller();
  const request=c.begin('vod',{episodeId:'a'});c.loading(request.requestId,'load-a');c.end('stop');
  assert.equal(c.current().status,'stopped');
  assert.throws(()=>c.assertMutable(request.requestId),PlaybackSupersededError);
  assert.throws(()=>c.playing(request.requestId,'load-a'),PlaybackSupersededError);
  assert.throws(()=>c.playing('stale-request','load-a'),PlaybackSupersededError);
});

test('new domain supersedes old domain without cross-domain mutation',()=>{
  const {controller:c}=controller();
  const live=c.begin('live',{channelId:'news'});const music=c.begin('music',{trackId:'song'});
  assert.throws(()=>c.patch(live.requestId,{routeIndex:2}),PlaybackSupersededError);
  assert.equal(c.current().requestId,music.requestId);
  assert.equal(c.current().domain,'music');
});

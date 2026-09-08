import test from 'node:test';
import assert from 'node:assert/strict';
import {PlaybackSessionController,PlaybackSupersededError} from '../../apps/desktop/src/main/playback-session-controller.ts';

test('new playback intent supersedes the previous domain before publishing the new session',()=>{
  const events=[];const controller=new PlaybackSessionController(snapshot=>events.push(snapshot));
  const live=controller.begin('live',{sourceId:'live-source',channelId:'channel-1'},'user');
  controller.loading(live.requestId,'load-live');controller.playing(live.requestId,'load-live');
  const vod=controller.begin('vod',{sourceId:'vod-source',videoId:'video-1',episodeId:'ep-1'},'history');
  assert.equal(vod.domain,'vod');assert.ok(vod.generation>live.generation);assert.notEqual(vod.requestId,live.requestId);
  const superseded=events.find(event=>event.requestId===live.requestId&&event.status==='superseded');
  assert.ok(superseded);assert.equal(superseded.endReason,'replaced');
});

test('stale request cannot commit after a newer intent',()=>{
  const controller=new PlaybackSessionController(()=>{});const first=controller.begin('vod',{episodeId:'ep-1'},'user');controller.begin('live',{channelId:'news'},'user');
  assert.throws(()=>controller.playing(first.requestId,'stale-load'),PlaybackSupersededError);
  assert.equal(controller.current().domain,'live');assert.equal(controller.current().channelId,'news');
});

test('natural EOF and manual stop remain distinct authoritative end reasons',()=>{
  const controller=new PlaybackSessionController(()=>{});const music=controller.begin('music',{trackId:'track-1'},'user');controller.loading(music.requestId,'music-load');controller.playing(music.requestId,'music-load');
  const eof=controller.end('eof');assert.equal(eof.status,'ended');assert.equal(eof.endReason,'eof');
  const live=controller.begin('live',{channelId:'channel-2'},'user');controller.loading(live.requestId,'live-load');const stopped=controller.end('stop');assert.equal(stopped.status,'stopped');assert.equal(stopped.endReason,'stop');
});

test('pause only applies to the current request',()=>{
  const controller=new PlaybackSessionController(()=>{});const vod=controller.begin('vod',{},'user');controller.playing(vod.requestId,'load-1');assert.equal(controller.pause(vod.requestId,true)?.status,'paused');assert.equal(controller.pause(vod.requestId,false)?.status,'playing');
  controller.begin('music',{trackId:'next'},'user');assert.equal(controller.pause(vod.requestId,true),undefined);
});

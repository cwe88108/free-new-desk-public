import test from 'node:test';
import assert from 'node:assert/strict';
import { canUpdateVodHistory,validateVodAutoNext } from '../../apps/desktop/dist/main/playback-session-rules.js';

function vodSession(overrides={}){return{generation:7,sessionId:'s',requestId:'r',loadId:'l',domain:'vod',status:'ended',sourceId:'source-a',videoId:'video-a',episodeId:'ep-2',updatedAt:1,...overrides};}

test('VOD auto-next requires exact origin episode and a different target episode',()=>{
  const current=vodSession();
  assert.deepEqual(validateVodAutoNext(current,{sourceId:'source-a',videoId:'video-a',fromEpisodeId:'ep-2',episodeId:'ep-3'}),{ok:true});
  assert.equal(validateVodAutoNext(current,{sourceId:'source-a',videoId:'video-a',episodeId:'ep-3'}).reason,'origin-episode-mismatch');
  assert.equal(validateVodAutoNext(current,{sourceId:'source-a',videoId:'video-a',fromEpisodeId:'ep-1',episodeId:'ep-3'}).reason,'origin-episode-mismatch');
  assert.equal(validateVodAutoNext(current,{sourceId:'source-a',videoId:'video-a',fromEpisodeId:'ep-2',episodeId:'ep-2'}).reason,'target-episode-invalid');
});

test('VOD auto-next rejects a different source or video queue',()=>{
  const current=vodSession();
  assert.equal(validateVodAutoNext(current,{sourceId:'source-b',videoId:'video-a',fromEpisodeId:'ep-2',episodeId:'ep-3'}).reason,'queue-identity-mismatch');
  assert.equal(validateVodAutoNext(current,{sourceId:'source-a',videoId:'video-b',fromEpisodeId:'ep-2',episodeId:'ep-3'}).reason,'queue-identity-mismatch');
});

test('only the latest history row for the exact authoritative VOD episode can update progress',()=>{
  const current=vodSession({status:'playing'}),identity={sourceId:'source-a',videoId:'video-a',episodeId:'ep-2'};
  assert.equal(canUpdateVodHistory(current,identity,'history-new','history-new'),true);
  assert.equal(canUpdateVodHistory(current,identity,'history-new','history-old'),false);
  assert.equal(canUpdateVodHistory(current,{...identity,episodeId:'ep-1'},'history-new','history-new'),false);
  assert.equal(canUpdateVodHistory({...current,domain:'live'},identity,'history-new','history-new'),false);
});

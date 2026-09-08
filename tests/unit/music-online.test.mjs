import test from 'node:test';
import assert from 'node:assert/strict';
import { artworkSearchTerms,normalizeMusicMatch,sanitizeMusicMetadata,scoreMusicCandidate } from '../../apps/desktop/dist/main/music-online.js';

test('music metadata normalization ignores punctuation width and case',()=>{assert.equal(normalizeMusicMatch('Ａｒｔｉｓｔ - Song!'),'artistsong');});
test('metadata sanitizer removes download-site pollution without rewriting the real title',()=>{
  const polluted='[熊猫无损音乐 xmwsyy.com] 更多打包资源下载';
  assert.equal(sanitizeMusicMetadata(polluted),'');
  assert.equal(sanitizeMusicMetadata('Almost Lover'),'Almost Lover');
});
test('artwork searches do not send polluted album tags to providers',()=>{
  const terms=artworkSearchTerms({title:'almost lover',artist:'a fine frenzy',album:'[熊猫无损音乐 xmwsyy.com] 更多打包资源下载'});
  assert.deepEqual(terms,['a fine frenzy almost lover']);
});
test('same title by another artist must be rejected even with the same album',()=>{assert.equal(scoreMusicCandidate({title:'Song',artist:'Alice',album:'Hits'},{title:'Song',artist:'Bob',album:'Hits'}),0);});
test('live and studio versions cannot share lyrics automatically',()=>{assert.equal(scoreMusicCandidate({title:'Song',artist:'Alice',album:'Hits'},{title:'Song (live)',artist:'Alice',album:'Hits'}),0);});
test('exact title and artist outrank partial or unrelated metadata',()=>{const track={title:'Hello World',artist:'Alice',album:'First'};const exact=scoreMusicCandidate(track,{title:'Hello World',artist:'Alice',album:'First'}),partial=scoreMusicCandidate(track,{title:'Hello',artist:'Alice',album:'Other'}),wrong=scoreMusicCandidate(track,{title:'Different',artist:'Bob',album:'Other'});assert.ok(exact>partial);assert.ok(partial>wrong);assert.equal(exact,1);});

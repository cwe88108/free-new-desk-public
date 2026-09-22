import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMusicMatch,sanitizeMusicMetadata,scoreMusicCandidate } from '../../apps/desktop/dist/main/music-online.js';

test('music metadata normalization ignores punctuation width and case',()=>{assert.equal(normalizeMusicMatch('Ａｒｔｉｓｔ - Song!'),'artistsong');});
test('metadata sanitizer removes download-site pollution without rewriting the real title',()=>{
  const polluted='[熊猫无损音乐 xmwsyy.com] 更多打包资源下载';
  assert.equal(sanitizeMusicMetadata(polluted),'');
  assert.equal(sanitizeMusicMetadata('Almost Lover'),'Almost Lover');
});
test('polluted album tags do not prevent a strong title and artist match',()=>{
  const track={title:'Almost Lover',artist:'A Fine Frenzy',album:'[download-site.example] promo'};
  assert.ok(scoreMusicCandidate(track,{title:'Almost Lover',artist:'A Fine Frenzy',album:'One Cell in the Sea'})>=.8);
});
test('same title by another artist must be rejected even with the same album',()=>{assert.equal(scoreMusicCandidate({title:'Song',artist:'Alice',album:'Hits'},{title:'Song',artist:'Bob',album:'Hits'}),0);});
test('live and studio versions cannot share lyrics automatically',()=>{assert.equal(scoreMusicCandidate({title:'Song',artist:'Alice',album:'Hits'},{title:'Song (live)',artist:'Alice',album:'Hits'}),0);});
test('exact title and artist outrank partial or unrelated metadata',()=>{const track={title:'Hello World',artist:'Alice',album:'First'};const exact=scoreMusicCandidate(track,{title:'Hello World',artist:'Alice',album:'First'}),partial=scoreMusicCandidate(track,{title:'Hello',artist:'Alice',album:'First'}),wrong=scoreMusicCandidate(track,{title:'Different',artist:'Bob',album:'Other'});assert.ok(exact>partial);assert.ok(partial>wrong);assert.equal(exact,1);});

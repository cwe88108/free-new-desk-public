import test from 'node:test';
import assert from 'node:assert/strict';
import { sameMediaPath,mediaIdentity } from '../../apps/desktop/src/main/media-identity.ts';
import { parseLrc,activeLyricIndex } from '../../packages/contracts/src/music-lyrics.ts';
import { sanitizeMusicMetadata,scoreMusicCandidate } from '../../apps/desktop/src/main/music-online.ts';
import { smbShareRoot,SmbError } from '../../apps/desktop/src/main/smb-session-manager.ts';

test('Windows actual path equals file URL without decoding a literal percent twice',()=>{
  assert.equal(sameMediaPath(String.raw`C:\资源\100%20 #歌.flac`,'file:///C:/%E8%B5%84%E6%BA%90/100%2520%20%23%E6%AD%8C.flac'),true);
  assert.equal(sameMediaPath(String.raw`C:\music\a%20b.flac`,String.raw`C:\music\a b.flac`),false);
});
test('UNC and local segment aliases preserve exact resource identity',()=>{
  assert.equal(sameMediaPath(String.raw`\\NAS\Music\song.flac`,'file://NAS/Music/song.flac'),true);
  assert.equal(sameMediaPath(String.raw`C:\a.flac`,'file:///C:/a.flac#fnd-segment=20,40'),true);
  assert.equal(mediaIdentity(String.raw`\\?\C:\a.flac`),undefined);
});
test('HTTP resource case and signed query are not stripped',()=>{
  assert.equal(sameMediaPath('https://host/A?a=1','https://host/a?a=1'),false);
  assert.equal(sameMediaPath('https://host/a?sig=1','https://host/a?sig=2'),false);
});
test('LRC duplicate timestamps group bilingual lines and seek locates exact line',()=>{
  const rows=parseLrc('[offset:100]\n[00:01.00]Hello\n[00:01.00]你好\n[00:02.5][00:03.50]Again\n[00:99.0]invalid');
  assert.equal(rows.length,3);assert.equal(rows[0].text,'Hello\n你好');
  assert.equal(activeLyricIndex(rows,0),-1);assert.equal(activeLyricIndex(rows,2.6),1);assert.equal(activeLyricIndex(rows,1.1),0);
  assert.deepEqual(parseLrc('plain lyrics'),[]);
});
test('ad album tags are removed only from search, live/version and duration remain enforced',()=>{
  const track={title:'Almost Lover',artist:'A Fine Frenzy',album:'[熊猫无损音乐 xmwsyy.com] 更多打包资源下载',duration:268};
  assert.equal(sanitizeMusicMetadata(track.album),'');assert.ok(track.album.includes('熊猫'));
  assert.ok(scoreMusicCandidate(track,{title:'Almost Lover',artist:'A Fine Frenzy',album:'One Cell in the Sea',duration:268})>=.8);
  assert.equal(scoreMusicCandidate(track,{title:'Almost Lover (Live)',artist:track.artist,duration:268}),0);
  assert.equal(scoreMusicCandidate(track,{title:track.title,artist:track.artist,duration:310}),0);
});
test('SMB error semantics use numeric code, reject device paths, never localized stderr',()=>{
  assert.equal(smbShareRoot(String.raw`\\NAS\Music\中文`),String.raw`\\NAS\Music`);
  assert.equal(smbShareRoot(String.raw`\\?\C:\Music`),undefined);
  assert.match(new SmbError(1219).message,/SMB_CREDENTIAL_CONFLICT.*1219/);
  assert.match(new SmbError(1326).message,/SMB_LOGON_FAILED/);
});

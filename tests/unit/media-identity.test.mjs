import test from 'node:test';
import assert from 'node:assert/strict';
import { mediaIdentity,sameMediaPath } from '../../apps/desktop/dist/main/media-identity.js';

test('Windows drive path and file URL resolve to the same media',()=>{
  const path=String.raw`C:\Users\Public\Music\Artist - Sample.flac`;
  const url='file:///C:/Users/Public/Music/Artist%20-%20Sample.flac';
  assert.equal(mediaIdentity(path)?.startsWith('file:'),true);
  assert.equal(sameMediaPath(path,url),true);
});
test('Windows path comparison is slash and case insensitive',()=>{
  assert.equal(sameMediaPath(String.raw`C:\Music\Album\Track.FLAC`,'c:/music/album/track.flac'),true);
});
test('UNC paths normalize without being parsed as URLs',()=>{
  assert.equal(mediaIdentity(String.raw`\\NAS\Music\Track.flac`)?.startsWith('file:'),true);
  assert.equal(sameMediaPath(String.raw`\\NAS\Music\Track.flac`,String.raw`\\nas\music\track.FLAC`),true);
});
test('HTTP media preserves case and signed query identity',()=>{
  assert.equal(sameMediaPath('https://example.com/a.m3u8?token=1','https://example.com/a.m3u8?token=2'),false);
  assert.equal(sameMediaPath('https://example.com/A.m3u8','https://example.com/a.m3u8'),false);
});

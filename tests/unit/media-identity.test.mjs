import test from 'node:test';
import assert from 'node:assert/strict';
import { identifyMedia,sameMediaPath } from '../../apps/desktop/dist/main/media-identity.js';

test('Windows drive path and file URL resolve to the same media',()=>{
  const path='C:\\Users\\Public\\Music\\Artist - Sample.flac';
  const url='file:///C:/Users/Public/Music/Artist%20-%20Sample.flac';
  assert.equal(identifyMedia(path).kind,'local-file');
  assert.equal(sameMediaPath(path,url),true);
});

test('Windows path comparison is slash and case insensitive',()=>{
  assert.equal(sameMediaPath('C:\\Music\\Album\\Track.FLAC','c:/music/album/track.flac'),true);
});

test('UNC paths normalize without being parsed as URLs',()=>{
  assert.equal(identifyMedia('\\\\NAS\\Music\\Track.flac').kind,'unc-file');
  assert.equal(sameMediaPath('\\\\NAS\\Music\\Track.flac','\\\\nas\\music\\track.FLAC'),true);
});

test('HTTP media keeps URL identity and ignores fragments only',()=>{
  assert.equal(sameMediaPath('https://example.com/a.m3u8#one','https://example.com/a.m3u8#two'),true);
  assert.equal(sameMediaPath('https://example.com/a.m3u8?token=1','https://example.com/a.m3u8?token=2'),false);
});
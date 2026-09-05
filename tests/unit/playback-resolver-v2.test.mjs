import test from 'node:test';
import assert from 'node:assert/strict';
import { isClearlyNonMediaContentType,isLikelyMediaUrl,isMediaContentType,shouldRetryPlayerFailure } from '../../apps/desktop/dist/main/playback-resolver.js';

test('Playback Resolver recognizes direct media URLs and content types',()=>{assert.equal(isLikelyMediaUrl('https://cdn.example/video.m3u8?token=1'),true);assert.equal(isLikelyMediaUrl('https://v.qq.com/x/cover/abc.html'),false);assert.equal(isMediaContentType('video/mp4'),true);assert.equal(isMediaContentType('application/vnd.apple.mpegurl'),true);});
test('Playback Resolver rejects obvious page/json content as direct media',()=>{assert.equal(isClearlyNonMediaContentType('text/html; charset=utf-8'),true);assert.equal(isClearlyNonMediaContentType('application/json'),true);});
test('mpv -17 is eligible for one resolver fallback',()=>{assert.equal(shouldRetryPlayerFailure('mpv media open failed: unrecognized file format (mpv -17)'),true);assert.equal(shouldRetryPlayerFailure('network timeout'),false);});

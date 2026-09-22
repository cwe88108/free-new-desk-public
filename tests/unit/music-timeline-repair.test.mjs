import test from 'node:test';
import assert from 'node:assert/strict';
import {musicTrackPosition,musicTrackDuration,musicFilePosition,musicLyricPosition} from '../../packages/contracts/dist/music-timeline.js';
import {decodeMusicLyrics} from '../../apps/desktop/dist/main/music-lyrics-file.js';
import {scoreMusicCandidate} from '../../apps/desktop/dist/main/music-online.js';
test('CUE progress and file/track lyric origins are explicit',()=>{const cue={cueStart:120,cueEnd:180};assert.equal(musicTrackPosition(130,cue),10);assert.equal(musicTrackDuration(300,cue),60);assert.equal(musicFilePosition(10,cue),130);assert.equal(musicLyricPosition(130,cue,'track',.2),9.8);assert.equal(musicLyricPosition(130,cue,'file',.2),129.8);});
test('lyrics decode UTF8 and UTF16 BOM without corrupting Chinese',()=>{const text='[00:01.00]沿着晚风';assert.equal(decodeMusicLyrics(Buffer.from(text)),text);assert.equal(decodeMusicLyrics(Buffer.concat([Buffer.from([255,254]),Buffer.from(text,'utf16le')])),text);});
test('same song and singer on an incompatible album cannot override local identity',()=>{assert.equal(scoreMusicCandidate({title:'song',artist:'singer',album:'original'},{title:'song',artist:'singer',album:'live collection'}),0);});

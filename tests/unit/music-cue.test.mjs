import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { parseCueSheet } from '../../apps/desktop/dist/main/music-cue.js';

test('CUE single-file tracks get bounded segments except last track',()=>{
  const root=path.resolve('C:/Music');
  const cue=path.join(root,'Album','disc.cue');
  const text=`PERFORMER "Artist"\nTITLE "Album"\nFILE "disc.flac" WAVE\n  TRACK 01 AUDIO\n    TITLE "One"\n    INDEX 01 00:00:00\n  TRACK 02 AUDIO\n    TITLE "Two"\n    INDEX 01 03:10:37\n  TRACK 03 AUDIO\n    TITLE "Three"\n    INDEX 01 07:20:00\n`;
  const tracks=parseCueSheet(text,cue,root);
  assert.equal(tracks.length,3);
  assert.equal(tracks[0].title,'One');
  assert.equal(tracks[0].performer,'Artist');
  assert.equal(tracks[0].album,'Album');
  assert.equal(tracks[0].start,0);
  assert.ok(Math.abs((tracks[0].end??0)-(3*60+10+37/75))<1e-9);
  assert.ok(Math.abs((tracks[1].end??0)-(7*60+20))<1e-9);
  assert.equal(tracks[2].end,undefined);
});

test('CUE multi-file does not use next file start as previous file end',()=>{
  const root=path.resolve('C:/Music');
  const cue=path.join(root,'Album','multi.cue');
  const text=`TITLE "Album"\nFILE "one.flac" WAVE\n TRACK 01 AUDIO\n TITLE "One"\n INDEX 01 00:00:00\nFILE "two.flac" WAVE\n TRACK 02 AUDIO\n TITLE "Two"\n INDEX 01 00:00:00\n TRACK 03 AUDIO\n TITLE "Three"\n INDEX 01 04:00:00\n`;
  const tracks=parseCueSheet(text,cue,root);
  assert.equal(tracks.length,3);
  assert.equal(tracks[0].end,undefined);
  assert.equal(tracks[1].end,240);
  assert.equal(tracks[2].end,undefined);
});

test('CUE references escaping the library root are rejected',()=>{
  const root=path.resolve('C:/Music');
  const cue=path.join(root,'Album','bad.cue');
  const tracks=parseCueSheet('FILE "../../secret.flac" WAVE\nTRACK 01 AUDIO\nINDEX 01 00:00:00',cue,root);
  assert.deepEqual(tracks,[]);
});

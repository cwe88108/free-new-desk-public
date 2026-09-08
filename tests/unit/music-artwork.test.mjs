import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { localArtworkCandidates } from '../../apps/desktop/dist/main/music-artwork.js';

test('local artwork prefers same-name image before album and default cover names',()=>{
  const audio=path.join('C:\\Music','A Fine Frenzy','Almost Lover.flac');
  const rows=localArtworkCandidates(audio,{album:'One Cell in the Sea',title:'Almost Lover'});
  assert.ok(rows[0].endsWith('Almost Lover.jpg'));
  assert.ok(rows.findIndex(v=>v.endsWith('One Cell in the Sea.jpg'))>0);
  assert.ok(rows.findIndex(v=>v.endsWith('cover.jpg'))>rows.findIndex(v=>v.endsWith('One Cell in the Sea.jpg')));
});
test('unsafe album names cannot escape the audio directory',()=>{
  const rows=localArtworkCandidates(path.join('C:\\Music','Song.flac'),{album:'..\\other',title:'Song'});
  assert.equal(rows.some(v=>v.includes('..\\other')),false);
});

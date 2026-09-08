import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const read=path=>readFileSync(new URL(`../../${path}`,import.meta.url),'utf8');

test('V1.4.11 authoritative playback IPC is wired before route/media side effects',()=>{
  const source=read('apps/desktop/src/main/playback-session-ipc.ts');
  assert.match(source,/playback:beginIntent/);
  assert.match(source,/playback:failIntent/);
  assert.match(source,/playback:recordRoute/);
  assert.match(source,/channel==='live:play'/);
  assert.match(source,/channel==='playback:play'/);
  assert.match(source,/channel==='music:play'/);
  assert.match(source,/!isPlayerRuntimeCurrent\(intent.requestId,intent.domain\)/);
  assert.match(source,/\[PLAYBACK_SUPERSEDED\]/);
});

test('VOD/music natural EOF is consumed in the main process and history writes are identity-gated',()=>{
  const source=read('apps/desktop/src/main/playback-session-ipc.ts');
  assert.match(source,/consumeNaturalEndForAutoNext\('vod'/);
  assert.match(source,/consumeNaturalEndForAutoNext\('music'/);
  assert.match(source,/naturalEndClaims/);
  assert.match(source,/validateVodAutoNext/);
  assert.match(source,/DataService\.prototype\.updateHistoryProgress/);
  assert.match(source,/history-session-identity-mismatch/);
});

test('first-frame sampling cannot use dimensions from the previous media path',()=>{
  const source=read('apps/desktop/src/main/playback-session-ipc.ts');
  assert.match(source,/mediaExpectations/);
  assert.match(source,/sameMediaPath/);
  assert.match(source,/out\.width=0;out\.height=0/);
  assert.match(read('apps/desktop/src/main/index.ts'),/videoMetadataReadyMs/);
});

test('local music scan retains an offline library, supports cancellation and deduplicates roots',()=>{
  const source=read('apps/desktop/src/main/music-service.ts');
  assert.match(source,/scanControllers/);
  assert.match(source,/music:cancelScan/);
  assert.match(source,/保留上次扫描结果/);
  assert.match(source,/pathKey\(item\.root\)===pathKey\(root\)/);
  assert.match(source,/incrementalReuse:true/);
});

test('packaging keeps the supplied icon artwork instead of procedurally redrawing it',()=>{
  const script=read('scripts/materialize-app-icons.mjs');
  assert.doesNotMatch(script,/drawIcon|roundedRectDistance|segmentDistance/);
  assert.match(script,/readFile\(pngPath\)/);
  const png=readFileSync(new URL('../../assets/app-icon.png',import.meta.url));
  assert.deepEqual([...png.subarray(0,8)],[137,80,78,71,13,10,26,10]);
  assert.ok(png.readUInt32BE(16)>=128&&png.readUInt32BE(20)>=128);
});

test('PlayerHost excludes the data URL fullscreen overlay when choosing its parent window',()=>{
  assert.match(read('apps/desktop/src/main/player-client.ts'),/webContents\.getURL\(\)\.startsWith\('file:\/\/'\)/);
});

test('fullscreen transport actions are delivered to one active application window',()=>{
  const overlay=read('apps/desktop/src/main/fullscreen-overlay.ts');
  assert.match(overlay,/const target=activeAppWindow\(\)/);
  assert.doesNotMatch(overlay,/for\(const window of appWindows\(\)\).*fullscreen-overlay:renderer-action/);
});

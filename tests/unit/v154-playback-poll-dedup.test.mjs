import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {parse} from '@vue/compiler-sfc';

const app=await readFile(new URL('../../apps/desktop/src/renderer/App.vue',import.meta.url),'utf8');
const home=await readFile(new URL('../../apps/desktop/src/renderer/views/HomeShellView.vue',import.meta.url),'utf8');
const player=await readFile(new URL('../../apps/desktop/src/renderer/views/PlayerView.vue',import.meta.url),'utf8');
const clock=await readFile(new URL('../../apps/desktop/src/renderer/stores/playback-clock.ts',import.meta.url),'utf8');
const music=await readFile(new URL('../../apps/desktop/src/renderer/stores/music-playback.ts',import.meta.url),'utf8');
const root=JSON.parse(await readFile(new URL('../../package.json',import.meta.url),'utf8'));
const desktop=JSON.parse(await readFile(new URL('../../apps/desktop/package.json',import.meta.url),'utf8'));
const lock=JSON.parse(await readFile(new URL('../../package-lock.json',import.meta.url),'utf8'));

test('app shell and home mini-player consume the shared clock instead of polling PlayerHost stats',()=>{
  for(const [name,source] of [['App.vue',app],['HomeShellView.vue',home]]){
    assert.equal(parse(source).errors.length,0,name+' SFC parses');
    assert.match(source,/clockStats/);
    assert.match(source,/refreshPlaybackClock/);
    if(name==='App.vue'){
      assert.match(source,/const version=ref\(''\)/);
      assert.match(source,/version\.value=info\.version/);
    }
    assert.doesNotMatch(source,/playback\.query\(['"]stats['"]\)/);
  }
  assert.doesNotMatch(app,/playerPoll|setInterval\(refreshPlayer/);
  assert.doesNotMatch(home,/setInterval\(refresh,\s*1500\)|let poll:/);
});

test('PlayerView reuses shared stats and load status while preserving session identity checks',()=>{
  assert.equal(parse(player).errors.length,0);
  assert.match(player,/clockStats/);
  assert.match(player,/clockLoadStatus/);
  assert.match(player,/clockRuntime/);
  assert.match(player,/refreshPlaybackClock\(\)/);
  const refreshBody=player.slice(player.indexOf('async function refresh(){'),player.indexOf('async function command('));
  const commandBody=player.slice(player.indexOf('async function command('),player.indexOf('const removeAfterNavigation'));
  assert.doesNotMatch(refreshBody,/refreshPlaybackClock/);
  assert.match(commandBody,/refreshPlaybackClock/);
  assert.doesNotMatch(player,/playback\.query\(['"]stats['"]\)/);
  assert.doesNotMatch(player,/playback\.query\(['"]load-status['"]\)/);
  assert.match(player,/nextStats\.requestId!==runtimeSession\.value\.requestId/);
  assert.match(player,/nextStats\.loadId!==runtimeSession\.value\.loadId/);
  assert.match(player,/clockStale\.value\?null:clockStats\.value/);
});

test('one shared playback clock owns the periodic stats/load/runtime polling',()=>{
  assert.equal((clock.match(/setInterval\(/g)??[]).length,1);
  assert.match(clock,/window\.desktop\.playback\.query\('stats'\)/);
  assert.match(clock,/window\.desktop\.playback\.query\('load-status'\)/);
  assert.match(clock,/window\.desktop\.playback\.runtimeSession\(\)/);
  assert.match(clock,/if\(inFlight\)return inFlight/);
});

test('music auto-advance consumes the shared clock instead of issuing a second poll',()=>{
  assert.match(music,/clockRuntime\.value/);
  assert.match(music,/clockLoadStatus\.value/);
  assert.doesNotMatch(music,/await refreshPlaybackClock/);
});

test('root, desktop and lockfile versions remain aligned',()=>{
  assert.match(root.version,/^\d+\.\d+\.\d+$/);
  assert.equal(desktop.version,root.version);
  assert.equal(lock.version,root.version);
  assert.equal(lock.packages[''].version,root.version);
  assert.equal(lock.packages['apps/desktop'].version,root.version);
});

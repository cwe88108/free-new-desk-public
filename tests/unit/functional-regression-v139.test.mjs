import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read=(path)=>readFile(new URL('../../'+path,import.meta.url),'utf8');

test('application lifecycle has single-instance, tray, crash, power and health guards',async()=>{
  const source=await read('apps/desktop/src/main/index.ts');
  for(const token of ['requestSingleInstanceLock','second-instance','new Tray','uncaughtException','unhandledRejection','render-process-gone','powerMonitor.on(\'suspend\'','powerMonitor.on(\'resume\'','source engine heartbeat','lifecycle.cleanExit']){
    assert.ok(source.includes(token),`missing lifecycle guard: ${token}`);
  }
});

test('remote configs require an explicit persistent host trust decision',async()=>{
  const source=await read('apps/desktop/src/main/index.ts');
  assert.match(source,/security\.allowedConfigHosts/);
  assert.match(source,/确认远程配置来源/);
  assert.match(source,/信任并导入/);
});

test('managed playlist and cache namespace paths use isolated traversal guards',async()=>{
  const source=await read('apps/desktop/src/main/path-safety.ts');
  const main=await read('apps/desktop/src/main/index.ts');
  assert.match(source,/Invalid managed playlist identifier/);
  assert.match(source,/Managed playlist path escaped its root/);
  assert.match(source,/Invalid cache namespace/);
  assert.match(source,/path\.resolve/);
  assert.match(main,/safeManagedPlaylistPath/);
  assert.match(main,/safeCacheNamespacePath/);
});

test('player contract is 0-100 and supports runtime hardware decode switching',async()=>{
  const contracts=await read('packages/contracts/src/index.ts');
  const native=await read('native/player-host/src/main.cpp');
  const view=await read('apps/desktop/src/renderer/views/PlayerView.vue');
  assert.match(contracts,/literal\('volume'\).*max\(100\)/);
  assert.match(contracts,/literal\('hwdec'\)/);
  assert.match(native,/command == "hwdec"/);
  assert.match(view,/max="100"/);
  assert.match(view,/播放失败/);
  assert.match(view,/>重试</);
});

test('renderer shell locks only the route being activated and exposes accessible state',async()=>{
  const app=await read('apps/desktop/src/renderer/App.vue');
  const homeShell=await read('apps/desktop/src/renderer/views/HomeShellView.vue');
  assert.match(app,/const navigatingPath=ref\(''\)/);
  assert.match(app,/:disabled="navigatingPath===item\.path"/);
  assert.match(app,/:aria-busy="navigatingPath===item\.path"/);
  assert.match(homeShell,/aria-expanded="miniExpanded"/);
  assert.match(homeShell,/ui\.miniPlayerExpanded/);
  assert.match(app,/aria-label="扩展菜单"/);
  assert.match(app,/onHealthChanged/);
  assert.match(app,/role="status" aria-live="polite"/);
});

test('search and media images have bounded inputs and meaningful alternatives',async()=>{
  const search=await read('apps/desktop/src/renderer/views/SearchView.vue');
  const vod=await read('apps/desktop/src/renderer/views/VodView.vue');
  const live=await read('apps/desktop/src/renderer/views/LiveView.vue');
  assert.match(search,/autofocus maxlength="100"/);
  assert.match(vod,/maxlength="100"/);
  assert.match(live,/maxlength="100"/);
  assert.doesNotMatch(search,/alt=""/);
  assert.doesNotMatch(vod,/alt=""/);
  assert.doesNotMatch(live,/alt=""/);
});

test('batch 2 closes VOD, live, search, favorites and accessibility gaps',async()=>{
  const app=await read('apps/desktop/src/renderer/App.vue');
  const vod=await read('apps/desktop/src/renderer/views/VodView.vue');
  const live=await read('apps/desktop/src/renderer/views/LiveView.vue');
  const search=await read('apps/desktop/src/renderer/views/SearchView.vue');
  const favorites=await read('apps/desktop/src/renderer/views/FavoritesView.vue');
  const settings=await read('apps/desktop/src/renderer/views/SettingsView.vue');
  const styles=await read('apps/desktop/src/renderer/styles.css');
  const main=await read('apps/desktop/src/main/index.ts');
  assert.match(app,/fnd:render-mode/);
  assert.match(vod,/filter-drawer/);assert.match(vod,/closeTransient/);assert.match(vod,/vod-context-menu/);assert.match(vod,/新窗口打开/);
  assert.match(live,/setTimeout\(\(\)=>\{channelQuery\.value=channelInput\.value;.*\},200\)/s);assert.match(live,/virtualChannels/);assert.match(live,/创建节目预约/);assert.match(live,/自定义排序/);
  assert.match(search,/useRoute/);assert.match(search,/listVodFavorites/);assert.match(search,/visibleLiveMatches/);
  assert.match(favorites,/saveFavorite/);assert.match(favorites,/removeFavorite/);assert.match(favorites,/来源不可用/);
  assert.match(settings,/reservationConflicts/);
  assert.match(styles,/forced-colors:active/);assert.match(styles,/:focus-visible/);
  assert.match(main,/30_000\);const abort/);assert.match(main,/app:newWindow/);assert.match(main,/live:saveFavorite/);
});

test('batch 3 closes audit, progress, update metadata and font-scale gaps without nested IPC handlers',async()=>{
  const home=await read('apps/desktop/src/renderer/views/HomeView.vue');
  const sourceEngine=await read('services/source-engine/src/index.ts');
  const data=await read('services/data-service/src/index.ts');
  const settings=await read('apps/desktop/src/renderer/views/SettingsView.vue');
  const main=await read('apps/desktop/src/main/index.ts');
  const styles=await read('apps/desktop/src/renderer/styles.css');
  assert.match(home,/class="home-dashboard"/);
  assert.match(home,/class="panel continue-watch"/);
  assert.match(home,/class="panel decode-card"/);
  assert.match(home,/window\.desktop\.playback\.play/);
  assert.match(home,/publishedAt/);
  assert.match(home,/checkingUpdate/);
  assert.match(sourceEngine,/#auditPending/);
  for(const stage of ["'home'","'category'","'search'","'detail'","'play'"])assert.ok(sourceEngine.includes(stage));
  assert.match(data,/updateHistoryProgress/);
  assert.match(settings,/ui\.fontScale/);
  assert.match(settings,/showAllReservations/);
  assert.match(styles,/--font-scale/);
  assert.match(main,/publishedAt/);
  assert.equal((main.match(/ipcMain\.handle\('app:newWindow'/g)??[]).length,1);
  assert.equal((main.match(/ipcMain\.handle\('live:saveFavorite'/g)??[]).length,1);
  assert.equal((main.match(/ipcMain\.handle\('live:removeFavorite'/g)??[]).length,1);
});

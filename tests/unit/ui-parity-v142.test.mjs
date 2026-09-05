import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read=(path)=>readFile(new URL('../../'+path,import.meta.url),'utf8');

test('player error card exposes stable resolver error codes, route switching and diagnostics entry',async()=>{
  const main=await read('apps/desktop/src/main/index.ts');
  const resolver=await read('apps/desktop/src/main/playback-resolver.ts');
  const sniffing=await read('apps/desktop/src/main/sniffing-service.ts');
  const view=await read('apps/desktop/src/renderer/views/PlayerView.vue');
  for(const code of ['[P1000]','[P1001]','[PLAY_MEDIA_OPEN_FAILED]'])assert.ok(main.includes(code),`missing stable code ${code} in main`);
  for(const code of ['[PLAY_DIRECT_INVALID]','[PLAY_PARSER_FAILED]'])assert.ok(resolver.includes(code),`missing resolver code ${code}`);
  assert.ok(sniffing.includes('[PLAY_SNIFF_TIMEOUT]'),'missing sniff timeout code');
  for(const token of ['错误码','切换线路','打开诊断','switchRoute','openDiagnostics','playbackCodeOf'])assert.ok(view.includes(token),`missing ${token} in player view`);
});

test('settings page exposes playback/network controls backed by real settings keys',async()=>{
  const view=await read('apps/desktop/src/renderer/views/SettingsView.vue');
  const main=await read('apps/desktop/src/main/index.ts');
  for(const key of ['player.autoNext','live.autoFallback','network.proxyMode','network.timeoutSeconds','player.volume'])assert.ok(view.includes(key),`missing settings key ${key}`);
  for(const token of ['runSelfTest','清理全部缓存','复制详情','section===\'diagnostics\''])assert.ok(view.includes(token),`missing ${token}`);
  assert.ok(main.includes('diagnostics:selfTestItem'),'missing self-test IPC');
  assert.ok(main.includes('networkTimeoutMs'),'missing configurable network timeout');
  assert.ok(main.includes("'network.proxyMode')==='direct'"),'missing proxy mode switch');
  assert.ok(main.includes('window.bounds')&&main.includes('getNormalBounds'),'missing window bounds persistence');
});

test('sources page supports editing, batch health check and named delete confirmation with cascade counts',async()=>{
  const view=await read('apps/desktop/src/renderer/views/SourcesView.vue');
  for(const token of ['openEdit','saveEdit','openEditLive','saveEditLive','runBulkHealth','requestRemove','requestRemoveLive','deleteReady','cascade-list','仅显示异常来源','编辑点播来源','编辑直播来源'])assert.ok(view.includes(token),`missing ${token}`);
});

test('sources page manages imported groups and exposes per-source compatibility results',async()=>{
  const view=await read('apps/desktop/src/renderer/views/SourcesView.vue');
  const main=await read('apps/desktop/src/main/index.ts');
  const preload=await read('apps/desktop/src/preload/index.cts');
  for(const token of ['importGroups','一键删除源','重新检查全部','逐来源兼容性明细','compatibilityRows','compatibilityFilter','兼容','不兼容','compatibilityStage','retryable','requestRemoveGroup'])assert.ok(view.includes(token),`missing ${token}`);
  for(const token of ["source:removeImportGroup","source:checkImportGroup",'checkImportCompatibility','importGroupId'])assert.ok(main.includes(token),`missing ${token} in main process`);
  for(const token of ['removeImportGroup','checkImportGroup'])assert.ok(preload.includes(token),`missing ${token} in preload`);
});

test('search page completes the concept interaction set while keeping failures out of results',async()=>{
  const view=await read('apps/desktop/src/renderer/views/SearchView.vue');
  for(const token of ['clearInput','removeHistoryItem','highlightName','visibleGroupItems','搜索状态','<mark>'])assert.ok(view.includes(token),`missing ${token}`);
  assert.ok(view.includes('Failed and timed-out sources are intentionally omitted'),'search must explicitly omit failed and timed-out sources');
  assert.doesNotMatch(view,/retrySource|search-failures|失败来源重试区/,'failed-source retry UI must not return');
});

test('favorites and history pages expose the missing management controls',async()=>{
  const favorites=await read('apps/desktop/src/renderer/views/FavoritesView.vue');
  const history=await read('apps/desktop/src/renderer/views/HistoryView.vue');
  for(const token of ['sourceFilter','setViewMode','checkSources'])assert.ok(favorites.includes(token),`missing ${token} in favorites`);
  for(const token of ['playFromStart','openDetail','cleanCorrupted'])assert.ok(history.includes(token),`missing ${token} in history`);
});

test('live page exposes EPG timezone picker, subtitle track and switch reasons',async()=>{
  const view=await read('apps/desktop/src/renderer/views/LiveView.vue');
  const main=await read('apps/desktop/src/main/index.ts');
  for(const token of ['epgTimeZone','timeZoneOptions','selectSubtitleTrack','switchReasons'])assert.ok(view.includes(token),`missing ${token} in live view`);
  assert.ok(main.includes('attempts'),'live playback result must carry switch attempt reasons');
});

test('vod and live pages persist source sessions and use explicit cached refresh controls',async()=>{
  const vod=await read('apps/desktop/src/renderer/views/VodView.vue');
  const live=await read('apps/desktop/src/renderer/views/LiveView.vue');
  const main=await read('apps/desktop/src/main/index.ts');
  for(const token of ['vod.sourceId','vod.session.','loadSource','刷新来源','加载下一页','changeSort'])assert.ok(vod.includes(token),`missing ${token} in vod view`);
  for(const token of ['live.sourceId','live.session.','changeLiveSource','刷新播放列表','live-source-switcher'])assert.ok(live.includes(token),`missing ${token} in live view`);
  for(const token of ['vod-data','live-playlists','cachedJson','force'])assert.ok(main.includes(token),`missing ${token} in main cache layer`);
});

test('renderer shell wires Ctrl+F search focus and hides devtools in packaged builds',async()=>{
  const app=await read('apps/desktop/src/renderer/App.vue');
  const main=await read('apps/desktop/src/main/index.ts');
  assert.ok(app.includes('event.ctrlKey||event.metaKey'),'missing Ctrl+F handler');
  assert.ok(app.includes('[data-search-input]'),'missing search focus target');
  assert.ok(app.includes('v-if="!isPackaged"'),'devtools must be hidden in packaged builds');
  assert.ok(main.includes('packaged:app.isPackaged'),'getInfo must expose packaged flag');
});

test('vod page persists view preference and highlights the playing episode',async()=>{
  const view=await read('apps/desktop/src/renderer/views/VodView.vue');
  for(const token of ['vod.viewMode','vod.nowPlaying','now-playing'])assert.ok(view.includes(token),`missing ${token}`);
  assert.ok(view.includes('if(!value)return;'),'empty keyword search must not execute');
});

test('home page deep-links update settings, unhealthy sources and reservation badge',async()=>{
  const home=await read('apps/desktop/src/renderer/views/HomeView.vue');
  for(const token of ['to="/settings?section=update"','reservation-badge',"'"+'/sources?filter=unhealthy'+"'"])assert.ok(home.includes(token),`missing ${token}`);
});

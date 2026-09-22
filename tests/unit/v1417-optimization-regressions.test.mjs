import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const root=new URL('../../',import.meta.url);
const text=relative=>readFile(new URL(relative,root),'utf8');

test('v1.4.17 playback resolver propagates cancellation and validates sniff candidates',async()=>{
  const [resolver,sniff]=await Promise.all([text('apps/desktop/src/main/playback-resolver.ts'),text('apps/desktop/src/main/sniffing-service.ts')]);
  assert.match(resolver,/signal\?:AbortSignal/);
  assert.match(resolver,/sniffing\.resolve\([^;]+input\.signal/);
  assert.match(resolver,/#probe\([^;]+input\.signal/);
  assert.match(resolver,/PLAY_SNIFF_HTTP_REJECTED/);
  assert.match(resolver,/PLAY_SNIFF_NON_MEDIA_RESPONSE/);
  assert.doesNotMatch(resolver,/if\(!input\.forceSniff&&isLikelyMediaUrl\(url\)\)return/);
  assert.match(sniff,/onBeforeSendHeaders\(REQUEST_FILTER,null\)/);
  assert.match(sniff,/onHeadersReceived\(REQUEST_FILTER,null\)/);
});

test('v1.4.17 PlayerHost timeout isolation and bounded stats cache are explicit',async()=>{
  const client=await text('apps/desktop/src/main/player-client.ts');
  assert.match(client,/PlayerTransportTimeoutError/);
  assert.match(client,/#transportFaultStreak<3/);
  assert.match(client,/\[PLAYER_\$\{kind\}_TIMEOUT\]/);
  assert.match(client,/STATS_SOFT_STALE_MS=3_000/);
  assert.match(client,/sampleAgeMs/);
  assert.match(client,/seekRejectedCount/);
});
test('v1.4.17 failed VOD intent expires and route switching never falls back to first episode',async()=>{
  const [vod,player]=await Promise.all([text('apps/desktop/src/renderer/views/VodView.vue'),text('apps/desktop/src/renderer/views/PlayerView.vue')]);
  assert.match(vod,/requestId:string;createdAt:number/);
  assert.match(vod,/crypto\.randomUUID\(\)/);
  assert.match(player,/6\*60\*60\*1000/);
  assert.match(player,/source\.list\(\).*item\.id===value\.request\.sourceId&&item\.enabled/);
  assert.match(player,/matchEpisodeForFlag/);
  assert.doesNotMatch(player,/find\(item=>item\.flag===flag\)\?\?activeEpisodes/);
  assert.match(player,/无法可靠匹配其他线路中的同一集/);
});

test('v1.4.17 search cancellation and per-source outcomes are user-visible',async()=>{
  const [view,main]=await Promise.all([text('apps/desktop/src/renderer/views/SearchView.vue'),text('apps/desktop/src/main/index.ts')]);
  assert.match(view,/cancelAggregateSearch/);
  assert.match(view,/failedOutcomes/);
  assert.match(view,/空结果/);
  assert.match(main,/AggregateSearchStatus='success'\|'empty'\|'failed'\|'timeout'\|'canceled'/);
  assert.match(main,/rank\(a\.id\)-rank\(b\.id\)\|\|latency\(a\.id\)-latency\(b\.id\)/);
});

test('v1.4.17 native surface sync coalesces geometry and restores final fullscreen position',async()=>{
  const surface=await text('apps/desktop/src/renderer/native-surface.ts');
  assert.match(surface,/PendingSync/);
  assert.match(surface,/coalescedSync/);
  assert.match(surface,/lastSentKey/);
  assert.match(surface,/sendSync\(state,state\.lastBounds!,true,true\)/);
});
test('v1.4.17 settings and source CRUD expose failure feedback instead of fake success',async()=>{
  const [settings,sources]=await Promise.all([text('apps/desktop/src/renderer/views/SettingsView.vue'),text('apps/desktop/src/renderer/views/SourcesView.vue')]);
  assert.match(settings,/writeSetting/);
  assert.match(settings,/部分设置保存失败/);
  assert.match(settings,/设置存储未确认写入/);
  assert.match(sources,/来源排序未确认保存/);
  assert.match(sources,/切换「\$\{source\.name\}」失败/);
  assert.match(sources,/删除未确认/);
  assert.match(sources,/sourceStateBanner/);
});

test('v1.4.17 NAS scan recovery distinguishes retry wait credentials and interrupted states',async()=>{
  const [music,contracts]=await Promise.all([text('apps/desktop/src/main/music-service.ts'),text('packages/contracts/src/index.ts')]);
  assert.match(contracts,/retry_wait/);
  assert.match(music,/withTransientRetry/);
  assert.match(music,/awaiting_credentials/);
  assert.match(music,/NAS 暂时不可用；已保存 checkpoint/);
  assert.match(music,/网络暂时不可用；已保存 checkpoint/);
});

test('v1.4.17 real history model and music mini-player replace fake controls',async()=>{
  const [history,home]=await Promise.all([text('apps/desktop/src/renderer/views/HistoryView.vue'),text('apps/desktop/src/renderer/views/HomeShellView.vue')]);
  assert.doesNotMatch(history,/button disabled title=.*直播播放记录/);
  assert.match(history,/点播历史/);
  assert.match(home,/adjacentMusicId/);
  assert.match(home,/runtime\?\.domain==='music'/);
  assert.match(home,/hasMusicAdjacent/);
});

test('v1.4.17 saved VOD queue survives re-entry and clear writes the same store',async()=>{
  const player=await text('apps/desktop/src/renderer/views/PlayerView.vue');
  assert.match(player,/queuePersisted/);
  assert.match(player,/settings\.set\('player\.savedQueue',JSON\.stringify\(queue\.value\)\)/);
  assert.match(player,/settings\.set\('player\.savedQueue','\[\]'\)/);
  assert.match(player,/queue\.value=queuePersisted\.value\?saved:recent/);
});

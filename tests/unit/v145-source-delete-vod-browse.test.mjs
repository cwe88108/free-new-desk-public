import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read=(path)=>readFile(new URL('../../'+path,import.meta.url),'utf8');

test('import-group one-click delete reaches IPC after a single explicit confirmation',async()=>{
  const sources=await read('apps/desktop/src/renderer/views/SourcesView.vue');
  assert.match(sources,/const groupDeleteBusy=ref\(new Set<string>\(\)\)/);
  assert.match(sources,/async function requestRemoveGroup\(group:ImportGroup\)/);
  assert.match(sources,/window\.confirm\(`确认一键删除导入源/);
  assert.match(sources,/async function deleteImportGroup\(group:ImportGroup\)/);
  assert.match(sources,/window\.desktop\.source\.removeImportGroup\(group\.id\)/);
  assert.match(sources,/groupDeleteBusy\.has\(group\.id\)\?'删除中…':'一键删除源'/);
  assert.doesNotMatch(sources,/function requestRemoveGroup\(group:ImportGroup\)\{deleteDraft\.value=/);
});

test('VOD exposes category filters and a stable next-page control',async()=>{
  const vod=await read('apps/desktop/src/renderer/views/VodView.vue');
  assert.match(vod,/const nextPageAvailable=computed/);
  assert.match(vod,/async function toggleFiltersPanel\(\)/);
  assert.match(vod,/@click="toggleFiltersPanel"/);
  assert.match(vod,/class="secondary-button load-next-page"/);
  assert.match(vod,/:disabled="!nextPageAvailable"/);
  assert.match(vod,/已到最后一页/);
});

test('CMS adapters recover metadata, send native filters and infer pagination',async()=>{
  const cms=await read('packages/source-adapters/src/cms.ts');
  const common=await read('packages/source-adapters/src/common.ts');
  assert.match(cms,/\{ac:'list'\}/);
  assert.match(cms,/const clean=Object\.fromEntries/);
  assert.match(cms,/\{\.\.\.clean,ac:'detail',t:categoryId,pg:page/);
  assert.match(cms,/itemCount>=20/);
  assert.match(common,/payload\.filters\?\?payload\.filter/);
  assert.match(common,/function categoryRecords/);
  assert.match(common,/pagesize\?:number\|string/);
});

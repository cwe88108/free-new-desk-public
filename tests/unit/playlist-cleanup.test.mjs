import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {DataService} from '../../services/data-service/dist/index.js';
import {PLAYLIST_CLEANUP_KEY,queuePlaylistCleanup,retryPlaylistCleanup} from '../../apps/desktop/dist/main/playlist-cleanup.js';

test('pending cleanup survives database reopen, retries failure, and preserves restored or unqueued files',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'fnd-cleanup-'));
  const database=path.join(root,'state.db'),playlists=path.join(root,'playlists');await mkdir(playlists);
  let store=new DataService(database);t.after(async()=>{store?.close();await rm(root,{recursive:true,force:true});});
  queuePlaylistCleanup(store,['deleted','active','busy']);
  for(const id of ['deleted','active','unrelated'])await writeFile(path.join(playlists,id+'.playlist'),'keep');
  // A directory cannot be removed by the non-recursive file cleanup call.
  await mkdir(path.join(playlists,'busy.playlist'));await writeFile(path.join(playlists,'busy.playlist','child'),'keep');
  store.saveLiveSource({id:'active',name:'restored',endpoint:'fnd-local://active',enabled:true});
  store.close();store=new DataService(database);
  const first=await retryPlaylistCleanup(store,playlists);
  assert.equal(first.removed,1);assert.equal(first.retainedActive,1);assert.equal(first.failed[0].sourceId,'busy');
  assert.deepEqual(JSON.parse(store.getSetting(PLAYLIST_CLEANUP_KEY)),['busy']);
  assert.equal(await readFile(path.join(playlists,'active.playlist'),'utf8'),'keep');
  assert.equal(await readFile(path.join(playlists,'unrelated.playlist'),'utf8'),'keep');
  await assert.rejects(readFile(path.join(playlists,'deleted.playlist')),{code:'ENOENT'});
  await rm(path.join(playlists,'busy.playlist'),{recursive:true});await writeFile(path.join(playlists,'busy.playlist'),'retry');
  const second=await retryPlaylistCleanup(store,playlists);assert.equal(second.removed,1);assert.equal(second.failed.length,0);
  assert.deepEqual(JSON.parse(store.getSetting(PLAYLIST_CLEANUP_KEY)),[]);
});
test('cleanup refuses path traversal and internal records cannot be edited or exposed through settings IPC',async()=>{
  const values=new Map();const store={getSetting:k=>values.get(k),setSetting:(k,v)=>values.set(k,v),listLiveSources:()=>[]};
  assert.throws(()=>queuePlaylistCleanup(store,['../escape']),/Invalid/);assert.equal(values.size,0);
  values.set(PLAYLIST_CLEANUP_KEY,JSON.stringify(['../escape']));await assert.rejects(retryPlaylistCleanup(store,os.tmpdir()),/Invalid/);
  const text=await readFile(new URL('../../apps/desktop/src/main/index.ts',import.meta.url),'utf8');
  assert.match(text,/key!==PLAYLIST_CLEANUP_KEY/);assert.match(text,/VOD_FAVORITES_RECOVERY_KEY,PLAYLIST_CLEANUP_KEY\]\.includes\(key\)/);
  assert.ok(text.indexOf('await retryPlaylistCleanup(data,')<text.lastIndexOf('registerIpc(data,logger)'));
});

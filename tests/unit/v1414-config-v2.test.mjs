import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {mkdtemp,rm} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {configLocationLabel,parseTVBoxConfigV2} from '../../packages/tvbox-config/dist/index.js';
import {DataService} from '../../services/data-service/dist/index.js';

test('v1.4.14 config snapshot preserves TVBox semantics and resolves bare relative resources',()=>{
  const raw={spider:'runtime/spider.jar;md5;abc',parses:[{name:'P',url:'./parse'}],flags:['qq'],rules:[{host:'demo'}],headers:{Referer:'https://ref.example/'},customTop:{token:'secret'},sites:[{key:'t4',name:'T4',type:4,api:'api/vod',ext:'rules/demo.js',playUrl:'json:parsers/p.js',dialect:'type4-post-v1',customSite:{x:1}}]};
  const result=parseTVBoxConfigV2(JSON.stringify(raw),{baseUrl:'https://cfg.example/a/b/tv.json',sourceUrl:'https://origin.example/config',finalUrl:'https://cfg.example/a/b/tv.json',importedAt:'2026-09-12T00:00:00.000Z'});
  const source=result.sources[0];assert.equal(source.endpoint,'https://cfg.example/a/b/api/vod');assert.equal(source.ext,'https://cfg.example/a/b/rules/demo.js');assert.equal(source.playUrl,'json:https://cfg.example/a/b/parsers/p.js');assert.equal(source.type4Dialect,'type4-post-v1');
  assert.equal(source.configRevision,result.snapshot.contentDigest);assert.deepEqual(result.snapshot.parses,raw.parses);assert.deepEqual(result.snapshot.flags,raw.flags);assert.deepEqual(result.snapshot.rules,raw.rules);assert.deepEqual(result.snapshot.headers,raw.headers);assert.deepEqual(result.snapshot.unknownTopLevel.customTop,raw.customTop);assert.deepEqual(result.snapshot.sites[0].customSite,{x:1});
  assert.equal(result.snapshot.sourceUrl,'https://origin.example/config');assert.equal(result.snapshot.finalUrl,'https://cfg.example/a/b/tv.json');
});

test('v1.4.14 config revision changes with semantic input and inline ext is not rewritten',()=>{
  const a=parseTVBoxConfigV2(JSON.stringify({sites:[{key:'a',type:4,api:'api',ext:'{"token":"x"}'}]}),{baseUrl:'https://cfg.example/base/tv.json'});
  const b=parseTVBoxConfigV2(JSON.stringify({sites:[{key:'a',type:4,api:'api',ext:'{"token":"y"}'}]}),{baseUrl:'https://cfg.example/base/tv.json'});
  assert.notEqual(a.snapshot.configRevision,b.snapshot.configRevision);assert.equal(a.sources[0].endpoint,'https://cfg.example/base/api');assert.equal(a.sources[0].ext,'{"token":"x"}');
});

test('v1.4.14 persists config revision dialect and encrypted snapshot metadata',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'fnd-v1414-config-'));const dbPath=path.join(dir,'data.db');
  try{
    const store=new DataService(dbPath);store.saveSource({id:'s1',name:'Source',kind:'T4_EXT',endpoint:'https://api.example/',enabled:true,trust:'A',configRevision:'rev-1',type4Dialect:'type4-post-v1'});
    store.saveConfigSnapshot({snapshotId:'cfg-1',schemaVersion:2,contentDigest:'digest-1',shell:'plain',encryptedPayload:'ciphertext-only',importedAt:'2026-09-12T00:00:00.000Z',importGroupId:'g1'});
    assert.equal(store.listSources()[0]?.configRevision,'rev-1');assert.equal(store.listSources()[0]?.type4Dialect,'type4-post-v1');assert.equal(store.getDatabaseVersion(),16);store.close();
    const db=new DatabaseSync(dbPath);const row=db.prepare('SELECT encrypted_payload,import_group_id FROM config_snapshots WHERE snapshot_id=?').get('cfg-1');assert.equal(row.encrypted_payload,'ciphertext-only');assert.equal(row.import_group_id,'g1');db.close();
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('v1.4.14 config snapshot metadata strips URL credentials query and fragment',()=>{
  assert.equal(configLocationLabel('https://alice:secret@cfg.example/path/tv.json?token=abc#frag'),'https://cfg.example/path/tv.json');
});

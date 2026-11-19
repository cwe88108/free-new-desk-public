import test from 'node:test';
import assert from 'node:assert/strict';
import {DataService} from '../../services/data-service/dist/index.js';

function library(t){
  const db=new DataService(':memory:');t.after(()=>db.close());
  db.saveMusicSource({id:'source',kind:'local',name:'Fixture',root:'C:/Fixture',enabled:true,createdAt:'2026-10-19T00:00:00Z',updatedAt:'2026-10-19T00:00:00Z'});
  const specs=[
    {id:'z',discNumber:1,trackNumber:1},{id:'r',discNumber:1,trackNumber:2},
    {id:'b',discNumber:1,trackNumber:2},{id:'x',discNumber:2,trackNumber:1},
    {id:'c',discNumber:2,cueTrack:2},{id:'a',discNumber:2},
    {id:'d',trackNumber:1},{id:'e'},
  ];
  db.replaceMusicTracks('source',specs.map(item=>({...item,sourceId:'source',path:'C:/Fixture/'+item.id+'.flac',relativePath:item.id+'.flac',title:'Same title',artist:'Artist',album:'Album',albumId:'album',format:'FLAC',available:true,favorite:true})));
  return db;
}

test('album playback order uses disc, track and stable tie-breaks across keyset pages',t=>{
  const db=library(t),ids=[];let after='';
  do{const page=db.musicCatalog({albumId:'album',limit:2,after});ids.push(...page.tracks.map(track=>track.id));after=page.next;assert.ok(ids.length<=8,'pagination must advance');}while(after);
  assert.deepEqual(ids,['z','b','r','x','c','a','d','e']);
  assert.equal(new Set(ids).size,8);
});

test('album cursors cannot cross filters or reuse the old ID-only ordering',t=>{
  const db=library(t),page=db.musicCatalog({albumId:'album',limit:2});
  assert.ok(page.next.startsWith('album-v1:'));
  for(const query of [{albumId:'album',favorite:true},{albumId:'other'},{albumId:'album',sourceId:'source'}]){
    assert.throws(()=>db.musicCatalog({...query,after:page.next}),/MUSIC_CURSOR_EXPIRED/);
  }
  assert.throws(()=>db.musicCatalog({albumId:'album',after:'old-hash-id'}),/MUSIC_CURSOR_EXPIRED/);
  const first=db.musicCatalog({limit:2}),second=db.musicCatalog({limit:2,after:first.next});
  assert.deepEqual([...first.tracks,...second.tracks].map(track=>track.id),['a','b','c','d']);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DataService} from '../../services/data-service/dist/index.js';

test('music migration 14 persists sources tracks and favorites',()=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'free-new-desk-music-'));
  try{
    const db=new DataService(path.join(dir,'app.db'));assert.equal(db.getDatabaseVersion(),14);
    const now='2026-09-06T00:00:00.000Z';db.saveMusicSource({id:'local-1',name:'Music',kind:'local',root:'C:\\Music',enabled:true,createdAt:now,updatedAt:now,scanState:'idle'});
    db.replaceMusicTracks('local-1',[{id:'track-1',sourceId:'local-1',path:'C:\\Music\\Artist\\Album\\Song.flac',relativePath:'Artist\\Album\\Song.flac',title:'Song',artist:'Artist',album:'Album',format:'FLAC',favorite:false,available:true}]);
    db.replaceMusicTracks('local-1',[],false);assert.equal(db.getMusicTrack('track-1')?.available,true);
    assert.equal(db.listMusicSources()[0]?.id,'local-1');assert.equal(db.getMusicTrack('track-1')?.artist,'Artist');assert.equal(db.toggleMusicFavorite('track-1'),true);assert.equal(db.getMusicTrack('track-1')?.favorite,true);db.close();
    const reopened=new DataService(path.join(dir,'app.db'));assert.equal(reopened.getMusicTrack('track-1')?.favorite,true);assert.equal(reopened.removeMusicSource('local-1'),true);assert.equal(reopened.getMusicTrack('track-1'),undefined);reopened.close();
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('music lookup is not limited to the first 20000 tracks',()=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'free-new-desk-music-large-'));
  try{
    const db=new DataService(path.join(dir,'app.db')),now='2026-09-06T00:00:00.000Z';db.saveMusicSource({id:'large',name:'Large',kind:'local',root:'D:\\Music',enabled:true,createdAt:now,updatedAt:now,scanState:'idle'});
    const count=20_005,tracks=Array.from({length:count},(_,index)=>({id:`track-${index}`,sourceId:'large',path:`D:\\Music\\${index}.flac`,relativePath:`${index}.flac`,title:`Track ${String(index).padStart(5,'0')}`,artist:'Artist',album:'Album',format:'FLAC',favorite:false,available:true}));
    db.replaceMusicTracks('large',tracks);assert.equal(db.listMusicTracks('large',undefined,count).length,count);assert.equal(db.getMusicTrack('track-20004')?.title,'Track 20004');db.close();
  }finally{rmSync(dir,{recursive:true,force:true});}
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DataService } from '../../services/data-service/dist/index.js';

test('DataService persists source playback metadata, live headers and resumable history metadata at migration v12',()=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'fnd-live-'));
  let db;
  try{
    db=new DataService(path.join(dir,'app.db'));
    db.saveSource({id:'vod-meta',name:'Metadata VOD',kind:'T1_JSON',endpoint:'https://example.com/vod',enabled:true,trust:'A',playUrl:'json:https://parser.example/?url=',playerType:2,configShell:'base64-star-v1'});
    const vod=db.listSources().find(item=>item.id==='vod-meta');
    assert.equal(vod?.playUrl,'json:https://parser.example/?url=');
    assert.equal(vod?.playerType,2);
    assert.equal(vod?.configShell,'base64-star-v1');
    db.saveLiveSource({id:'live',name:'Live',endpoint:'https://example.com/live.m3u',enabled:true,headers:{'User-Agent':'UA',Referer:'https://example.com/'}});
    const source=db.listLiveSources()[0];
    assert.equal(source?.headers?.['User-Agent'],'UA');
    assert.equal(source?.headers?.Referer,'https://example.com/');

    const episodes=[{flag:'线路A',id:'ep-1',name:'第1集'},{flag:'线路A',id:'ep-2',name:'第2集'}];
    db.addHistory({id:'history-1',sourceId:'vod',sourceName:'点播源',videoId:'movie-1',videoName:'测试影片',episodeName:'第1集',url:'https://example.com/1.m3u8',playedAt:'2026-09-01T00:00:00.000Z',flag:'线路A',episodeId:'ep-1',poster:'https://example.com/poster.jpg',episodes});
    assert.equal(db.updateHistoryProgress('history-1',12.5,1800),true);
    const history=db.listHistory(5)[0];
    assert.equal(history?.flag,'线路A');
    assert.equal(history?.episodeId,'ep-1');
    assert.equal(history?.poster,'https://example.com/poster.jpg');
    assert.deepEqual(history?.episodes,episodes);
    assert.equal(history?.position,12.5);
    assert.equal(history?.duration,1800);
    assert.equal(db.getDatabaseVersion(),12);
  }finally{
    db?.close();
    rmSync(dir,{recursive:true,force:true});
  }
});

test('migration v11 adopts pre-v1.4.4 sources into a deletable legacy import group',()=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'fnd-legacy-group-'));
  const filename=path.join(dir,'app.db');
  let db;
  try{
    db=new DataService(filename);
    db.saveSource({id:'legacy-vod',name:'Legacy VOD',kind:'T1_JSON',endpoint:'https://example.com/api',enabled:true,trust:'A'});
    db.saveLiveSource({id:'legacy-live',name:'Legacy Live',endpoint:'https://example.com/live.m3u',enabled:true});
    db.close();db=undefined;
    const raw=new DatabaseSync(filename);
    raw.exec("DELETE FROM app_migrations WHERE version=11;UPDATE sources SET import_group_id=NULL,source_label=NULL,imported_at=NULL;UPDATE live_sources SET import_group_id=NULL,source_label=NULL,imported_at=NULL;");
    raw.close();
    db=new DataService(filename);
    assert.equal(db.listSources()[0]?.importGroupId,'legacy-import-v143');
    assert.equal(db.listLiveSources()[0]?.importGroupId,'legacy-import-v143');
    const removed=db.removeImportGroup('legacy-import-v143');
    assert.equal(removed.pointSources,1);
    assert.equal(removed.liveSources,1);
  }finally{
    db?.close();
    rmSync(dir,{recursive:true,force:true});
  }
});

test('DataService persists import groups and transactionally removes every child and related row',()=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'fnd-import-group-'));
  let db;
  try{
    db=new DataService(path.join(dir,'app.db'));
    const importedAt='2026-09-03T00:00:00.000Z';
    db.saveSource({id:'vod-grouped',name:'Grouped VOD',kind:'T1_JSON',endpoint:'https://example.com/api',enabled:true,trust:'A',importGroupId:'group-1',sourceLabel:'config.json',importedAt});
    db.saveSource({id:'vod-legacy',name:'Legacy VOD',kind:'T1_JSON',endpoint:'https://example.com/legacy',enabled:true,trust:'A'});
    db.saveLiveSource({id:'live-grouped',name:'Grouped Live',endpoint:'https://example.com/live.m3u',enabled:true,importGroupId:'group-1',sourceLabel:'config.json',importedAt});
    db.addHistory({id:'history-grouped',sourceId:'vod-grouped',sourceName:'Grouped VOD',videoId:'v1',videoName:'Video',episodeName:'EP1',url:'https://example.com/v1.m3u8',playedAt:importedAt});
    db.saveLiveFavorite({liveSourceId:'live-grouped',channelId:'channel-1',channelName:'Channel',group:'General',url:'https://example.com/live.m3u8',urls:['https://example.com/live.m3u8'],createdAt:importedAt});
    db.replaceEpg('live-grouped',[{channelId:'channel-1',title:'Program',start:importedAt,stop:'2026-09-03T01:00:00.000Z'}]);
    db.saveReservation({id:'reservation-1',liveSourceId:'live-grouped',channelId:'channel-1',channelName:'Channel',programTitle:'Program',start:importedAt,createdAt:importedAt});
    for(const sourceId of ['vod-grouped','live-grouped'])db.saveSourceHealth({sourceId,ok:sourceId==='vod-grouped',latencyMs:10,checkedAt:importedAt,score:sourceId==='vod-grouped'?100:0,compatibilityStage:sourceId==='vod-grouped'?'invoke':'network',retryable:sourceId!=='vod-grouped'});

    assert.equal(db.listSources().find(item=>item.id==='vod-grouped')?.importGroupId,'group-1');
    assert.equal(db.listLiveSources()[0]?.importGroupId,'group-1');
    assert.equal(db.listSourceHealth().find(item=>item.sourceId==='live-grouped')?.compatibilityStage,'network');
    assert.equal(db.listSourceHealth().find(item=>item.sourceId==='live-grouped')?.retryable,true);

    const removed=db.removeImportGroup('group-1');
    assert.deepEqual({...removed,sourceIds:removed.sourceIds.sort(),liveSourceIds:removed.liveSourceIds.sort()},{importGroupId:'group-1',sourceIds:['vod-grouped'],liveSourceIds:['live-grouped'],pointSources:1,liveSources:1,history:1,health:2,liveFavorites:1,epgPrograms:1,reservations:1});
    assert.deepEqual(db.listSources().map(item=>item.id),['vod-legacy'],'legacy source without group metadata must remain');
    assert.equal(db.listLiveSources().length,0);
    assert.equal(db.listHistory(10).length,0);
    assert.equal(db.listSourceHealth().length,0);
    assert.equal(db.listLiveFavorites().length,0);
    assert.equal(db.listEpg('live-grouped').length,0);
    assert.equal(db.listReservations().length,0);
  }finally{
    db?.close();
    rmSync(dir,{recursive:true,force:true});
  }
});

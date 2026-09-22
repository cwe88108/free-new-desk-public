import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,mkdir,rm} from 'node:fs/promises';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import os from 'node:os';
import path from 'node:path';
import {DataService} from '../../services/data-service/dist/index.js';
import {albumIdentity} from '../../apps/desktop/dist/main/music-scan-worker.js';
const source=root=>({id:'nas-test',name:'NAS fixture',kind:'local',root,enabled:true,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
const track=(id,sourceId='nas-test')=>({id,sourceId,path:id+'.wav',relativePath:id+'.wav',title:id,artist:'歌手',album:'专辑',albumArtist:'群星',albumId:'album-a',format:'WAV',favorite:false,available:true,metadataRevision:2,metadataStatus:'embedded'});
test('music metadata survives reopen and batch finalization preserves favorites',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'music-db-'));let db;try{db=new DataService(path.join(dir,'app.db'));db.saveMusicSource(source(dir));db.replaceMusicTracks('nas-test',[track('a'),track('b')]);db.toggleMusicFavorite('a');db.markMusicScanBatch('nas-test','g2',[track('a')]);assert.equal(db.musicTrackCount(),2,'partial scan must retain unseen records');db.finishMusicScan('nas-test','g2');assert.equal(db.musicTrackCount(),1);db.close();db=new DataService(path.join(dir,'app.db'));assert.equal(db.getMusicTrack('a').favorite,true);assert.equal(db.getMusicTrack('a').albumArtist,'群星');assert.equal(db.getMusicTrack('a').albumId,'album-a');assert.equal(db.listMusicTracksPage(undefined,'').length,1);db.removeMusicSource('nas-test');assert.equal(db.musicTrackCount(),0);}finally{db?.close();await rm(dir,{recursive:true,force:true});}
});
test('album identity groups compilations and discs but separates editions',()=>{
 const a={...track('a'),relativePath:'Artist/Album/CD1/a.wav',artist:'甲',releaseDate:'2023'};const b={...a,relativePath:'Artist/Album/CD2/b.wav',artist:'乙'};
 assert.equal(albumIdentity(a),albumIdentity(b));assert.notEqual(albumIdentity(a),albumIdentity({...b,releaseDate:'2024'}));assert.equal(albumIdentity({...a,relativePath:'a.wav'}),albumIdentity({...b,relativePath:'b.wav'}));assert.equal(albumIdentity({...a,musicBrainzAlbumId:'release-1'}),albumIdentity({...b,sourceId:'other',musicBrainzAlbumId:'release-1'}));
});
function wav(){const data=Buffer.alloc(44+1600);data.write('RIFF');data.writeUInt32LE(data.length-8,4);data.write('WAVEfmt ',8);data.writeUInt32LE(16,16);data.writeUInt16LE(1,20);data.writeUInt16LE(1,22);data.writeUInt32LE(8000,24);data.writeUInt32LE(16000,28);data.writeUInt16LE(2,32);data.writeUInt16LE(16,34);data.write('data',36);data.writeUInt32LE(1600,40);return data;}
test('scanner subprocess sends bounded batches with ACK and indexes local sidecars',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'music-scan-'));let child;try{await mkdir(path.join(dir,'歌手','专辑'),{recursive:true});await writeFile(path.join(dir,'歌手','专辑','曲目.wav'),wav());await writeFile(path.join(dir,'歌手','专辑','曲目.lrc'),'[00:00.00]示例歌词');await writeFile(path.join(dir,'歌手','专辑','cover.jpg'),'fixture');
 child=fork(new URL('../../apps/desktop/dist/main/music-scan-worker.js',import.meta.url),[],{stdio:['ignore','ignore','pipe','ipc']});const tracks=[];
 const done=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('scan timeout')),20000);child.on('error',reject);child.on('message',m=>{if(m.type==='batch'){tracks.push(...m.tracks);assert.ok(m.tracks.length<=200);child.send({type:'ack'});}if(m.type==='error'){clearTimeout(timer);reject(new Error(m.message));}if(m.type==='done'){clearTimeout(timer);resolve(m);}});});child.send({type:'start',source:source(dir),existing:[]});const result=await done;assert.equal(result.processed,1);assert.equal(tracks[0].album,'专辑');assert.equal(tracks[0].artist,'歌手');assert.match(tracks[0].lyricsPath,/曲目\.lrc$/);assert.match(tracks[0].cover,/cover\.jpg$/);assert.ok(tracks[0].albumId);const exited=once(child,'exit');child.kill();await exited;
 }finally{child?.kill();await rm(dir,{recursive:true,force:true});}
});
test('catalog pages and exact album filters do not leak same-title songs',async()=>{const dir=await mkdtemp(path.join(os.tmpdir(),'music-catalog-'));let db;try{db=new DataService(path.join(dir,'app.db'));db.saveMusicSource(source(dir));const rows=Array.from({length:601},(_,i)=>({...track(String(i).padStart(4,'0')),album:'同名专辑',albumId:i<550?'release-a':'release-b'}));db.replaceMusicTracks('nas-test',rows);const first=db.musicCatalog({albumId:'release-a'});assert.equal(first.total,550);assert.equal(first.tracks.length,500);assert.equal(first.albums.length,1);const next=db.musicCatalog({albumId:'release-a',after:first.next});assert.equal(next.tracks.length,50);assert.equal(next.next,'');assert.equal(new Set([...first.tracks,...next.tracks].map(t=>t.id)).size,550);assert.equal(db.musicCatalog().albumCount,2);}finally{db?.close();await rm(dir,{recursive:true,force:true});}});

test('scanner checkpoint resumes without rescanning committed directories',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'music-resume-'));let child;try{
  for(const name of ['a','b']){await mkdir(path.join(dir,name),{recursive:true});await writeFile(path.join(dir,name,`${name}.wav`),wav());}
  const firstTracks=[];let checkpoint;
  child=fork(new URL('../../apps/desktop/dist/main/music-scan-worker.js',import.meta.url),[],{stdio:['ignore','ignore','pipe','ipc']});
  const paused=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('checkpoint timeout')),20000);child.on('message',m=>{if(m.type==='batch'){firstTracks.push(...m.tracks);child.send({type:'ack'});}if(m.type==='checkpoint'&&m.processed===1){checkpoint=m.checkpoint;clearTimeout(timer);resolve();}if(m.type==='error'){clearTimeout(timer);reject(new Error(m.message));}});});
  child.send({type:'start',source:source(dir),existing:[]});await paused;const exited=once(child,'exit');child.kill();await exited;child=undefined;
  assert.equal(firstTracks.length,1);assert.ok(checkpoint);assert.deepEqual(checkpoint.pendingDirectories,['b']);
  const resumed=[];child=fork(new URL('../../apps/desktop/dist/main/music-scan-worker.js',import.meta.url),[],{stdio:['ignore','ignore','pipe','ipc']});
  const done=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('resume timeout')),20000);child.on('message',m=>{if(m.type==='batch'){resumed.push(...m.tracks);child.send({type:'ack'});}if(m.type==='done'){clearTimeout(timer);resolve(m);}if(m.type==='error'){clearTimeout(timer);reject(new Error(m.message));}});});
  child.send({type:'start',source:source(dir),existing:firstTracks,checkpoint});const result=await done;assert.equal(result.processed,2);assert.equal(resumed.length,1);assert.match(resumed[0].relativePath,/^b\//);
 }finally{child?.kill();await rm(dir,{recursive:true,force:true});}
});

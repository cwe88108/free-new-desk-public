import {spawn} from 'node:child_process';
import {app,ipcMain} from 'electron';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {DataService} from '../services/data-service/dist/index.js';
async function main(){
const dir=await mkdtemp(path.join(os.tmpdir(),'fnd-music-electron-'));app.setPath('userData',dir);
const out=process.env.FND_MUSIC_TEST_REPORT||path.resolve('dist/music-electron-test.json');
const handlers=new Map(),original=ipcMain.handle.bind(ipcMain);ipcMain.handle=(name,fn)=>{handlers.set(name,fn);return original(name,fn);};
const results=[];let db;let shareName='';
const powershell=command=>new Promise((resolve,reject)=>{const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{windowsHide:true,stdio:['ignore','pipe','pipe']});let error='';child.stderr.on('data',b=>error+=b);child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(new Error(error)));});
const call=(name,input)=>handlers.get('music:'+name)({senderFrame:{url:'file:///music-test.html'}},input);
async function waitFor(fn,message,timeout=20000){const start=Date.now();while(Date.now()-start<timeout){const value=await fn();if(value)return value;await new Promise(r=>setTimeout(r,50));}throw new Error(message);}
function wave(){const b=Buffer.alloc(44+1600);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(8000,24);b.writeUInt32LE(16000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(1600,40);return b;}
try{
 await app.whenReady();await mkdir(path.join(dir,'data'));const root=path.join(dir,'media','Singer','Album');await mkdir(root,{recursive:true});for(let i=0;i<350;i++)await writeFile(path.join(root,`Song ${i}.wav`),wave());await writeFile(path.join(root,'Song 0.lrc'),'[00:00.00]测试歌词');
 db=new DataService(path.join(dir,'data','app.db'));const now=new Date().toISOString();db.saveMusicSource({id:'fixture',name:'Fixture',kind:'local',root:path.join(dir,'media'),enabled:true,createdAt:now,updatedAt:now,scanState:'scanning'});
 db.setSetting('music.scan.job.fixture',JSON.stringify({jobId:'crashed-job',sourceId:'fixture',state:'extracting',processed:3,discovered:350,failed:0,updatedAt:now}));
 await import('../apps/desktop/dist/main/music-service.js');
 assert.equal(call('listSources')[0].scanJob.state,'interrupted');results.push({case:'startup recovers orphaned scan',ok:true});
 const started=performance.now(),first=await call('scan',{sourceId:'fixture'});assert.equal(first.queued,true);assert.ok(performance.now()-started<1000);assert.equal((await call('scan',{sourceId:'fixture'})).jobId,first.jobId);results.push({case:'enqueue responds immediately and deduplicates',ok:true});
 await waitFor(()=>['discovering','extracting','committing'].includes(call('listSources')[0]?.scanJob?.state),'utility worker did not start');assert.equal(call('pauseScan',{sourceId:'fixture'}),true);await waitFor(()=>call('listSources')[0]?.scanJob?.state==='paused','pause state missing');await new Promise(r=>setTimeout(r,500));results.push({case:'pause terminates active utility worker',ok:true});
 const second=await call('scan',{sourceId:'fixture'});assert.equal(second.jobId,first.jobId,'paused scan must resume the same persisted job');await waitFor(()=>call('listSources')[0]?.scanJob?.state==='completed','scan did not complete',45000);assert.equal(db.musicTrackCount('fixture'),350);const catalog=call('catalog',{});assert.equal(catalog.total,350);assert.equal(catalog.albums.length,1);const item=catalog.tracks.find(t=>t.title==='Song 0');assert.ok(item);const lyrics=await call('lyricsInfo',{trackId:item.id});assert.equal(lyrics.provider,'本地 LRC');assert.equal(lyrics.kind,'synced');results.push({case:'utility scan catalogs tags albums and local lyrics',ok:true});
 const source=db.listMusicSources()[0];db.saveMusicSource({...source,root:path.join(dir,'missing')});call('scan',{sourceId:'fixture'});await waitFor(()=>call('listSources')[0]?.scanJob?.state==='failed','offline scan did not fail');assert.equal(db.musicTrackCount('fixture'),350);results.push({case:'offline failure retains indexed tracks',ok:true});
 await new Promise(r=>setTimeout(r,300));db.saveMusicSource(source);for(let i=0;i<350;i++)await writeFile(path.join(root,`Song ${i}.wav`),Buffer.concat([wave(),Buffer.alloc(2)]));call('scan',{sourceId:'fixture'});await waitFor(()=>['discovering','extracting','committing'].includes(call('listSources')[0]?.scanJob?.state),'rescan did not start');call('removeSource',{sourceId:'fixture'});await new Promise(r=>setTimeout(r,1000));assert.equal(db.listMusicSources().length,0);results.push({case:'removal fences late worker results',ok:true});
 shareName='FND-MUSIC-TEST-'+process.pid;await powershell(`New-SmbShare -Name '${shareName}' -Path '${path.join(dir,'media').replaceAll("'","''")}' -FullAccess ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -Temporary -ErrorAction Stop | Out-Null`);
 const smbSource={...source,id:'smb-fixture',kind:'smb',root:'\\\\localhost\\'+shareName};db.saveMusicSource(smbSource);const queued=await call('scan',{sourceId:smbSource.id});assert.equal(queued.queued,true);await waitFor(()=>call('listSources').find(s=>s.id===smbSource.id)?.scanJob?.state==='completed','loopback SMB scan failed',45000);assert.equal(db.musicTrackCount(smbSource.id),350);results.push({case:'real Windows SMB loopback scan',ok:true});
 await powershell(`Remove-SmbShare -Name '${shareName}' -Force -ErrorAction Stop`);shareName='';await new Promise(r=>setTimeout(r,300));await call('scan',{sourceId:smbSource.id});await waitFor(()=>call('listSources').find(s=>s.id===smbSource.id)?.scanJob?.state==='failed','disconnected SMB scan did not fail',45000);assert.equal(db.musicTrackCount(smbSource.id),350);results.push({case:'disconnected Windows SMB share retains catalog',ok:true});
 await mkdir(path.dirname(out),{recursive:true});await writeFile(out,JSON.stringify({ok:true,results},null,2));console.log(JSON.stringify({ok:true,results}));db.close();db=undefined;app.quit();
}catch(error){if(shareName)await powershell(`Remove-SmbShare -Name '${shareName}' -Force -ErrorAction SilentlyContinue`).catch(()=>undefined);await mkdir(path.dirname(out),{recursive:true});await writeFile(out,JSON.stringify({ok:false,results,error:String(error.stack??error)},null,2));console.error(error);db?.close();app.exit(1);}

}
void main();

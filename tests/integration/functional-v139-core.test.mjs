import assert from 'node:assert/strict';
import { mkdtemp,readFile,rm,writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root=new URL('../../',import.meta.url);
const importBuilt=relative=>import(new URL(relative,root));

async function tempDir(prefix){return mkdtemp(path.join(os.tmpdir(),prefix));}

test('playback history persists position and duration',async t=>{
  const {DataService}=await importBuilt('services/data-service/dist/index.js');
  const dir=await tempDir('fnd-history-');
  const store=new DataService(path.join(dir,'app.db'));
  t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true});});
  store.addHistory({id:'h1',sourceId:'s1',sourceName:'source',videoId:'v1',videoName:'video',episodeName:'ep1',url:'https://example.invalid/video.mp4',playedAt:new Date().toISOString()});
  assert.equal(store.updateHistoryProgress('h1',73.25,3600),true);
  const item=store.listHistory(1)[0];
  assert.equal(item?.position,73.25);
  assert.equal(item?.duration,3600);
  assert.ok(store.getDatabaseVersion()>=9);
});

test('disk cache recovers from one ENOSPC write and keeps data readable',async t=>{
  const {DiskCache}=await importBuilt('apps/desktop/dist/main/cache-service.js');
  const dir=await tempDir('fnd-cache-');t.after(()=>rm(dir,{recursive:true,force:true}));
  let fail=true;
  const writer=async(file,data,encoding)=>{
    if(fail){fail=false;const error=Object.assign(new Error('simulated disk full'),{code:'ENOSPC'});throw error;}
    if(encoding)await writeFile(file,data,encoding);else await writeFile(file,data);
  };
  const cache=new DiskCache(dir,64*1024*1024,writer);
  await cache.init();
  await cache.put('http','key',Buffer.from('recovered'),'text/plain',60_000);
  const value=await cache.get('http','key');
  assert.equal(value?.data.toString('utf8'),'recovered');
});

test('managed playlist and cache namespace helpers reject traversal',async()=>{
  const {safeManagedPlaylistPath,safeCacheNamespacePath}=await importBuilt('apps/desktop/dist/main/path-safety.js');
  const rootPath=path.resolve(os.tmpdir(),'fnd-safe-root');
  const playlist=safeManagedPlaylistPath(rootPath,'abc-123');
  assert.equal(path.dirname(playlist),rootPath);
  const cache=safeCacheNamespacePath(rootPath,'epg_cache');
  assert.equal(path.dirname(cache),rootPath);
  assert.throws(()=>safeManagedPlaylistPath(rootPath,'../escape'),/Invalid managed playlist identifier/);
  assert.throws(()=>safeManagedPlaylistPath(rootPath,'a/b'),/Invalid managed playlist identifier/);
  assert.throws(()=>safeCacheNamespacePath(rootPath,'../escape'),/Invalid cache namespace/);
});

test('source audit exposes five stages and concurrent same-source audits are deduplicated',async t=>{
  const {SourceEngine}=await importBuilt('services/source-engine/dist/index.js');
  let requests=0;
  const server=createServer((req,res)=>{
    requests+=1;
    const url=new URL(req.url??'/',`http://${req.headers.host}`);
    const ids=url.searchParams.get('ids');
    const wd=url.searchParams.get('wd');
    const category=url.searchParams.get('t');
    const item={vod_id:'v1',vod_name:'示例影片',vod_pic:'',vod_remarks:'HD',vod_play_from:'direct',vod_play_url:'正片$https://example.invalid/video.mp4'};
    const body=ids?{list:[item]}:wd?{list:[item]}:category?{page:1,pagecount:1,total:1,list:[item]}:{class:[{type_id:'1',type_name:'电影'}],list:[item]};
    res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(body));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const address=server.address();assert.ok(address&&typeof address==='object');
  const engine=new SourceEngine();t.after(()=>engine.destroy());
  await engine.replaceSources([{id:'s1',name:'fixture',kind:'T1_JSON',endpoint:`http://127.0.0.1:${address.port}/api`,enabled:true,trust:'A'}]);
  const [a,b]=await Promise.all([engine.audit('s1'),engine.audit('s1')]);
  for(const result of [a,b]){
    assert.equal(result.ok,true);
    assert.deepEqual(result.stages.map(stage=>stage.stage),['home','category','search','detail','play']);
    assert.equal(result.stages.length,5);
  }
  assert.equal(requests,4,'concurrent audit should share one five-stage audit execution');
});

test('Douban adapter returns last successful browse payload during a transient outage',async()=>{
  const {DoubanAdapter}=await importBuilt('services/source-engine/dist/douban-adapter.js');
  let offline=false;
  const broker={
    async request(){
      if(offline)throw new Error('network offline');
      return new Response(JSON.stringify({subjects:[{id:'1292052',title:'肖申克的救赎',pic:'https://example.invalid/poster.jpg',rating:'9.7'}]}),{status:200,headers:{'content-type':'application/json'}});
    },
    clearCookies(){}
  };
  const adapter=new DoubanAdapter({id:'douban',name:'豆瓣',kind:'T3_JAR',endpoint:'fixture',enabled:true,trust:'B'},broker);
  await adapter.init({sourceId:'douban'});
  const first=await adapter.getHome();
  assert.equal(first.items[0]?.name,'肖申克的救赎');
  offline=true;
  const stale=await adapter.getHome();
  assert.deepEqual(stale.items,first.items);
  await adapter.destroy();
});


test('data service remains deterministic with 1500 sources and bounded history',async t=>{
  const {DataService}=await importBuilt('services/data-service/dist/index.js');
  const dir=await tempDir('fnd-large-data-');
  const store=new DataService(path.join(dir,'app.db'));
  t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true});});
  const started=performance.now();
  for(let index=0;index<1500;index++){
    const suffix=String(index).padStart(4,'0');
    store.saveSource({id:`source-${suffix}`,name:`来源 ${suffix}`,kind:'T1_JSON',endpoint:`https://example.invalid/${suffix}`,enabled:index%3!==0,trust:'A',searchable:true});
  }
  const sources=store.listSources();
  assert.equal(sources.length,1500);
  assert.equal(sources[0]?.id,'source-0000');
  assert.equal(sources.at(-1)?.id,'source-1499');
  for(let index=0;index<260;index++)store.addHistory({id:`history-${index}`,sourceId:'source-0001',sourceName:'来源 0001',videoId:`video-${index}`,videoName:`影片 ${index}`,episodeName:'第1集',url:'https://example.invalid/video.mp4',playedAt:new Date(Date.now()+index).toISOString(),position:index,duration:3600});
  const history=store.listHistory(200);
  assert.equal(history.length,200,'history must remain bounded at 200 rows');
  assert.equal(history[0]?.id,'history-259');
  assert.ok(performance.now()-started<30_000,'large-data fixture exceeded the 30 second acceptance budget');
});

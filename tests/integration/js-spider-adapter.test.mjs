import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { SpiderAdapter } from '../../services/source-engine/dist/spider-adapter.js';

const spiderCode=`
module.exports={
  homeContent(filter){return JSON.stringify({class:[{type_id:'movie',type_name:'电影'}],filters:{movie:[{key:'year',name:'年份',value:[{n:'2026',v:'2026'}]}]}});},
  homeVideoContent(){return JSON.stringify({list:[{vod_id:'v1',vod_name:'Fixture Movie',vod_pic:'https://img.invalid/v1.jpg'}]});},
  categoryContent(tid,pg,filter,extend){return JSON.stringify({page:Number(pg),pagecount:2,list:[{vod_id:'v2',vod_name:tid+' '+extend.year}]});},
  detailContent(ids){return JSON.stringify({list:[{vod_id:ids[0],vod_name:'Fixture Movie',vod_content:'Summary',vod_play_from:'Main',vod_play_url:'EP1$https://media.invalid/1.m3u8'}]});},
  searchContent(key,quick,pg){return JSON.stringify({page:Number(pg||1),list:[{vod_id:'s1',vod_name:key}]});},
  playerContent(flag,id,vipFlags){return JSON.stringify({parse:0,url:id,header:{Referer:'https://example.invalid/'}});}
};
`;

async function withServer(run){
  const server=http.createServer((_request,response)=>{response.setHeader('content-type','text/javascript; charset=utf-8');response.end(spiderCode);});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();if(!address||typeof address==='string')throw new Error('Fixture server did not expose a TCP port');
  try{return await run(`http://127.0.0.1:${address.port}/spider.js`);}finally{await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
}

test('JS SpiderAdapter supports canonical FongMi methods through isolated worker',async()=>{
  await withServer(async endpoint=>{
    const adapter=new SpiderAdapter({id:'js-fixture',name:'JS Fixture',kind:'T3_JS',endpoint,enabled:true,trust:'B'});
    await adapter.init({sourceId:'js-fixture'});
    try{
      const home=await adapter.getHome();
      assert.deepEqual(home.categories,[{id:'movie',name:'电影'}]);
      assert.equal(home.items[0]?.name,'Fixture Movie');
      assert.equal(home.filters?.movie?.[0]?.key,'year');
      const category=await adapter.getCategory('movie',1,{year:'2026'});
      assert.deepEqual(category,{page:1,hasMore:true,totalPages:2,items:[{id:'v2',name:'movie 2026'}]});
      const detail=await adapter.getDetail(['v1']);
      assert.equal(detail.description,'Summary');
      assert.equal(detail.episodes[0]?.name,'EP1');
      assert.deepEqual(await adapter.search('keyword',2),{page:2,items:[{id:'s1',name:'keyword'}]});
      assert.deepEqual(await adapter.getPlay('Main','https://media.invalid/1.m3u8'),{url:'https://media.invalid/1.m3u8',parse:false,headers:{Referer:'https://example.invalid/'}});
    }finally{await adapter.destroy();}
  });
});

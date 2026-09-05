import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { CmsJsonAdapter,CmsXmlAdapter } from '../../packages/source-adapters/dist/index.js';

async function withServer(handler,run){
  const server=http.createServer(handler);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();
  if(!address||typeof address==='string')throw new Error('Fixture server did not expose a TCP port');
  try{return await run(`http://127.0.0.1:${address.port}/api`);}finally{await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
}

test('CMS JSON adapter falls back for categories, sends native filters and infers pagination',async()=>{
  let categoryQuery;
  const metadataCalls=[];
  await withServer((request,response)=>{
    const url=new URL(request.url??'/', 'http://fixture');
    response.setHeader('content-type','application/json');
    if(url.searchParams.has('ids')){
      response.end(JSON.stringify({list:[{vod_id:'v1',vod_name:'Fixture Movie',vod_content:'Summary',vod_play_from:'Line A$$$Line B',vod_play_url:'EP1$https://media.example/1.m3u8#EP2$https://media.example/2.m3u8$$$Backup$https://media.example/backup.m3u8'}]}));
    }else if(url.searchParams.get('t')==='movie'){
      categoryQuery={page:url.searchParams.get('pg'),year:url.searchParams.get('year'),filter:JSON.parse(url.searchParams.get('f')??'{}')};
      response.end(JSON.stringify({page:1,total:42,limit:20,list:[{vod_id:'v2',vod_name:'Filtered Movie'}]}));
    }else if(url.searchParams.get('wd')==='fixture'){
      response.end(JSON.stringify({list:[{vod_id:'v1',vod_name:'Fixture Movie',vod_remarks:'Search hit'}]}));
    }else if(url.searchParams.get('ac')==='list'){
      metadataCalls.push('list');
      response.end(JSON.stringify({class:[{type_id:'movie',type_name:'电影'}],filter:{movie:[{key:'year',name:'年份',value:[{n:'2026',v:'2026'}]}]}}));
    }else{
      response.end(JSON.stringify({list:[{vod_id:'v1',vod_name:'Fixture Movie',vod_pic:'https://img.example/v1.jpg'}]}));
    }
  },async endpoint=>{
    const adapter=new CmsJsonAdapter(endpoint);await adapter.init({sourceId:'json-fixture'});
    const home=await adapter.getHome();
    assert.equal(home.items[0]?.name,'Fixture Movie');
    assert.deepEqual(home.categories,[{id:'movie',name:'电影'}]);
    assert.deepEqual(home.filters?.movie,[{key:'year',name:'年份',options:[{label:'2026',value:'2026'}]}]);
    assert.deepEqual(metadataCalls,['list']);
    const category=await adapter.getCategory('movie',1,{year:'2026'});
    assert.equal(category.items[0]?.name,'Filtered Movie');
    assert.equal(category.hasMore,true);
    assert.equal(category.totalPages,3);
    assert.equal(category.totalItems,42);
    assert.deepEqual(categoryQuery,{page:'1',year:'2026',filter:{year:'2026'}});
    assert.equal((await adapter.search('fixture')).items[0]?.remark,'Search hit');
    const detail=await adapter.getDetail(['v1']);
    assert.equal(detail.description,'Summary');
    assert.deepEqual(detail.episodes.map(item=>[item.flag,item.name]),[['Line A','EP1'],['Line A','EP2'],['Line B','Backup']]);
    assert.deepEqual(await adapter.getPlay('Line A',detail.episodes[0].id),{url:'https://media.example/1.m3u8',parse:false});
    await adapter.destroy();
  });
});

test('CMS JSON adapter keeps next-page discovery when an API omits pagination metadata',async()=>{
  await withServer((_request,response)=>{
    response.setHeader('content-type','application/json');
    response.end(JSON.stringify({list:Array.from({length:20},(_,index)=>({vod_id:String(index+1),vod_name:`Movie ${index+1}`}))}));
  },async endpoint=>{
    const adapter=new CmsJsonAdapter(endpoint);await adapter.init({sourceId:'json-no-metadata'});
    const page=await adapter.getCategory('movie',1);
    assert.equal(page.items.length,20);
    assert.equal(page.hasMore,true);
    assert.equal(page.totalPages,2);
    await adapter.destroy();
  });
});

test('CMS XML adapter falls back to list metadata and infers page count',async()=>{
  const metadataCalls=[];
  await withServer((request,response)=>{
    const url=new URL(request.url??'/', 'http://fixture');
    response.setHeader('content-type','text/xml');
    if(url.searchParams.has('ids')){
      response.end('<rss><list><video><id>x1</id><name><![CDATA[XML Movie]]></name><des><![CDATA[XML summary]]></des><dl><dd flag="Main"><![CDATA[1$https://media.example/xml.m3u8#2$https://media.example/xml2.m3u8]]></dd></dl></video></list></rss>');
    }else if(url.searchParams.get('t')==='2'){
      assert.equal(url.searchParams.get('year'),'2026');
      response.end('<rss><list recordcount="45" pagesize="20"><video><id>x2</id><name>XML Category Movie</name></video></list></rss>');
    }else if(url.searchParams.get('wd')==='xml'){
      response.end('<rss><list><video><id>x1</id><name>XML Movie</name><note>Search XML</note></video></list></rss>');
    }else if(url.searchParams.get('ac')==='list'){
      metadataCalls.push('list');
      response.end('<rss><class><ty id="2">电影</ty></class></rss>');
    }else{
      response.end('<rss><list><video><id>x1</id><name>XML Movie</name><pic>https://img.example/x1.jpg</pic></video></list></rss>');
    }
  },async endpoint=>{
    const adapter=new CmsXmlAdapter(endpoint);await adapter.init({sourceId:'xml-fixture'});
    const home=await adapter.getHome();
    assert.equal(home.items[0]?.name,'XML Movie');
    assert.deepEqual(home.categories,[{id:'2',name:'电影'}]);
    assert.deepEqual(metadataCalls,['list']);
    const category=await adapter.getCategory('2',1,{year:'2026'});
    assert.equal(category.items[0]?.name,'XML Category Movie');
    assert.equal(category.hasMore,true);
    assert.equal(category.totalPages,3);
    assert.equal(category.totalItems,45);
    assert.equal((await adapter.search('xml')).items[0]?.remark,'Search XML');
    const detail=await adapter.getDetail(['x1']);
    assert.equal(detail.description,'XML summary');
    assert.deepEqual(detail.episodes.map(item=>item.name),['1','2']);
    await adapter.destroy();
  });
});

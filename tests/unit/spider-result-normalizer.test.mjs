import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSpiderCategory,normalizeSpiderDetail,normalizeSpiderHome,normalizeSpiderPlay,normalizeSpiderSearch } from '../../services/source-engine/dist/result-normalizer.js';

test('Spider normalizer converts TVBox home class filters and list payloads',()=>{
  const result=normalizeSpiderHome(JSON.stringify({class:[{type_id:'1',type_name:'电影'}],filters:{1:[{key:'year',name:'年份',value:[{n:'2026',v:'2026'}]}]},list:[{vod_id:'v1',vod_name:'Movie',vod_pic:'https://img.example/v1.jpg'}]}));
  assert.deepEqual(result.categories,[{id:'1',name:'电影'}]);
  assert.deepEqual(result.filters?.['1'],[{key:'year',name:'年份',options:[{label:'2026',value:'2026'}]}]);
  assert.deepEqual(result.items,[{id:'v1',name:'Movie',poster:'https://img.example/v1.jpg'}]);
});

test('Spider normalizer converts category and search pagination payloads',()=>{
  assert.deepEqual(normalizeSpiderCategory({page:2,pagecount:3,total:41,list:[{vod_id:'v2',vod_name:'Page 2'}]},2),{page:2,hasMore:true,totalPages:3,totalItems:41,items:[{id:'v2',name:'Page 2'}]});
  assert.deepEqual(normalizeSpiderSearch({page:3,list:[{id:'v3',name:'Search'}]},3),{page:3,items:[{id:'v3',name:'Search'}]});
});

test('Spider normalizer converts TVBox detail and playerContent payloads',()=>{
  const detail=normalizeSpiderDetail({list:[{vod_id:'v1',vod_name:'Movie',vod_content:'Summary',vod_play_from:'Main',vod_play_url:'EP1$https://media.example/1.m3u8'}]});
  assert.equal(detail.description,'Summary');
  assert.deepEqual(detail.episodes,[{flag:'Main',id:'https://media.example/1.m3u8',name:'EP1'}]);
  assert.deepEqual(normalizeSpiderPlay({parse:0,url:'https://media.example/1.m3u8',header:{'User-Agent':'Fixture','Referer':'https://example.invalid/'}}),{url:'https://media.example/1.m3u8',parse:false,headers:{'User-Agent':'Fixture',Referer:'https://example.invalid/'}});
  assert.deepEqual(normalizeSpiderPlay({parse:0,jx:1,url:'https://resolver.example/?id=1',subs:[{url:'https://sub.example/a.srt',name:'中文'}],danmaku:[{url:'https://danmaku.example/a.xml',name:'弹幕'}],drm:{type:'widevine',license:'https://license.example/'}}),{url:'https://resolver.example/?id=1',parse:true,subtitles:[{url:'https://sub.example/a.srt',name:'中文'}],danmaku:[{url:'https://danmaku.example/a.xml',name:'弹幕'}],drm:{type:'widevine',licenseUrl:'https://license.example/'}});
});

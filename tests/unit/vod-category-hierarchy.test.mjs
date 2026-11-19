import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';
import vm from 'node:vm';
async function load(path){const exports={};vm.runInNewContext(ts.transpileModule(await readFile(new URL(path,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports});return exports;}
const {parseCmsCategories,parseCmsXmlCategories}=await load('../../packages/source-adapters/src/common.ts');
const {categoryGroup,categoryShortcutTarget,cmsCategoryCandidates,cmsCategoryTarget,visibleSourceCategories}=await load('../../packages/contracts/src/source-categories.ts');
test('configured names retain matching descendants and fall back to declared categories on no match',()=>{
  const rows=[{id:'drama',name:'连续剧'},{id:'cn',name:'国产剧',parentId:'drama'},{id:'film',name:'电影'}];
  assert.equal(visibleSourceCategories(rows,['电视剧']).length,2);
  assert.equal(visibleSourceCategories(rows,['电视剧'])[1].id,'cn');
  assert.equal(visibleSourceCategories(rows,['未匹配名称']),rows);
});
test('JSON CMS retains declared parents and resolves all four group IDs to actual leaves',()=>{
  for(const [name,id] of [['电影','movie'],['连续剧','series'],['综艺','shows'],['动漫','anime']]){
    const rows=parseCmsCategories({class:[{type_id:id,type_name:name,type_pid:0},{type_id:id+'-child',type_name:'子类',type_pid:id}]});
    assert.equal(rows[1].parentId,id);assert.equal(cmsCategoryTarget(rows,id),id+'-child');assert.equal(cmsCategoryTarget(rows,id+'-child'),id+'-child');
  }
});

test('configured leaf categories retain their ancestors without enabling excluded siblings',()=>{
 const rows=[{id:'film',name:'电影'},{id:'action',name:'动作片',parentId:'film'},{id:'horror',name:'恐怖片',parentId:'film'},{id:'series',name:'连续剧'},{id:'cn',name:'国产剧',parentId:'series'},{id:'shows',name:'综艺'}];
 const visible=visibleSourceCategories(rows,['动作片','国产剧']);
 assert.deepEqual(Array.from(visible,x=>x.id),['film','action','series','cn']);
 assert.equal(cmsCategoryTarget(visible,categoryShortcutTarget(visible,'电影')),'action');
 assert.equal(cmsCategoryTarget(visible,categoryShortcutTarget(visible,'剧集')),'cn');
 assert.equal(categoryShortcutTarget(visible,'综艺'),undefined);
});
test('XML does not confuse pid before id with the actual category ID',()=>{
  const rows=parseCmsXmlCategories('<class><ty id="a">电影</ty><ty pid="a" id="b">动作</ty><ty type_pid="b" type_id="c">子类</ty></class>');
  assert.equal(rows[1].id,'b');assert.equal(rows[1].parentId,'a');assert.equal(cmsCategoryTarget(rows,'a'),'c');
});
test('aliases match without guessing category IDs or merging subgenres',()=>{
  assert.equal(categoryGroup('【电视剧】'),categoryGroup('连续剧'));assert.equal(categoryGroup('剧集'),categoryGroup('电视剧'));
  assert.equal(categoryGroup('动画片'),categoryGroup('动漫'));assert.equal(categoryGroup('综艺节目'),categoryGroup('综艺'));
  assert.notEqual(categoryGroup('动作电影'),categoryGroup('电影'));
});
test('cycles, orphan parents, unknown IDs and flat categories terminate without invented IDs',()=>{
  const rows=[{id:'a',name:'A',parentId:'b'},{id:'b',name:'B',parentId:'a'},{id:'c',name:'C',parentId:'missing'}];
  assert.equal(cmsCategoryTarget(rows,'a'),'a');assert.equal(cmsCategoryTarget(rows,'c'),'c');assert.equal(cmsCategoryTarget(rows,'unknown'),'unknown');
  assert.equal(cmsCategoryTarget([{id:'film',name:'电影'}],'film'),'film');
});

test('path-only categories enable all four shortcuts using real IDs and preserve film animation grouping',()=>{
 const rows=[{id:'m',name:'电影/动画片'},{id:'s',name:'电视剧/国产剧'},{id:'v',name:'综艺/大陆综艺'},{id:'a',name:'动漫/日本动漫'}];
 for(const [name,id]of [['电影','m'],['剧集','s'],['综艺','v'],['动漫','a']])assert.equal(categoryShortcutTarget(rows,name),id);
 assert.equal(categoryShortcutTarget(rows,'纪录片'),undefined);
});

test('flat CMS taxonomy keeps each group root first and uses declared IDs for its related labels',()=>{
 const rows=parseCmsXmlCategories('<class><ty id="movies">电影片</ty><ty id="s">连续剧</ty><ty id="v">综艺片</ty><ty id="a">动漫片</ty><ty id="act">动作片</ty><ty id="domestic">国产剧</ty><ty id="show">大陆综艺</ty><ty id="cartoon">国产动漫</ty><ty id="doc">记录片</ty><ty id="foreign-horror" pid="s">恐怖片</ty><ty id="constructor">constructor</ty></class>');
 assert.deepEqual(Array.from(cmsCategoryCandidates(rows,'movies')),['movies','act']);
 assert.deepEqual(Array.from(cmsCategoryCandidates(rows,'s')),['foreign-horror']);
 assert.deepEqual(Array.from(cmsCategoryCandidates(rows.filter(row=>row.id!=='foreign-horror'),'s')),['s','domestic']);
 assert.deepEqual(Array.from(cmsCategoryCandidates(rows,'v')),['v','show']);
 assert.deepEqual(Array.from(cmsCategoryCandidates(rows,'a')),['a','cartoon']);
 assert.deepEqual(Array.from(cmsCategoryCandidates(rows,'constructor')),['constructor']);
 assert.deepEqual(Array.from(cmsCategoryCandidates(visibleSourceCategories(rows,['电影片']),'movies')),['movies']);
});

import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {SourceEngine} from '../services/source-engine/dist/index.js';

function arg(name,fallback){const index=process.argv.indexOf(name);return index>=0&&process.argv[index+1]?process.argv[index+1]:fallback;}
const input=path.resolve(arg('--input','audit/v1414-m4-sources.jsonl'));
const output=path.resolve(arg('--output','dist/audit/source-compat-e2e.json'));
const keys=arg('--keys','drpy_js_看韩剧,drpy_js_tzfile,drpy_js_电影港,drpy_js_农民,drpy_js_量子资源,drpy_js_360影视,drpy_js_豆瓣,drpy_js_斗鱼直播,drpy_js_虎牙直播,drpy_js_A8音乐').split(',').map(v=>v.trim()).filter(Boolean);
const rows=(await readFile(input,'utf8')).trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
await mkdir(path.dirname(output),{recursive:true});
const engineStore=path.join(path.dirname(output),'engine-store');await mkdir(engineStore,{recursive:true});
const results=[];

async function stage(result,name,fn,{required=true}={}){
 const started=Date.now();try{const value=await fn();result.stages.push({stage:name,ok:true,required,durationMs:Date.now()-started});return value;}
 catch(error){result.stages.push({stage:name,ok:false,required,durationMs:Date.now()-started,message:error instanceof Error?error.message:String(error)});return undefined;}
}
function missing(result,name,message,required=true){result.stages.push({stage:name,ok:false,required,durationMs:0,message});}
for(const key of keys){
 const row=rows.find(item=>item.key===key);if(!row){results.push({key,classification:'missing-fixture',sourceInterfaceOk:false,playerValidated:false,stages:[]});continue;}
 const engine=new SourceEngine();engine.configureRuntime({engineStoreDir});
 const config={id:row.key,name:row.name,kind:'T3_JS',endpoint:row.api,ext:row.ext??undefined,enabled:true,trust:'B',searchable:row.searchable,configRevision:'v1415-audit-fixed'};
 const result={key,name:row.name,api:row.api,startedAt:new Date().toISOString(),evidenceScope:'source-interface',playerValidated:false,stages:[]};const started=Date.now();
 try{
  await stage(result,'init',()=>engine.replaceSources([config]));
  const home=await stage(result,'home',()=>engine.getHome(config.id));
  let categoryResult;const category=home?.categories?.[0];
  if(category)categoryResult=await stage(result,'category',()=>engine.getCategory(config.id,category.id,1));else missing(result,'category','来源未返回可审计分类');
  const seed=home?.items?.[0]??categoryResult?.items?.[0];
  let searchResult;if(row.searchable!==false)searchResult=await stage(result,'search',()=>engine.search(config.id,seed?.name??'电影',1));else result.stages.push({stage:'search',ok:true,required:false,durationMs:0,message:'来源声明 searchable=false'});
  const first=seed??searchResult?.items?.[0];
  let detail;if(first)detail=await stage(result,'detail',()=>engine.getDetail(config.id,[first.id]));else missing(result,'detail','首页/分类/搜索均未返回可审计条目');
  const episode=detail?.episodes?.[0];
  if(episode)await stage(result,'playV2',()=>engine.getPlayV2(config.id,episode.flag,episode.id));else missing(result,'playV2','详情未返回可审计播放线路');
 }finally{
  result.elapsedMs=Date.now()-started;
  const required=result.stages.filter(item=>item.required!==false);result.sourceInterfaceOk=required.length>=5&&required.every(item=>item.ok);
  result.classification=result.sourceInterfaceOk?'source-interface-pass':required.some(item=>item.ok)?'partial':'failed';
  result.summary={stagePass:result.stages.filter(item=>item.ok).length,stageFail:result.stages.filter(item=>!item.ok).length};
  results.push(result);await engine.destroy();console.log(JSON.stringify(result));
 }
}
const summary={checkedAt:new Date().toISOString(),total:results.length,sourceInterfacePass:results.filter(r=>r.sourceInterfaceOk).length,partial:results.filter(r=>r.classification==='partial').length,failed:results.filter(r=>r.classification==='failed'||r.classification==='missing-fixture').length,playerValidated:0,note:'sourceInterfaceOk only proves Source Engine stages. Actual playback requires PlayerHost validation.'};
await writeFile(output,JSON.stringify({summary,results},null,2),'utf8');
console.log(JSON.stringify(summary));

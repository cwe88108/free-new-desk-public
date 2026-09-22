import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir,rm,writeFile} from 'node:fs/promises';
import {fork} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const fixture=new URL('../fixtures/drpy2/qist-3.9.52beta3/',import.meta.url);
const entry='https://raw.githubusercontent.com/qist/tvbox/master/lib/drpy2.min.js';
const core='https://raw.githubusercontent.com/qist/tvbox/master/lib/drpy-core-lite.min.js';

function ask(child,dir,payload,timeout=15000){return new Promise((resolve,reject)=>{const id=randomUUID(),timer=setTimeout(()=>{child.off('message',on);reject(new Error(`fixture timeout: ${payload.type}/${payload.method??''}`));},timeout);const on=message=>{if(message?.type==='broker.request'){void writeFile(path.join(dir,`${message.id}.json`),JSON.stringify({result:{content:'',headers:{},code:200}}),'utf8');return;}if(message?.type==='response'&&message.id===id){clearTimeout(timer);child.off('message',on);message.error?reject(new Error(message.error)):resolve(message.result);}};child.on('message',on);child.send({...payload,id});});}

test('pinned qist drpy2 evaluates and initializes with pre-evaluate host ABI',async()=>{
  const [engineCode,coreCode]=await Promise.all([readFile(new URL('drpy2.min.js',fixture),'utf8'),readFile(new URL('drpy-core-lite.min.js',fixture),'utf8')]);
  const dir=path.join(os.tmpdir(),`fnd-qist-fixture-${randomUUID()}`);await mkdir(dir,{recursive:true});
  const child=fork(new URL('../../services/drpy2-worker/dist/worker.js',import.meta.url),[],{stdio:['ignore','ignore','ignore','ipc'],execArgv:['--experimental-vm-modules']});
  const rule=`var rule={title:'Fixture',host:'https://fixture.test',url:'/list/fyclass/fypage'};`;
  try{
    await ask(child,dir,{type:'init',sourceId:'qist-fixture',entryUrl:entry,modules:{[entry]:engineCode,[core]:coreCode},ruleExt:rule,bridgeDir:dir,profileId:'qist-drpy2-3.9.52beta3-20250801',hostAbiVersion:'fnd-drpy2-host/3',instantiation:'object',initContractId:'rule-ext-string-v1',requiredCapabilities:['req-sync','local-namespaced','pdfh','pdfa','pd','crypto-basic'],methodNames:['home','homeVod','category','detail','search','play']},25000);
    const loaded=await ask(child,dir,{type:'call',method:'getRule',args:[]});assert.equal(loaded.title,'Fixture');
    const html='<nav class="nav"><a href="/cat/9">电影</a><a href="/cat/10">剧集</a></nav>';
    const home=await ask(child,dir,{type:'call',method:'home',args:[true,html,'.nav&&a;Text;a&&href;cat/(\\d+)' ]});const parsed=typeof home==='string'?JSON.parse(home):home;
    assert.deepEqual(parsed.class,[{type_id:'https://fixture.test/cat/9',type_name:'电影'},{type_id:'https://fixture.test/cat/10',type_name:'剧集'}]);
  }finally{child.kill();await rm(dir,{recursive:true,force:true});}
});

test('Fun4K mutates its local mxone5 template without leaking to another worker',async()=>{
  const [engineCode,coreCode,funRule]=await Promise.all([readFile(new URL('drpy2.min.js',fixture),'utf8'),readFile(new URL('drpy-core-lite.min.js',fixture),'utf8'),readFile(new URL('Fun4K.js',fixture),'utf8')]);
  const modules={[entry]:engineCode,[core]:coreCode};
  const boot=async(ruleExt,label)=>{const dir=path.join(os.tmpdir(),`fnd-${label}-${randomUUID()}`);await mkdir(dir,{recursive:true});const child=fork(new URL('../../services/drpy2-worker/dist/worker.js',import.meta.url),[],{stdio:['ignore','ignore','ignore','ipc'],execArgv:['--experimental-vm-modules']});await ask(child,dir,{type:'init',sourceId:label,entryUrl:entry,modules,ruleExt,bridgeDir:dir,profileId:'qist-drpy2-3.9.52beta3-20250801',hostAbiVersion:'fnd-drpy2-host/3',instantiation:'object',initContractId:'rule-ext-string-v1',requiredCapabilities:['req-sync','local-namespaced','pdfh','pdfa','pd','crypto-basic'],methodNames:['home','homeVod','category','detail','search','play']},25000);return{child,dir};};
  const fun=await boot(funRule,'fun4k-fixture');let clean;
  try{
    const funLoaded=await ask(fun.child,fun.dir,{type:'call',method:'getRule',args:[]});assert.equal(funLoaded.title,'Fun4K');
    assert.equal(funLoaded.二级.desc,'.video-info-items:eq(3)&&Text;;;.video-info-actor:eq(1)&&Text;.video-info-actor:eq(0)&&Text');assert.equal(funLoaded.二级.tab_text,'body--small&&Text');
    clean=await boot(`var rule={title:'Clean',模板:'mxone5',host:'https://fixture.test'};`,'clean-template-fixture');
    const cleanLoaded=await ask(clean.child,clean.dir,{type:'call',method:'getRule',args:[]});assert.equal(cleanLoaded.title,'Clean');assert.notEqual(cleanLoaded.二级.desc,funLoaded.二级.desc);assert.notEqual(cleanLoaded.二级.tab_text,funLoaded.二级.tab_text);
  }finally{fun.child.kill();await rm(fun.dir,{recursive:true,force:true});if(clean){clean.child.kill();await rm(clean.dir,{recursive:true,force:true});}}
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import {parse} from '@vue/compiler-sfc';

async function harness(){
  const text=parse(await readFile(new URL('../../apps/desktop/src/renderer/views/PlayerView.vue',import.meta.url),'utf8')).descriptor.scriptSetup.content,source=ts.createSourceFile('view.ts',text,ts.ScriptTarget.Latest,true),method=source.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='videoSurfaceStatus');
  const surface={mode:'embedded',requestedVisible:true,windowExists:true,windowVisible:true,parentExists:true,parentMatches:true,parentVisible:true,width:640,height:360,parentWidth:1280,parentHeight:720,withinParent:true};
  const ctx={actualDomain:{value:'vod'},runtimeSession:{value:{requestId:'current',loadId:'load'}},stats:{value:{sampleFresh:true,requestId:'current',loadId:'load',videoSurface:surface}}};
  vm.runInNewContext(ts.transpileModule(method.getText(source)+'\nglobalThis.status=videoSurfaceStatus',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,ctx);
  return{...ctx,surface};
}

test('video diagnosis separates missing, detached, hidden and invalid window geometry',async()=>{
  for(const [field,value,message]of [['windowExists',false,/窗口不存在/],['requestedVisible',false,/未请求显示/],['parentExists',false,/未挂到/],['parentMatches',false,/未挂到/],['parentVisible',false,/隐藏或最小化/],['withinParent',false,/超出应用窗口/],['width',1,/尺寸异常/],['height',0,/尺寸异常/],['windowVisible',false,/隐藏状态/]]){
    const h=await harness();h.surface[field]=value;assert.match(h.status(),message);
  }
});

test('video diagnosis never treats stale or different-session samples as current display evidence',async()=>{
  const h=await harness();for(const [field,value]of [['sampleFresh',false],['requestId','old'],['loadId','old-load']]){const original=h.stats.value[field];h.stats.value[field]=value;assert.match(h.status(),/等待当前会话/);h.stats.value[field]=original;}
  delete h.stats.value.videoSurface;assert.match(h.status(),/未提供窗口诊断/);h.actualDomain.value='music';assert.match(h.status(),/音乐模式/);
});

test('fullscreen and picture-in-picture do not require embedding while visible geometry never proves actual video',async()=>{
  const h=await harness();assert.match(h.status(),/实际画面仍需确认/);
  h.surface.parentExists=false;h.surface.parentMatches=false;h.surface.parentVisible=false;h.surface.withinParent=false;
  for(const mode of ['fullscreen','pip']){h.surface.mode=mode;assert.match(h.status(),/实际画面仍需确认/);}
});

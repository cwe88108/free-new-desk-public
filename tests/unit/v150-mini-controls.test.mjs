import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import {parse} from '@vue/compiler-sfc';
const source=ts.createSourceFile('mini.ts',parse(await readFile(new URL('../../apps/desktop/src/renderer/views/HomeShellView.vue',import.meta.url),'utf8')).descriptor.scriptSetup.content,ts.ScriptTarget.Latest,true);
function actions(names,context){const nodes=source.statements.filter(n=>ts.isFunctionDeclaration(n)&&names.includes(n.name.text));assert.equal(nodes.length,names.length);vm.runInNewContext(ts.transpileModule(nodes.map(n=>n.getText(source)).join('\n')+'\nglobalThis.actions={'+names.join(',')+'};',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context);return context.actions;}
const ref=value=>({value});

test('player status distinguishes buffering from playing, paused, idle and loading',async()=>{
  const template=parse(await readFile(new URL('../../apps/desktop/src/renderer/views/PlayerView.vue',import.meta.url),'utf8')).descriptor.template.content;
  const expression=template.match(/\{\{(playbackError\?'播放失败'[^}]+)\}\}/)?.[1];assert.ok(expression);
  for(const [status,paused,liveBuffering,playbackError,expected]of [
    ['paused',true,false,'','已暂停'],['playing',true,true,'','已暂停'],
    ['playing',false,false,'','播放中'],['playing',false,true,'','正在缓冲'],
    ['loading',false,false,'','正在连接'],['idle',false,false,'','等待播放'],
    ['paused',true,false,'error','播放失败'],
  ])assert.equal(vm.runInNewContext(expression,{runtimeSession:{status},paused,liveBuffering,playbackError}),expected);
});

test('home progress and skip controls use the displayed session; unavailable playback cannot seek',async()=>{
  const sent=[];let fail=false;
  const context={reachable:ref(true),playerStats:ref({requestId:'shown',loadId:'shown-load',duration:120}),miniError:ref(''),refresh:async()=>{},window:{desktop:{playback:{control:async command=>{sent.push(command);return fail?{ok:false,detail:'PLAYBACK_SUPERSEDED'}:{ok:true};}}}}};
  const api=actions(['controlDisplayedPlayer','canSeek','seek'],context);
  await api.seek(42,true);assert.equal(sent[0].requestId,'shown');assert.equal(sent[0].loadId,'shown-load');assert.equal(sent[0].absolute,true);assert.equal(sent[0].value,42);
  await api.seek(-10);assert.equal(sent[1].absolute,false);assert.equal(sent[1].value,-10);
  context.reachable.value=false;await api.seek(10);assert.equal(sent.length,2);
  context.reachable.value=true;context.playerStats.value.duration=0;await api.seek(10);assert.equal(sent.length,2);
  context.playerStats.value.duration=120;fail=true;await api.seek(10);assert.match(context.miniError.value,/PLAYBACK_SUPERSEDED/);
});

test('home player title follows the current VOD identity and excludes signed URL parameters',()=>{
  const context={runtime:ref({domain:'vod',sourceId:'current',videoId:'v',episodeId:'e'}),playerStats:ref({path:'https://cdn.example/video%20title.mp4?token=secret#fragment'})};
  const api=actions(['currentEntry','mediaTitle'],context);
  const history=[{sourceId:'other',videoId:'v',episodeId:'e',videoName:'Wrong'},{sourceId:'current',videoId:'v',episodeId:'e',videoName:'Current',episodeName:'Episode'}];
  assert.equal(api.mediaTitle(history),'Current · Episode');context.runtime.value.domain='live';assert.equal(api.mediaTitle(history),'video title.mp4');
  context.playerStats.value.path='file:///bad%title.mp4';assert.equal(api.mediaTitle(history),'bad%title.mp4');
});

<script setup lang="ts">
import { computed,onMounted,ref } from 'vue';
import { useRouter } from 'vue-router';
import type { LiveSourceConfig,PlaybackHistoryEntry,ProgramReservation,SourceConfig,SourceHealth } from '@free-new-desk/contracts';
import { listVodFavorites } from '../favorites';

interface ImportRecord{kind:string;name:string;source?:string;count?:number;importedAt:string;}
const router=useRouter();
const sourceHealthy=ref<boolean|null>(null);
const info=ref<{version:string;platform:string;arch:string;theme:string}|null>(null);
const recent=ref<PlaybackHistoryEntry[]>([]);
const sources=ref<SourceConfig[]>([]);
const liveSources=ref<LiveSourceConfig[]>([]);
const reservations=ref<ProgramReservation[]>([]);
const health=ref<SourceHealth[]>([]);
const diagnostics=ref<Record<string,string|number>>({});
const update=ref<{current:string;latest:string;available:boolean;url:string;checkedAt:string;publishedAt?:string}|null>(null);
const vodFavoriteCount=ref(0);
const liveFavoriteCount=ref(0);
const importRecords=ref<ImportRecord[]>([]);
const refreshing=ref(false);
const checkingUpdate=ref(false);
const resuming=ref(false);
const actionMessage=ref('');

const enabledSources=computed(()=>sources.value.filter(item=>item.enabled).length);
const healthySources=computed(()=>health.value.filter(item=>item.ok).length);
const unhealthySources=computed(()=>Math.max(0,enabledSources.value-healthySources.value));
const resumeItem=computed(()=>recent.value.find(item=>item.flag!==undefined&&item.episodeId));
const nextReservations=computed(()=>reservations.value.filter(item=>Date.parse(item.start)>=Date.now()).sort((a,b)=>a.start.localeCompare(b.start)).slice(0,3));
const sourceScore=computed(()=>health.value.length?Math.round(health.value.reduce((sum,item)=>sum+item.score,0)/health.value.length):0);
const decodeItems=computed(()=>[
  {label:'当前硬件解码',value:String(diagnostics.value.hardwareDecode??'待播放检测')},
  {label:'视频输出',value:String(diagnostics.value.videoOutput??'由 PlayerHost 查询')},
  {label:'libmpv',value:String(diagnostics.value.libmpv??'待检测').slice(0,34)},
  {label:'GPU',value:String(diagnostics.value.gpu??'待检测').slice(0,34)}
]);

function parseImports(settings:Record<string,string>):ImportRecord[]{try{const value=JSON.parse(settings['imports.recent']??'[]') as unknown;return Array.isArray(value)?value.filter((item):item is ImportRecord=>Boolean(item&&typeof item==='object'&&typeof(item as ImportRecord).name==='string'&&typeof(item as ImportRecord).importedAt==='string')).slice(0,6):[];}catch{return[];}}
function progress(item:PlaybackHistoryEntry|undefined){return item?.duration?Math.min(1,Math.max(0,(item.position??0)/item.duration)):0;}
function formatDuration(value:number|undefined){const minutes=Math.max(0,Math.round((value??0)/60));return minutes>=60?`${Math.floor(minutes/60)} 小时 ${minutes%60} 分钟`:`${minutes} 分钟`;}
async function loadDashboard(){
  refreshing.value=true;actionMessage.value='';
  const results=await Promise.allSettled([window.desktop.source.ping(),window.desktop.app.getInfo(),window.desktop.history.list(8),window.desktop.source.list(),window.desktop.live.listSources(),window.desktop.reservation.list(),window.desktop.source.health(),window.desktop.diagnostics.get(),window.desktop.update.check(),listVodFavorites(),window.desktop.live.favorites(),window.desktop.settings.list()]);
  sourceHealthy.value=results[0]?.status==='fulfilled'?results[0].value:false;
  if(results[1]?.status==='fulfilled')info.value=results[1].value;
  if(results[2]?.status==='fulfilled')recent.value=results[2].value;
  if(results[3]?.status==='fulfilled')sources.value=results[3].value;
  if(results[4]?.status==='fulfilled')liveSources.value=results[4].value;
  if(results[5]?.status==='fulfilled')reservations.value=results[5].value;
  if(results[6]?.status==='fulfilled')health.value=results[6].value;
  if(results[7]?.status==='fulfilled')diagnostics.value=results[7].value;
  if(results[8]?.status==='fulfilled')update.value=results[8].value;
  if(results[9]?.status==='fulfilled')vodFavoriteCount.value=results[9].value.length;
  if(results[10]?.status==='fulfilled')liveFavoriteCount.value=results[10].value.length;
  if(results[11]?.status==='fulfilled')importRecords.value=parseImports(results[11].value);
  const fallback=liveSources.value.filter(item=>item.importedAt).map(item=>({kind:item.origin==='local-file'?'本地直播':'网络直播',name:item.name,source:item.sourceLabel??item.endpoint,importedAt:item.importedAt!}));
  importRecords.value=[...importRecords.value,...fallback].sort((a,b)=>b.importedAt.localeCompare(a.importedAt)).filter((item,index,array)=>array.findIndex(other=>other.name===item.name&&other.importedAt===item.importedAt)===index).slice(0,5);
  refreshing.value=false;
}
async function resume(){
  const item=resumeItem.value;if(!item)return;
  resuming.value=true;actionMessage.value='';
  try{await window.desktop.playback.play({sourceId:item.sourceId,videoId:item.videoId,videoName:item.videoName,flag:item.flag??'',episodeId:item.episodeId!,episodeName:item.episodeName,...(item.poster?{poster:item.poster}:{}),...(item.episodes?.length?{episodeListJson:JSON.stringify(item.episodes)}:{})});if((item.position??0)>5)await window.desktop.playback.control({command:'seek',value:item.position??0,absolute:true});await router.push('/player');}
  catch(value){actionMessage.value=`无法继续播放：${value instanceof Error?value.message:String(value)}`;}finally{resuming.value=false;}
}
async function checkUpdate(){checkingUpdate.value=true;try{update.value=await window.desktop.update.check();}finally{checkingUpdate.value=false;}}
onMounted(loadDashboard);
</script>

<template>
  <section class="page home-page">
    <div class="page-heading split"><div><span class="eyebrow">方案 A · Taste 编辑风格</span><h1>首页</h1><p>从真实播放会话、来源检测、预约和本机诊断汇总当前工作状态。</p></div><div class="toolbar-group"><span class="status-pill" :class="{ok:sourceHealthy}">{{sourceHealthy===null?'检测中':sourceHealthy?'来源引擎正常':'来源引擎异常'}}</span><button class="secondary-button" :disabled="refreshing" @click="loadDashboard">{{refreshing?'刷新中…':'刷新总览'}}</button><RouterLink class="primary-button" to="/sources">导入来源</RouterLink></div></div>
    <p v-if="actionMessage" class="error-banner">{{actionMessage}}</p>
    <section class="home-dashboard">
      <article class="panel continue-watch">
        <div class="panel-heading"><div><span class="panel-kicker">继续观看</span><h2>{{resumeItem?.videoName??'暂无可续播内容'}}</h2></div><RouterLink class="text-link" to="/history">全部历史</RouterLink></div>
        <template v-if="resumeItem"><div class="continue-body"><div class="continue-poster"><img v-if="resumeItem.poster" :src="resumeItem.poster" :alt="resumeItem.videoName+' 海报'"/><span v-else>▶</span></div><div><strong>{{resumeItem.episodeName}}</strong><small>{{resumeItem.sourceName}} · 已观看 {{formatDuration(resumeItem.position)}}</small><progress :value="resumeItem.position??0" :max="Math.max(1,resumeItem.duration??1)"/><span>{{Math.round(progress(resumeItem)*100)}}%</span></div></div><div class="row-actions"><button class="primary-button" :disabled="resuming" @click="resume">{{resuming?'正在打开…':'继续播放'}}</button><RouterLink class="secondary-button" to="/history">详情</RouterLink></div></template>
        <div v-else class="compact-empty">成功打开媒体后，会在这里显示真实续播进度。</div>
      </article>

      <article class="panel source-health-card"><div class="panel-heading"><div><span class="panel-kicker">来源健康</span><h2>{{healthySources}} / {{enabledSources}} 正常</h2></div><button class="icon-button" :disabled="refreshing" aria-label="刷新来源健康" title="刷新来源健康" @click="loadDashboard">↻</button></div><div class="health-visual"><div class="health-ring" :style="{'--score':sourceScore}"><strong>{{sourceScore}}</strong><small>综合分</small></div><dl><div><dt>响应正常</dt><dd>{{healthySources}}</dd></div><div><dt>需要处理</dt><dd :class="{danger:unhealthySources}">{{unhealthySources}}</dd></div><div><dt>已启用来源</dt><dd>{{enabledSources}}</dd></div></dl></div><RouterLink class="text-link" :to="unhealthySources?'/sources?filter=unhealthy':'/sources'">查看来源详情 →</RouterLink></article>

      <article class="panel reservation-card"><div class="panel-heading"><div><span class="panel-kicker">节目预约</span><h2>{{nextReservations.length?nextReservations.length+' 个即将开始':'暂无近期预约'}}</h2></div><b v-if="nextReservations.length" class="reservation-badge" :title="`${nextReservations.length} 个节目即将开始`">{{nextReservations.length}}</b><RouterLink class="text-link" to="/settings">管理预约</RouterLink></div><div v-if="nextReservations.length" class="appointment-list"><RouterLink v-for="item in nextReservations" :key="item.id" to="/settings"><time>{{new Date(item.start).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}}</time><div><strong>{{item.programTitle}}</strong><small>{{item.channelName}} · {{new Date(item.start).toLocaleDateString()}}</small></div></RouterLink></div><div v-else class="compact-empty">可在直播节目单中创建预约。</div></article>

      <article class="panel import-panel"><div class="panel-heading"><div><span class="panel-kicker">来源管理</span><h2>最近导入</h2></div><RouterLink class="text-link" to="/sources">查看全部</RouterLink></div><div v-if="importRecords.length" class="import-records"><RouterLink v-for="item in importRecords" :key="item.name+item.importedAt" to="/sources"><span>{{item.kind}}</span><div><strong>{{item.name}}</strong><small :title="item.source??''">{{item.source||`${item.count??0} 个来源`}}</small></div><time>{{new Date(item.importedAt).toLocaleDateString()}}</time></RouterLink></div><div v-else class="compact-empty">暂无导入记录。</div></article>

      <article class="panel version-panel"><span class="panel-kicker">当前版本</span><div class="version-number">V{{info?.version??'—'}}</div><p>{{update?.available?`发现新版本 ${update.latest}`:'当前已经是最新版本。'}}</p><small>上次检查：{{update?.checkedAt?new Date(update.checkedAt).toLocaleString():'尚未检查'}}</small><button class="secondary-button wide" :disabled="checkingUpdate" @click="checkUpdate">{{checkingUpdate?'检查中…':'检查更新'}}</button><RouterLink class="text-link" to="/settings?section=update">前往更新设置 →</RouterLink></article>

      <article class="panel diagnostic-card"><div class="panel-heading"><div><span class="panel-kicker">诊断摘要</span><h2>系统状态</h2></div><RouterLink class="text-link" to="/settings">查看报告</RouterLink></div><dl class="diagnostic-list"><RouterLink to="/settings"><dt>来源引擎</dt><dd :class="{good:sourceHealthy}">{{sourceHealthy?'正常':'异常'}}</dd></RouterLink><RouterLink to="/settings"><dt>数据库版本</dt><dd>V{{diagnostics.databaseVersion??'—'}}</dd></RouterLink><RouterLink to="/settings"><dt>缓存文件</dt><dd>{{diagnostics.cacheFiles??0}} 项</dd></RouterLink><RouterLink to="/settings"><dt>内存</dt><dd>{{diagnostics.memoryGB??'—'}} GB</dd></RouterLink></dl></article>

      <article class="panel decode-card"><div class="panel-heading"><div><span class="panel-kicker">播放能力</span><h2>解码与组件</h2></div><RouterLink class="text-link" to="/settings">详情</RouterLink></div><dl class="diagnostic-list"><div v-for="item in decodeItems" :key="item.label"><dt>{{item.label}}</dt><dd :title="item.value">{{item.value}}</dd></div></dl><small>仅显示诊断接口返回值，不以概念图示例冒充硬件能力。</small></article>
    </section>
  </section>
</template>

<style scoped>
.page-heading h1{margin-top:5px}.home-dashboard{display:grid;grid-template-columns:1.35fr .9fr .95fr;gap:12px}.continue-watch{min-height:260px;grid-row:span 1}.continue-body{display:grid;grid-template-columns:118px 1fr;gap:16px;align-items:center;margin:12px 0 18px}.continue-poster{height:150px;border-radius:7px;background:#34322e;color:#f7f2e8;display:grid;place-items:center;overflow:hidden}.continue-poster img{width:100%;height:100%;object-fit:cover}.continue-body>div:last-child{display:flex;flex-direction:column;gap:8px}.continue-body progress{width:100%;accent-color:var(--accent)}.health-visual{display:grid;grid-template-columns:108px 1fr;gap:15px;align-items:center;margin:9px 0 18px}.health-ring{--score:0;width:104px;height:104px;border:9px solid var(--accent-soft);outline:1px solid var(--line);border-radius:50%;display:grid;place-content:center;text-align:center;box-shadow:inset 0 0 0 1px var(--surface)}.health-ring strong{font:28px "Iowan Old Style","STSong",serif;color:var(--accent-strong)}.health-ring small{display:block}.health-visual dl{margin:0}.health-visual dl>div{display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid var(--line-soft)}.health-visual dt{color:var(--muted)}.health-visual dd{margin:0}.danger{color:var(--danger)}.appointment-list,.import-records{display:flex;flex-direction:column}.appointment-list>a,.import-records>a{display:grid;align-items:center;gap:10px;padding:10px 0;border-top:1px solid var(--line-soft)}.appointment-list>a{grid-template-columns:52px 1fr}.import-records>a{grid-template-columns:auto 1fr auto}.appointment-list time{font:18px "Iowan Old Style","STSong",serif;color:var(--accent-strong)}.appointment-list strong,.appointment-list small,.import-records strong,.import-records small{display:block}.import-records>a>span{font-size:10px;padding:3px 6px;border-radius:4px;background:var(--accent-soft);color:var(--accent-strong)}.import-records small{max-width:230px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.import-records time{font-size:10px;color:var(--muted)}.reservation-badge{display:grid;place-items:center;min-width:20px;height:20px;border-radius:999px;background:var(--danger);color:#fff;font-size:11px;font-weight:700;font-variant-numeric:tabular-nums}.version-panel{display:flex;flex-direction:column;align-items:center;gap:10px}.version-panel .version-number{margin:5px 0}.diagnostic-list>a{display:flex;justify-content:space-between;gap:16px;padding:8px 0;border-top:1px solid var(--line-soft)}.diagnostic-list>a:hover{color:var(--accent-strong)}.decode-card>small{display:block;margin-top:10px;line-height:1.5}@media(max-width:1180px){.home-dashboard{grid-template-columns:1fr 1fr}.continue-watch{grid-column:1/-1}}@media(max-width:820px){.home-dashboard{grid-template-columns:1fr}}
</style>

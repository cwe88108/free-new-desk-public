<script setup lang="ts">
import { computed,onBeforeUnmount,onMounted,ref } from 'vue';
import { useRouter } from 'vue-router';
import AppIcon from '../components/AppIcon.vue';
import {useSourceChanges} from '../source-changes';
import type { LiveSourceConfig,PlaybackHistoryEntry,ProgramReservation,SourceConfig,SourceHealth } from '@free-new-desk/contracts';
import { listVodFavorites,type VodFavorite } from '../favorites';
import { useToastStore } from '../stores/toast';
const toast=useToastStore();
useSourceChanges(refreshSourceSummary);
let sourceSummaryGeneration=0,dashboardGeneration=0,disposed=false;
onBeforeUnmount(()=>{disposed=true;sourceSummaryGeneration++;dashboardGeneration++;updateRequest++;});
async function refreshSourceSummary(){
  const generation=++sourceSummaryGeneration;
  const [point,live,status,settings]=await Promise.allSettled([window.desktop.source.list(),window.desktop.live.listSources(),window.desktop.source.health(),window.desktop.settings.list()]);
  if(disposed||generation!==sourceSummaryGeneration)return;
  if(point.status==='fulfilled')sources.value=point.value;
  if(live.status==='fulfilled')liveSources.value=live.value;
  if(status.status==='fulfilled')health.value=status.value;
  if(settings.status==='fulfilled')importRecords.value=parseImports(settings.value);
  const fallback=liveSources.value.filter(item=>item.importedAt).map(item=>({kind:item.origin==='local-file'?'本地直播':'网络直播',name:item.name,source:item.sourceLabel??item.endpoint,importedAt:item.importedAt!}));
  importRecords.value=[...importRecords.value,...fallback].sort((a,b)=>b.importedAt.localeCompare(a.importedAt)).filter((item,index,array)=>array.findIndex(other=>other.name===item.name&&other.importedAt===item.importedAt)===index).slice(0,5);
}

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
const updateError=ref('');let updateRequest=0;
const vodFavoriteCount=ref(0);
const liveFavoriteCount=ref(0);
const vodFavorites=ref<VodFavorite[]>([]);
const importRecords=ref<ImportRecord[]>([]);
const refreshing=ref(false);
const checkingUpdate=ref(false);
const resuming=ref(false);
const actionMessage=ref('');

const enabledSourceIds=computed(()=>new Set([...sources.value,...liveSources.value].filter(item=>item.enabled).map(item=>item.id)));
const enabledSources=computed(()=>enabledSourceIds.value.size);
const healthySources=computed(()=>health.value.filter(item=>item.ok&&enabledSourceIds.value.has(item.sourceId)).length);
const unhealthySources=computed(()=>Math.max(0,enabledSources.value-healthySources.value));
const resumeItem=computed(()=>recent.value.find(item=>item.flag!==undefined&&item.episodeId));
const nextReservations=computed(()=>reservations.value.filter(item=>Date.parse(item.start)>=Date.now()).sort((a,b)=>a.start.localeCompare(b.start)).slice(0,3));
const sourceScore=computed(()=>health.value.length?Math.round(health.value.reduce((sum,item)=>sum+item.score,0)/health.value.length):0);
const recentCards=computed(()=>recent.value.slice(0,4));
const favoriteCards=computed(()=>vodFavorites.value.slice(0,5));
const greeting=computed(()=>{const hour=new Date().getHours();if(hour<5)return'夜深了';if(hour<11)return'早上好';if(hour<14)return'午间安好';if(hour<18)return'下午好';return'晚间安好';});
function parseImports(settings:Record<string,string>):ImportRecord[]{try{const value=JSON.parse(settings['imports.recent']??'[]') as unknown;return Array.isArray(value)?value.filter((item):item is ImportRecord=>Boolean(item&&typeof item==='object'&&typeof(item as ImportRecord).name==='string'&&typeof(item as ImportRecord).importedAt==='string')).slice(0,6):[];}catch{return[];}}
function progress(item:PlaybackHistoryEntry|undefined){return item?.duration?Math.min(1,Math.max(0,(item.position??0)/item.duration)):0;}
function formatDuration(value:number|undefined){const minutes=Math.max(0,Math.round((value??0)/60));return minutes>=60?`${Math.floor(minutes/60)} 小时 ${minutes%60} 分钟`:`${minutes} 分钟`;}
async function loadDashboard(){
  const generation=++dashboardGeneration,updateId=++updateRequest;
  const current=()=>!disposed&&generation===dashboardGeneration;
  checkingUpdate.value=true;refreshing.value=true;actionMessage.value='';
  // Runtime probes and network updates settle independently of local library data.
  void window.desktop.source.ping().then(ok=>{if(current())sourceHealthy.value=ok;},()=>{if(current())sourceHealthy.value=false;});
  void window.desktop.diagnostics.dashboard().then(value=>{if(current())diagnostics.value=value;},()=>{});
  void window.desktop.update.check().then(value=>{if(current()&&updateId===updateRequest){update.value=value;updateError.value='';}},error=>{if(current()&&updateId===updateRequest){update.value=null;updateError.value=String(error?.message??'更新检查失败');}}).finally(()=>{if(current()&&updateId===updateRequest)checkingUpdate.value=false;});
  const summary=refreshSourceSummary();
  const results=await Promise.allSettled([window.desktop.app.getInfo(),window.desktop.history.list(8),window.desktop.reservation.list(),listVodFavorites(),window.desktop.live.favorites()]);
  if(!current())return;
  if(results[0]?.status==='fulfilled')info.value=results[0].value;
  if(results[1]?.status==='fulfilled')recent.value=results[1].value;
  if(results[2]?.status==='fulfilled')reservations.value=results[2].value;
  if(results[3]?.status==='fulfilled'){vodFavorites.value=results[3].value;vodFavoriteCount.value=results[3].value.length;}
  if(results[4]?.status==='fulfilled')liveFavoriteCount.value=results[4].value.length;
  await summary;if(!current())return;
  refreshing.value=false;
}
function canResume(item:PlaybackHistoryEntry|undefined):item is PlaybackHistoryEntry{return Boolean(item?.sourceId&&item.videoId&&item.flag!==undefined&&item.episodeId);}
async function resume(item?:PlaybackHistoryEntry){
  const target=item??resumableFirst.value;if(!target)return;
  resuming.value=true;actionMessage.value='';
  try{const played=await window.desktop.playback.play({sourceId:target.sourceId,videoId:target.videoId,videoName:target.videoName,flag:target.flag??'',episodeId:target.episodeId!,episodeName:target.episodeName,...(target.poster?{poster:target.poster}:{}),...(target.episodes?.length?{episodeListJson:JSON.stringify(target.episodes)}:{})});if((target.position??0)>5){if(!played.session)throw new Error('播放回执缺少会话身份，已取消定位');await window.desktop.playback.control({command:'seek',value:target.position??0,absolute:true,requestId:played.session.requestId,loadId:played.session.loadId})};await router.push('/player');}
  catch(value){actionMessage.value=`无法继续播放：${value instanceof Error?value.message:String(value)}`;toast.error('无法继续播放',actionMessage.value);}finally{resuming.value=false;}
}
const resumableFirst=computed(()=>recent.value.find(item=>item.flag!==undefined&&item.episodeId)??recent.value[0]);
async function checkUpdate(){const request=++updateRequest;checkingUpdate.value=true;update.value=null;updateError.value='';try{const result=await window.desktop.update.check();if(!disposed&&request===updateRequest){update.value=result;toast.success(result.available?`发现新版本 ${result.latest}`:'已是最新版本');}}catch(value){if(!disposed&&request===updateRequest){updateError.value=value instanceof Error?value.message:String(value);toast.error('更新检查失败',updateError.value);}}finally{if(!disposed&&request===updateRequest)checkingUpdate.value=false;}}
onMounted(loadDashboard);
</script>

<template>
  <section class="page home-page">
    <div class="greet-row">
      <div>
        <h1>{{greeting}}，看点什么？</h1>
        <p class="greet-sub"><template v-if="resumeItem"><b>{{resumeItem.videoName}}</b> {{resumeItem.episodeName}} 看到第 {{Math.round(progress(resumeItem)*100)}}%，随时继续。</template><template v-else>从真实播放会话、来源检测与预约中汇总当前状态。</template></p>
      </div>
      <div class="toolbar-group">
        <RouterLink class="secondary-button" to="/search"><AppIcon name="nav-search" :size="15"/> 搜索</RouterLink>
        <span class="status-pill" :class="{ok:sourceHealthy}">{{sourceHealthy===null?'检测中':sourceHealthy?'来源引擎正常':'来源引擎异常'}}</span>
        <button class="secondary-button" :disabled="refreshing" @click="loadDashboard">{{refreshing?'刷新中…':'刷新'}}</button>
        <RouterLink class="primary-button" to="/sources">导入来源</RouterLink>
      </div>
    </div>
    <p v-if="actionMessage" class="error-banner">{{actionMessage}}</p>

    <section class="home-portal">
      <div class="portal-main">
        <div class="sec-head"><h2>继续观看</h2><RouterLink class="text-link" to="/history">全部历史<AppIcon name="action-enter" :size="13"/></RouterLink></div>
        <div v-if="recentCards.length" class="resume-row home-module-body">
          <article v-for="item in recentCards" :key="item.id" class="resume-card">
            <RouterLink class="resume-thumb" :to="{path:'/vod',query:{...(item.sourceId?{source:item.sourceId}:{}),...(item.videoId?{video:item.videoId}:{})}}" :aria-label="`查看 ${item.videoName} 详情`">
              <img v-if="item.poster" :src="item.poster" :alt="item.videoName+' 海报'" loading="lazy"/>
              <span v-else class="resume-fallback"><AppIcon name="player-play" :size="16"/></span>
              <span class="resume-ep">{{item.episodeName||item.videoName}}</span>
              <span class="resume-progress"><i :style="{width:Math.round(progress(item)*100)+'%'}"/></span>
            </RouterLink>
            <div class="resume-meta">
              <div class="resume-copy"><strong :title="item.videoName">{{item.videoName}}</strong><small>{{item.sourceName}} · 已看 {{formatDuration(item.position)}}</small></div>
              <button class="play-fab" :disabled="resuming||!canResume(item)" :title="canResume(item)?'从上次进度继续播放':'旧记录缺少续播参数'" @click="resume(item)"><AppIcon name="player-play" :size="20"/></button>
            </div>
          </article>
        </div>
        <div v-else class="compact-empty home-module-body"><AppIcon name="player-play" :size="28"/>成功打开媒体后，会在这里显示真实续播进度。</div>

        <div class="sec-head"><h2>我的收藏</h2><RouterLink class="text-link" to="/favorites">收藏管理<AppIcon name="action-enter" :size="13"/></RouterLink></div>
        <div v-if="favoriteCards.length" class="follow-row home-module-body">
          <RouterLink v-for="item in favoriteCards" :key="item.sourceId+'\u0000'+item.videoId" class="follow-card" to="/favorites">
            <span class="fposter"><img v-if="item.poster" :src="item.poster" :alt="(item.label??item.name)+' 海报'" loading="lazy"/><b v-else>{{(item.label??item.name).slice(0,1)}}</b></span>
            <span class="follow-meta"><strong :title="item.label??item.name">{{item.label??item.name}}</strong><small>{{item.sourceName}}{{item.remark?` · ${item.remark}`:''}}</small></span>
          </RouterLink>
        </div>
        <div v-else class="compact-empty home-module-body"><AppIcon name="nav-star" :size="28"/>还没有点播收藏；在点播或搜索页可以把常看的内容收藏到这里。</div>
        <slot name="mini-player" :history="recent"/>
      </div>

      <aside class="portal-rail">
        <article class="panel source-health-card">
          <div class="panel-heading"><div><span class="panel-kicker">系统状态</span><h2>{{healthySources}} / {{enabledSources}} 来源正常</h2></div><button class="icon-button" :disabled="refreshing" aria-label="刷新来源健康" title="刷新来源健康" @click="loadDashboard"><AppIcon name="action-refresh" :size="16"/></button></div>
          <div class="health-visual">
            <div class="score-ring" :style="{'--score':sourceScore,'--ring-color':sourceScore>=80?'var(--good)':sourceScore>=50?'var(--gold)':'var(--danger)'}"><i><div><b>{{sourceScore}}</b><small>综合分</small></div></i></div>
            <dl>
              <div><dt>需要处理</dt><dd :class="{danger:unhealthySources}">{{unhealthySources}}</dd></div>
              <div><dt>硬件解码</dt><dd>{{String(diagnostics.hardwareDecode??'待播放检测')}}</dd></div>
              <div><dt>缓存文件</dt><dd>{{diagnostics.cacheFiles??0}} 项</dd></div>
              <div><dt>内存</dt><dd>{{diagnostics.memoryGB??'—'}} GB</dd></div>
            </dl>
          </div>
          <RouterLink class="text-link" :to="unhealthySources?'/sources?filter=unhealthy':'/sources'">查看来源详情<AppIcon name="action-enter" :size="13"/></RouterLink>
        </article>

        <article class="panel reservation-card">
          <div class="panel-heading"><div><span class="panel-kicker">预约提醒</span><h2>{{nextReservations.length?nextReservations.length+' 个即将开始':'暂无近期预约'}}</h2></div><b v-if="nextReservations.length" class="reservation-badge" :title="`${nextReservations.length} 个节目即将开始`">{{nextReservations.length}}</b><RouterLink class="text-link" to="/settings">管理</RouterLink></div>
          <div v-if="nextReservations.length" class="appointment-list"><RouterLink v-for="item in nextReservations" :key="item.id" to="/settings"><time>{{new Date(item.start).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}}</time><div><strong>{{item.programTitle}}</strong><small>{{item.channelName}} · {{new Date(item.start).toLocaleDateString()}}</small></div></RouterLink></div>
          <div v-else class="compact-empty">可在直播节目单中创建预约。</div>
        </article>

        <article class="panel version-panel">
          <div class="panel-heading"><div><span class="panel-kicker">版本与更新</span><h2>V{{info?.version??'—'}}</h2></div></div>
          <p class="version-line">{{checkingUpdate?'正在检查更新…':updateError?'检查失败：'+updateError:update?(update.available?`发现新版本 ${update.latest}`:'上次检查未发现更新。'):'尚未检查更新。'}}</p>
          <div class="row-actions"><button class="secondary-button" :disabled="checkingUpdate" @click="checkUpdate">{{checkingUpdate?'检查中…':'检查更新'}}</button><RouterLink class="text-link" to="/settings?section=update">更新设置 →</RouterLink></div>
          <small v-if="importRecords.length" class="import-line">最近导入：{{importRecords[0]!.name}} · <RouterLink to="/sources">全部记录</RouterLink></small>
        </article>
      </aside>
    </section>
  </section>
</template>

<style scoped>
.greet-row{display:flex;align-items:flex-end;justify-content:space-between;gap:20px;margin-bottom:18px}
.greet-row h1{font-size:calc(28px * var(--font-scale))}
.greet-sub{margin-top:7px;color:var(--muted);line-height:1.6}
.greet-sub b{color:var(--accent-strong);font-weight:600}
.sec-head{display:flex;align-items:baseline;justify-content:space-between;margin:0 0 11px}
.sec-head h2{font-size:calc(18px * var(--font-scale))}
.home-portal{--home-module-height:160px;display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:16px;align-items:start}
.portal-main{min-width:0;display:flex;flex-direction:column;gap:6px}
.portal-rail{display:flex;flex-direction:column;gap:12px}
.resume-row{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-bottom:16px}
.resume-card{border:1px solid var(--line);border-radius:var(--radius-m);background:var(--surface);box-shadow:var(--shadow);overflow:hidden;transition:transform .16s ease,box-shadow .16s ease}
.resume-card:hover{transform:translateY(-2px);box-shadow:var(--shadow-md)}
.resume-thumb{position:relative;display:block;height:calc(var(--home-module-height) - 82px);background:#34322e;overflow:hidden}
.resume-thumb img{width:100%;height:100%;object-fit:cover;display:block}
.resume-fallback{position:absolute;inset:0;display:grid;place-items:center;color:#f7f2e8;font-size:20px}
.resume-ep{position:absolute;top:8px;left:8px;right:8px;font-size:10.5px;color:#f3ecdd;background:rgba(20,18,14,.62);padding:3px 8px;border-radius:999px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.resume-progress{position:absolute;left:0;right:0;bottom:0;height:4px;background:rgba(255,255,255,.24)}
.resume-progress i{position:absolute;left:0;top:0;bottom:0;background:var(--accent)}
.resume-meta{display:flex;align-items:center;gap:8px;padding:9px 11px 10px}
.resume-copy{min-width:0;flex:1}
.resume-copy strong{display:block;font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.resume-copy small{display:block;color:var(--muted);font-size:10.5px;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.play-fab{width:28px;height:28px;flex:none;border:0;border-radius:50%;background:var(--accent);color:#fff;font-size:10px;display:grid;place-items:center}
.play-fab:hover:not(:disabled){background:var(--accent-strong)}
.follow-row{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:12px}
.follow-card{border:1px solid var(--line);border-radius:var(--radius-m);background:var(--surface);overflow:hidden;transition:transform .16s ease,box-shadow .16s ease}
.follow-card:hover{transform:translateY(-2px);box-shadow:var(--shadow-md)}
.fposter{position:relative;display:grid;place-items:center;height:calc(var(--home-module-height) - 82px);background:var(--surface-2);overflow:hidden}
.fposter img{width:100%;height:100%;object-fit:cover}
.fposter b{font:26px "Iowan Old Style","STSong",serif;color:var(--accent-strong)}
.follow-meta{display:block;padding:8px 10px 10px}
.follow-meta strong{display:block;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.follow-meta small{display:block;color:var(--muted);font-size:10px;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.health-visual{display:grid;grid-template-columns:96px 1fr;gap:15px;align-items:center;margin:6px 0 12px}
.health-visual dl{margin:0}
.health-visual dl>div{display:flex;justify-content:space-between;gap:10px;padding:6px 0;border-bottom:1px solid var(--line-soft)}
.health-visual dt{color:var(--muted);font-size:12px}
.health-visual dd{margin:0;font-size:12px}
.danger{color:var(--danger)}
.appointment-list>a{display:grid;grid-template-columns:52px 1fr;align-items:center;gap:10px;padding:9px 0;border-top:1px solid var(--line-soft)}
.appointment-list time{font:17px "Iowan Old Style","STSong",serif;color:var(--accent-strong)}
.appointment-list strong,.appointment-list small{display:block}
.appointment-list small{color:var(--muted);font-size:11px}
.reservation-badge{font-size:10px;min-width:18px;text-align:center;padding:2px 7px;border-radius:999px;background:var(--accent);color:#fff}
.version-line{color:var(--muted);margin:2px 0 10px;line-height:1.55}
.import-line{display:block;margin-top:10px;color:var(--muted)}
.home-module-body{height:var(--home-module-height);min-height:var(--home-module-height);margin:0 0 10px;box-sizing:border-box}
.resume-row.home-module-body,.follow-row.home-module-body{border:1px solid var(--line);border-radius:var(--radius-m);background:var(--surface);padding:12px;overflow:hidden}.compact-empty.home-module-body{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;padding:20px;text-align:center}
.compact-empty.home-module-body svg{color:var(--accent);background:var(--accent-soft);box-sizing:content-box;padding:14px;border-radius:50%}
.resume-card,.follow-card{height:100%;min-width:0;box-sizing:border-box}
@media(max-width:1180px){.home-portal{grid-template-columns:1fr}.resume-row{height:auto;grid-template-columns:repeat(2,1fr)}.follow-row{grid-template-columns:repeat(5,1fr)}}
@media(max-width:980px){.resume-row{grid-template-columns:1fr}.follow-row{height:auto;grid-template-columns:repeat(3,1fr)}.greet-row{flex-direction:column;align-items:flex-start}}
</style>

<script setup lang="ts">
import { computed,onMounted,ref } from 'vue';
import { useRouter } from 'vue-router';
import type { PlaybackHistoryEntry } from '@free-new-desk/contracts';

type SortMode='recent'|'name'|'progress';
const router=useRouter();
const history=ref<PlaybackHistoryEntry[]>([]);
const query=ref('');
const source=ref('all');
const sort=ref<SortMode>('recent');
const selecting=ref(false);
const selected=ref(new Set<string>());
const busyId=ref('');
const error=ref('');

const sources=computed(()=>[...new Map(history.value.map(item=>[item.sourceId,item.sourceName])).entries()]);
const visible=computed(()=>{
  const needle=query.value.trim().toLowerCase();
  const rows=history.value.filter(item=>(source.value==='all'||item.sourceId===source.value)&&(!needle||`${item.videoName} ${item.episodeName} ${item.sourceName}`.toLowerCase().includes(needle)));
  return [...rows].sort((a,b)=>sort.value==='name'?a.videoName.localeCompare(b.videoName,'zh-CN'):sort.value==='progress'?progress(b)-progress(a):b.playedAt.localeCompare(a.playedAt));
});
const latest=computed(()=>history.value.find(canResume));
const totalSeconds=computed(()=>history.value.reduce((sum,item)=>sum+(item.position??0),0));
const commonSource=computed(()=>{const count=new Map<string,{name:string,count:number}>();for(const item of history.value){const value=count.get(item.sourceId)??{name:item.sourceName,count:0};value.count+=1;count.set(item.sourceId,value);}return [...count.entries()].sort((a,b)=>b[1].count-a[1].count)[0];});

function formatTime(value:number|undefined){const total=Math.max(0,Math.floor(value??0));const h=Math.floor(total/3600),m=Math.floor((total%3600)/60),s=total%60;return(h?h.toString().padStart(2,'0')+':':'')+m.toString().padStart(2,'0')+':'+s.toString().padStart(2,'0');}
function progress(item:PlaybackHistoryEntry){return item.duration?Math.min(1,Math.max(0,(item.position??0)/item.duration)):0;}
function canResume(item:PlaybackHistoryEntry|undefined):item is PlaybackHistoryEntry{return Boolean(item?.sourceId&&item.videoId&&item.flag!==undefined&&item.episodeId);}
function toggle(id:string){const next=new Set(selected.value);next.has(id)?next.delete(id):next.add(id);selected.value=next;}
async function reload(){history.value=await window.desktop.history.list(200);}
async function resume(item:PlaybackHistoryEntry){if(!canResume(item))return;busyId.value=item.id;error.value='';try{await window.desktop.playback.play({sourceId:item.sourceId,videoId:item.videoId,videoName:item.videoName,flag:item.flag??'',episodeId:item.episodeId!,episodeName:item.episodeName,...(item.poster?{poster:item.poster}:{}),...(item.episodes?.length?{episodeListJson:JSON.stringify(item.episodes)}:{})});if((item.position??0)>5)await window.desktop.playback.control({command:'seek',value:item.position??0,absolute:true});await router.push('/player');}catch(value){error.value=`无法继续播放：${value instanceof Error?value.message:String(value)}`;}finally{busyId.value='';}}
async function playFromStart(item:PlaybackHistoryEntry){if(!canResume(item))return;busyId.value=item.id;error.value='';try{await window.desktop.playback.play({sourceId:item.sourceId,videoId:item.videoId,videoName:item.videoName,flag:item.flag??'',episodeId:item.episodeId!,episodeName:item.episodeName,...(item.poster?{poster:item.poster}:{}),...(item.episodes?.length?{episodeListJson:JSON.stringify(item.episodes)}:{})});await window.desktop.playback.control({command:'seek',value:0,absolute:true});await router.push('/player');}catch(value){error.value=`无法从头播放：${value instanceof Error?value.message:String(value)}`;}finally{busyId.value='';}}
function openDetail(item:PlaybackHistoryEntry){if(!item.sourceId||!item.videoId)return;void router.push({path:'/vod',query:{source:item.sourceId,video:item.videoId}});}
async function cleanCorrupted(){const corrupted=history.value.filter(item=>!(item.sourceId&&item.videoId&&item.flag!==undefined&&item.episodeId));if(!corrupted.length){error.value='没有发现损坏的历史记录。';return;}if(!window.confirm(`检测到 ${corrupted.length} 条损坏记录（缺少来源/剧集参数，无法续播），是否删除？`))return;for(const item of corrupted)await window.desktop.history.remove(item.id);error.value=`已清理 ${corrupted.length} 条损坏记录。`;await reload();}
async function removeOne(id:string){await window.desktop.history.remove(id);selected.value.delete(id);await reload();}
async function removeSelected(){if(!selected.value.size||!window.confirm(`确认删除选中的 ${selected.value.size} 条播放记录？`))return;for(const id of selected.value)await window.desktop.history.remove(id);selected.value=new Set();selecting.value=false;await reload();}
async function clearAll(){if(!history.value.length||!window.confirm('确认清空全部播放历史？收藏、来源与预约不会被删除。'))return;await window.desktop.history.clear();selected.value=new Set();await reload();}
async function cleanDuplicates(){const seen=new Set<string>();const duplicates=history.value.filter(item=>{const key=`${item.sourceId}\u0000${item.videoId}\u0000${item.episodeId??item.episodeName}`;if(seen.has(key))return true;seen.add(key);return false;});if(!duplicates.length){error.value='未发现重复记录。';return;}if(!window.confirm(`检测到 ${duplicates.length} 条重复记录，是否保留每组最新一条？`))return;for(const item of duplicates)await window.desktop.history.remove(item.id);error.value=`已清理 ${duplicates.length} 条重复记录。`;await reload();}
onMounted(reload);
</script>

<template>
  <section class="page history-page">
    <div class="page-heading split"><div><h1>播放历史</h1><p>继续观看、筛选和清理本机播放记录；播放进度来自 PlayerHost 的真实状态。</p></div><span class="count-label">{{visible.length}} / {{history.length}} 条</span></div>
    <div class="history-toolbar">
      <div class="segmented"><button class="active">全部</button><button disabled title="直播播放记录将在直播历史模型落库后启用">点播</button><button disabled title="直播播放记录将在直播历史模型落库后启用">直播</button></div>
      <div class="search-box"><span>⌕</span><input v-model="query" maxlength="100" placeholder="搜索标题、剧集或来源" aria-label="搜索播放历史"/></div>
      <select v-model="source" aria-label="历史来源筛选"><option value="all">全部来源</option><option v-for="item in sources" :key="item[0]" :value="item[0]">{{item[1]}}</option></select>
      <select v-model="sort" aria-label="历史排序"><option value="recent">最近观看</option><option value="name">名称</option><option value="progress">观看进度</option></select>
      <button class="secondary-button" @click="selecting=!selecting;selected=new Set()">{{selecting?'退出选择':'选择'}}</button>
      <button v-if="selecting" class="danger-button" :disabled="!selected.size" @click="removeSelected">删除所选</button>
      <button class="text-link danger-text" :disabled="!history.length" @click="clearAll">清空历史</button>
    </div>
    <p v-if="error" class="status-line">{{error}}</p>
    <div v-if="history.length" class="history-workspace">
      <section class="panel history-table-panel">
        <div class="history-table-head"><span>内容</span><span>来源</span><span>观看进度</span><span>播放时间</span><span>操作</span></div>
        <article v-for="item in visible" :key="item.id" class="history-table-row">
          <label v-if="selecting" class="history-check"><input type="checkbox" :checked="selected.has(item.id)" @change="toggle(item.id)"/><span class="sr-only">选择 {{item.videoName}}</span></label>
          <div class="history-media"><div class="history-thumb"><img v-if="item.poster" :src="item.poster" :alt="item.videoName+' 海报'"/><span v-else>▶</span></div><div><strong>{{item.videoName}}</strong><small>{{item.episodeName}}</small></div></div>
          <span>{{item.sourceName}}</span>
          <span class="history-progress"><progress :value="item.position??0" :max="Math.max(1,item.duration??1)" :aria-label="`${item.videoName} 观看进度`"/><small>{{formatTime(item.position)}} / {{formatTime(item.duration)}} · {{Math.round(progress(item)*100)}}%</small></span>
          <time>{{new Date(item.playedAt).toLocaleString()}}</time>
          <span class="history-actions"><button class="secondary-button" :disabled="!canResume(item)||busyId===item.id" :title="canResume(item)?'从上次进度继续播放':'旧记录缺少来源解析参数，无法续播'" @click="resume(item)">{{busyId===item.id?'打开中…':'继续播放'}}</button><details class="row-more"><summary aria-label="更多操作">…</summary><button @click="playFromStart(item)">从头播放</button><button @click="openDetail(item)">详情</button><button class="danger-link" @click="removeOne(item.id)">删除</button></details></span>
        </article>
        <div v-if="!visible.length" class="compact-empty">没有符合当前筛选条件的记录。</div>
      </section>
      <aside class="history-insights">
        <article class="panel continue-card"><span class="panel-kicker">继续观看</span><template v-if="latest"><h2>{{latest.videoName}}</h2><p>{{latest.episodeName}} · {{Math.round(progress(latest)*100)}}%</p><progress :value="latest.position??0" :max="Math.max(1,latest.duration??1)"/><button class="primary-button wide" :disabled="busyId===latest.id" @click="resume(latest)">继续播放</button></template><p v-else>暂无可恢复的播放记录。</p></article>
        <article class="panel"><div class="panel-heading"><div><span class="panel-kicker">本机统计</span><h2>观看概览</h2></div></div><dl class="info-list"><div><dt>累计进度</dt><dd>{{formatTime(totalSeconds)}}</dd></div><div><dt>记录条数</dt><dd>{{history.length}}</dd></div><div><dt>常用来源</dt><dd>{{commonSource?.[1].name??'—'}}</dd></div></dl></article>
        <article class="panel"><div class="panel-heading"><div><span class="panel-kicker">数据维护</span><h2>清理记录</h2></div></div><p class="muted-copy">先预览重复项数量，再执行本机数据库清理。</p><button class="secondary-button wide" @click="cleanDuplicates">清理重复记录</button><button class="secondary-button wide" @click="cleanCorrupted">清理损坏记录</button></article>
      </aside>
    </div>
    <div v-else class="empty-state"><div class="empty-icon">◷</div><h3>还没有播放记录</h3><p>媒体实际打开成功后才会写入这里。</p><RouterLink class="primary-button" to="/vod">浏览点播</RouterLink></div>
  </section>
</template>

<style scoped>
.history-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:14px}.history-toolbar .search-box{margin-left:auto}.history-workspace{display:grid;grid-template-columns:minmax(0,1fr) 285px;gap:12px}.history-table-head,.history-table-row{grid-template-columns:minmax(220px,1.5fr) minmax(95px,.55fr) minmax(145px,.75fr) minmax(130px,.7fr) minmax(140px,.7fr)}.history-table-row{position:relative}.history-table-row:has(.history-check){padding-left:42px}.history-check{position:absolute;left:15px}.history-progress{display:flex;flex-direction:column;gap:4px}.history-progress progress,.continue-card progress{width:100%;accent-color:var(--accent)}.history-actions{display:flex;align-items:center;gap:9px}.history-actions .secondary-button{min-height:30px;padding:0 10px}.row-more{position:relative}.row-more summary{cursor:pointer;list-style:none;border:1px solid var(--line);border-radius:6px;min-width:28px;text-align:center}.row-more[open]{display:flex;gap:4px}.row-more button{font-size:11px}.row-more .danger-link{color:var(--danger)}.history-insights{display:flex;flex-direction:column;gap:10px}.continue-card h2{margin:10px 0 5px}.continue-card p,.muted-copy{color:var(--muted);line-height:1.55}.continue-card progress{margin:14px 0}.danger-text{color:var(--danger)}.history-thumb img{width:100%;height:100%;object-fit:cover}@media(max-width:1180px){.history-workspace{grid-template-columns:1fr}.history-insights{display:grid;grid-template-columns:repeat(3,1fr)}}
</style>

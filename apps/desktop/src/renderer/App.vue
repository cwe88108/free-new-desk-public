<script setup lang="ts">
import { computed,onBeforeUnmount,onMounted,ref,watch } from 'vue';
import {clockRuntime} from './stores/playback-session';
import {nowPlayingTitle} from './now-playing-title';
import type {PlaybackHistoryEntry} from '@free-new-desk/contracts';
import { useRoute,useRouter } from 'vue-router';
import {startMusicPlaybackController,stopMusicPlaybackController,clockStats,clockStale,refreshPlaybackClock} from './stores/music-playback.js';
import { useToastStore } from './stores/toast';
import appIconUrl from './assets/app-icon.png';
import ToastHost from './components/ToastHost.vue';
import {usePageStateStore} from './stores/page-state';
import CommandPalette from './components/CommandPalette.vue';
import AppIcon from './components/AppIcon.vue';

const route=useRoute();
const router=useRouter();
const version=ref('');
const isPackaged=ref(false);
const sourceHealthy=ref<boolean|null>(null);
const navigatingPath=ref('');
const menuOpen=ref(false);
const renderMode=ref(localStorage.getItem('player.hwdec')==='off'?'软件解码（CPU）':'硬件加速（GPU）');
const playerStats=clockStats;
const playerReachable=computed(()=>!clockStale.value&&clockStats.value?.sampleFresh===true);
let removeSourcesListener:(()=>void)|undefined;
let removeHealthListener:(()=>void)|undefined;
let removeNavigateListener:(()=>void)|undefined;
let renderModeListener:((event:Event)=>void)|undefined;
const toast=useToastStore();
const items=[
  {key:'home',path:'/',label:'首页',icon:'nav-home'},
  {key:'vod',path:'/vod',label:'点播',icon:'nav-vod'},
  {key:'live',path:'/live',label:'直播',icon:'nav-live'},
  {key:'player',path:'/player',label:'播放器',icon:'nav-player'},
  {key:'music',path:'/music',label:'音乐',icon:'nav-music'}
] as const;
const myItems=[
  {key:'search',path:'/search',label:'搜索',icon:'nav-search'},
  {key:'favorites',path:'/favorites',label:'收藏',icon:'nav-star'},
  {key:'history',path:'/history',label:'历史',icon:'nav-clock'}
] as const;
const systemItems=[
  {key:'sources',path:'/sources',label:'来源',icon:'nav-layers'},
  {key:'settings',path:'/settings',label:'设置',icon:'nav-settings'}
] as const;
const current=computed(()=>route.path);
async function navigate(path:string){if(navigatingPath.value||current.value===path)return;navigatingPath.value=path;const started=performance.now();try{await router.push(path);const elapsed=performance.now()-started;void window.desktop.diagnostics.recordPerformance('navigationMs',elapsed).catch(()=>false);if(window.desktop.app.isUiSmoke()&&elapsed>100)throw new Error(`Navigation exceeded 100ms budget: ${path} ${elapsed.toFixed(1)}ms`);}finally{requestAnimationFrame(()=>{navigatingPath.value='';});}}
async function appAction(action:'reload'|'devtools'|'quit'){menuOpen.value=false;await window.desktop.app.action(action);}
async function refreshPlayer(){await refreshPlaybackClock().catch(()=>undefined);}
async function playerControl(command:'pause'|'mute',value:boolean){await window.desktop.playback.control({command,value});await refreshPlayer();}
async function setVolume(event:Event){const value=Number((event.target as HTMLInputElement).value);await window.desktop.playback.control({command:'volume',value});await refreshPlayer();}
const mediaStatus=computed(()=>{
  const status=clockRuntime.value.status;
  if(status==='ended')return '播放结束';
  if(status==='failed')return '播放失败';
  if(status==='loading')return '正在连接';
  if(status==='stopped')return '已停止';
  if(!playerReachable.value)return '播放器未连接';
  return playerStats.value?.duration||playerStats.value?.path?(playerStats.value?.paused?'已暂停':'播放中'):'空闲';
});
const nowPlayingHistory=ref<PlaybackHistoryEntry|null>(null);
watch([()=>clockRuntime.value.requestId,()=>clockRuntime.value.historyId],async(_value,_old,onCleanup)=>{
  let active=true;onCleanup(()=>{active=false;});nowPlayingHistory.value=null;
  const {historyId,domain}=clockRuntime.value;if(domain!=='vod'||!historyId)return;
  try{const rows=await window.desktop.history.list(200);if(active)nowPlayingHistory.value=rows.find(item=>item.id===historyId)??null;}catch{/* Playback does not depend on presentation metadata. */}
},{immediate:true});
const nowPlayingName=computed(()=>nowPlayingTitle(playerStats.value?.path,nowPlayingHistory.value,clockRuntime.value));
const nowPlayingVisible=computed(()=>Boolean(playerReachable.value&&playerStats.value?.path));
function focusPageSearch(event:KeyboardEvent){if(!(event.ctrlKey||event.metaKey)||event.key.toLowerCase()!=='f')return;const target=event.target as HTMLElement|null;if(target&&['INPUT','SELECT','TEXTAREA'].includes(target.tagName))return;const input=document.querySelector<HTMLElement>('.content [data-search-input]:not([disabled])');if(!input)return;event.preventDefault();menuOpen.value=false;input.focus();input.scrollIntoView({block:'nearest'});}

onMounted(async()=>{
  const pageState=usePageStateStore();
  removeSourcesListener=window.desktop.source.onChanged(()=>{for(const key of ['vod','live','search'])pageState.clear(key);});
  startMusicPlaybackController();
  try{const info=await window.desktop.app.getInfo();version.value=info.version;isPackaged.value=info.packaged;}catch{/* keep the version unconfirmed if runtime information is unavailable */}
  void window.desktop.source.ping().then(ok=>{sourceHealthy.value=ok;},()=>{sourceHealthy.value=false;});
  removeHealthListener=window.desktop.source.onHealthChanged(value=>{sourceHealthy.value=value.ok;});
  removeNavigateListener=window.desktop.app.onNavigate(path=>{void router.push(path);});
  renderModeListener=(event:Event)=>{const value=(event as CustomEvent<string>).detail;renderMode.value=value==='no'?'软件解码（CPU）':'硬件加速（GPU）';};
  window.addEventListener('fnd:render-mode',renderModeListener);
  window.addEventListener('keydown',focusPageSearch);
  await refreshPlayer();
});
onBeforeUnmount(()=>{stopMusicPlaybackController();removeSourcesListener?.();removeHealthListener?.();removeNavigateListener?.();if(renderModeListener)window.removeEventListener('fnd:render-mode',renderModeListener);window.removeEventListener('keydown',focusPageSearch);});
</script>

<template>
  <div class="app-shell">
    <header class="titlebar">
      <div class="app-brand">
        <img class="brand-mark" :src="appIconUrl" alt="" aria-hidden="true"/>
        <strong>Free New Desk</strong>
      </div><div class="title-actions"><button class="title-menu-button" aria-label="扩展菜单" :aria-expanded="menuOpen" @click="menuOpen=!menuOpen"><AppIcon name="action-more" :size="18"/></button><div v-if="menuOpen" class="title-menu"><button @click="appAction('reload')">刷新界面</button><button v-if="!isPackaged" @click="appAction('devtools')">开发者工具</button><button @click="appAction('quit')">退出应用</button></div></div>
    </header>

    <aside class="navigation" aria-label="主导航">
      <nav class="nav-stack">
        <div class="nav-section">内 容</div>
        <button v-for="item in items" :key="item.path" class="nav-item" :data-smoke-key="item.key" :class="{active:current===item.path}" :disabled="navigatingPath===item.path" :aria-busy="navigatingPath===item.path" @click="navigate(item.path)">
          <AppIcon class="nav-icon" :name="item.icon" :size="20"/>
          <span>{{item.label}}</span>
        </button>
        <div class="nav-section">我 的</div>
        <button v-for="item in myItems" :key="item.path" class="nav-item" :data-smoke-key="item.key" :class="{active:current===item.path}" :disabled="navigatingPath===item.path" :aria-busy="navigatingPath===item.path" @click="navigate(item.path)">
          <AppIcon class="nav-icon" :name="item.icon" :size="20"/>
          <span>{{item.label}}</span>
          <span v-if="item.key==='search'" class="nav-kbd" aria-hidden="true">Ctrl K</span>
        </button>
        <div class="nav-section">系 统</div>
        <button v-for="item in systemItems" :key="item.path" class="nav-item" :data-smoke-key="item.key" :class="{active:current===item.path}" :disabled="navigatingPath===item.path" :aria-busy="navigatingPath===item.path" @click="navigate(item.path)">
          <AppIcon class="nav-icon" :name="item.icon" :size="20"/>
          <span>{{item.label}}</span>
        </button>
      </nav>
      <div class="side-spacer"/>
      <div v-if="nowPlayingVisible&&current!=='/'" class="now-playing-card">
        <div class="np-row">
          <span class="np-glyph" aria-hidden="true"><AppIcon :name="playerStats?.paused?'player-pause':'player-play'" :size="14"/></span>
          <div class="np-copy"><strong :title="nowPlayingName">{{nowPlayingName}}</strong><small>{{mediaStatus}}</small></div>
        </div>
        <div class="np-actions"><button class="np-return" @click="navigate('/player')">返回播放器</button></div>
      </div>
    </aside>

    <main class="content"><RouterView/></main>

    <footer class="statusbar" role="status" aria-live="polite">
      <span>来源引擎：<b :class="{good:sourceHealthy,danger:sourceHealthy===false}">{{sourceHealthy===null?'检测中':sourceHealthy?'正常':'异常'}}</b></span>
      <span>媒体状态：{{mediaStatus}}</span>
      <span class="status-detail" tabindex="0">
        <span>运行详情</span>
        <span class="status-detail-pop" role="tooltip">
          <span>当前版本</span><b>{{version?'V'+version:'版本待确认'}}<template v-if="isPackaged"> · 安装版</template></b>
          <span>播放器内核</span><b>PlayerHost C++ x64</b>
          <span>渲染模式</span><b>{{renderMode}}</b>
          <span>媒体状态</span><b>{{mediaStatus}}</b>
          <span>诊断与日志</span><b>设置 → 系统诊断</b>
        </span>
      </span>
      <span>{{version?'V'+version:'版本待确认'}}</span>
    </footer>
  </div>
  <ToastHost/>
  <CommandPalette/>
</template>
<style scoped>
.title-actions{position:relative;margin-left:auto;align-self:center;-webkit-app-region:no-drag}.title-menu-button{width:38px;height:30px;border:0;border-radius:7px;background:transparent;font-weight:800;letter-spacing:2px}.title-menu{position:absolute;right:8px;top:34px;z-index:1000;min-width:140px;padding:6px;border:1px solid var(--line);border-radius:10px;background:var(--surface);box-shadow:0 12px 30px rgba(0,0,0,.18)}.title-menu button{display:block;width:100%;padding:8px 10px;border:0;border-radius:6px;background:transparent;text-align:left}.title-menu button:hover{background:var(--surface-2)}.nav-item:disabled{opacity:.6;cursor:wait}.brand-mark svg path{fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}
.now-playing-card{border:1px solid var(--line);border-radius:10px;background:var(--surface);padding:10px 11px;display:grid;gap:8px;flex:none;margin-bottom:2px}
.now-playing-card .np-row{display:grid;grid-template-columns:26px 1fr;gap:9px;align-items:center;min-width:0}
.now-playing-card .np-glyph{width:26px;height:26px;border-radius:7px;background:var(--accent);color:#fff;display:grid;place-items:center;font-size:10px;flex:none}
.now-playing-card .np-copy{min-width:0;display:flex;flex-direction:column;gap:2px}
.now-playing-card .np-copy strong{font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.now-playing-card .np-copy small{font-size:10.5px;color:var(--muted)}
.now-playing-card .np-actions{display:flex}
.now-playing-card .np-return{flex:1;height:26px;border:1px solid var(--line);border-radius:7px;background:var(--surface-2);font-size:11px;color:var(--accent-strong)}
.now-playing-card .np-return:hover{background:var(--accent-soft)}
</style>

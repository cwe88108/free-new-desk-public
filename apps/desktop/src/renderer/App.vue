<script setup lang="ts">
import { computed,onBeforeUnmount,onMounted,ref } from 'vue';
import { useRoute,useRouter } from 'vue-router';
import type { PlayerStats } from '@free-new-desk/contracts';

const route=useRoute();
const router=useRouter();
const version=ref('1.4.9');
const isPackaged=ref(false);
const sourceHealthy=ref<boolean|null>(null);
const navigatingPath=ref('');
const menuOpen=ref(false);
const renderMode=ref(localStorage.getItem('player.hwdec')==='off'?'软件解码（CPU）':'硬件加速（GPU）');
const playerStats=ref<PlayerStats|null>(null);
const playerReachable=ref(false);
let playerPoll:ReturnType<typeof setInterval>|undefined;
let removeHealthListener:(()=>void)|undefined;
let removeNavigateListener:(()=>void)|undefined;
let renderModeListener:((event:Event)=>void)|undefined;
const items=[
  {key:'home',path:'/',label:'首页',icon:'home'},
  {key:'vod',path:'/vod',label:'点播',icon:'play'},
  {key:'live',path:'/live',label:'直播',icon:'tv'},
  {key:'player',path:'/player',label:'播放器',icon:'circle-play'},
  {key:'search',path:'/search',label:'搜索',icon:'search'},
  {key:'favorites',path:'/favorites',label:'收藏',icon:'star'},
  {key:'history',path:'/history',label:'历史',icon:'clock'},
  {key:'sources',path:'/sources',label:'来源',icon:'layers'},
  {key:'settings',path:'/settings',label:'设置',icon:'settings'}
] as const;
const current=computed(()=>route.path);
async function navigate(path:string){if(navigatingPath.value||current.value===path)return;navigatingPath.value=path;const started=performance.now();try{await router.push(path);const elapsed=performance.now()-started;void window.desktop.diagnostics.recordPerformance('navigationMs',elapsed).catch(()=>false);if(window.desktop.app.isUiSmoke()&&elapsed>100)throw new Error(`Navigation exceeded 100ms budget: ${path} ${elapsed.toFixed(1)}ms`);}finally{requestAnimationFrame(()=>{navigatingPath.value='';});}}
async function appAction(action:'reload'|'devtools'|'quit'){menuOpen.value=false;await window.desktop.app.action(action);}
async function refreshPlayer(){try{playerStats.value=await window.desktop.playback.query('stats');playerReachable.value=true;}catch{playerReachable.value=false;}}
async function playerControl(command:'pause'|'mute',value:boolean){await window.desktop.playback.control({command,value});await refreshPlayer();}
async function setVolume(event:Event){const value=Number((event.target as HTMLInputElement).value);await window.desktop.playback.control({command:'volume',value});await refreshPlayer();}
const mediaStatus=computed(()=>!playerReachable.value?'播放器未连接':playerStats.value?.duration||playerStats.value?.path?(playerStats.value?.paused?'已暂停':'播放中'):'空闲');
function focusPageSearch(event:KeyboardEvent){if(!(event.ctrlKey||event.metaKey)||event.key.toLowerCase()!=='f')return;const target=event.target as HTMLElement|null;if(target&&['INPUT','SELECT','TEXTAREA'].includes(target.tagName))return;const input=document.querySelector<HTMLElement>('.content [data-search-input]:not([disabled])');if(!input)return;event.preventDefault();menuOpen.value=false;input.focus();input.scrollIntoView({block:'nearest'});}

onMounted(async()=>{
  try{const info=await window.desktop.app.getInfo();version.value=info.version;isPackaged.value=info.packaged;}catch{/* footer keeps v1.4.9 fallback */}
  try{sourceHealthy.value=await window.desktop.source.ping();}catch{sourceHealthy.value=false;}
  removeHealthListener=window.desktop.source.onHealthChanged(value=>{sourceHealthy.value=value.ok;});
  removeNavigateListener=window.desktop.app.onNavigate(path=>{void router.push(path);});
  renderModeListener=(event:Event)=>{const value=(event as CustomEvent<string>).detail;renderMode.value=value==='no'?'软件解码（CPU）':'硬件加速（GPU）';};
  window.addEventListener('fnd:render-mode',renderModeListener);
  window.addEventListener('keydown',focusPageSearch);
  await refreshPlayer();playerPoll=setInterval(refreshPlayer,1500);
});
onBeforeUnmount(()=>{removeHealthListener?.();removeNavigateListener?.();if(playerPoll)clearInterval(playerPoll);if(renderModeListener)window.removeEventListener('fnd:render-mode',renderModeListener);window.removeEventListener('keydown',focusPageSearch);});
</script>

<template>
  <div class="app-shell">
    <header class="titlebar">
      <div class="app-brand">
        <span class="brand-mark" aria-hidden="true">
          <svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="5"/><path d="m10 8 6 4-6 4Z"/></svg>
        </span>
        <strong>Free New Desk</strong>
      </div><div class="title-actions"><button class="title-menu-button" aria-label="扩展菜单" :aria-expanded="menuOpen" @click="menuOpen=!menuOpen">•••</button><div v-if="menuOpen" class="title-menu"><button @click="appAction('reload')">刷新界面</button><button v-if="!isPackaged" @click="appAction('devtools')">开发者工具</button><button @click="appAction('quit')">退出应用</button></div></div>
    </header>

    <aside class="navigation" aria-label="主导航">
      <nav class="nav-stack">
        <button v-for="item in items" :key="item.path" class="nav-item" :data-smoke-key="item.key" :class="{active:current===item.path}" :disabled="navigatingPath===item.path" :aria-busy="navigatingPath===item.path" @click="navigate(item.path)">
          <svg class="nav-icon" viewBox="0 0 24 24" aria-hidden="true">
            <template v-if="item.icon==='home'"><path d="M3 11.2 12 4l9 7.2v8.3a1.5 1.5 0 0 1-1.5 1.5h-5v-6h-5v6h-5A1.5 1.5 0 0 1 3 19.5Z"/></template>
            <template v-else-if="item.icon==='play'"><circle cx="12" cy="12" r="9"/><path d="m10 8 6 4-6 4Z"/></template>
            <template v-else-if="item.icon==='tv'"><rect x="3" y="6" width="18" height="14" rx="2"/><path d="m9 2 3 4 3-4M8 11l6 3-6 3Z"/></template>
            <template v-else-if="item.icon==='search'"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></template>
            <template v-else-if="item.icon==='star'"><path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-2.9-5.6 2.9 1.1-6.2L3 9.6l6.2-.9Z"/></template>
            <template v-else-if="item.icon==='clock'"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/></template>
            <template v-else-if="item.icon==='layers'"><path d="m12 3 9 5-9 5-9-5Z"/><path d="m3 12 9 5 9-5M3 16l9 5 9-5"/></template>
            <template v-else-if="item.icon==='circle-play'"><circle cx="12" cy="12" r="9"/><path d="m10 8 6 4-6 4Z"/></template>
            <template v-else><circle cx="12" cy="12" r="3"/><path d="M12 2v3m0 14v3M4.9 4.9 7 7m10 10 2.1 2.1M2 12h3m14 0h3M4.9 19.1 7 17m10-10 2.1-2.1"/></template>
          </svg>
          <span>{{item.label}}</span>
        </button>
      </nav>

      <div class="sidebar-spacer"/>
    </aside>

    <main class="content"><RouterView/></main>

    <footer class="statusbar" role="status" aria-live="polite">
      <span>来源引擎：<b :class="{good:sourceHealthy,danger:sourceHealthy===false}">{{sourceHealthy===null?'检测中':sourceHealthy?'正常':'异常'}}</b></span>
      <span class="statusbar-spacer"/>
      <span>播放器内核：PlayerHost C++ x64</span>
      <span>渲染模式：{{renderMode}}</span>
      <span>媒体状态：{{mediaStatus}}</span>
      <span>当前版本：V{{version}}</span>
    </footer>
  </div>
</template>
<style scoped>
.title-actions{position:relative;margin-left:auto;align-self:center;-webkit-app-region:no-drag}.title-menu-button{width:38px;height:30px;border:0;border-radius:7px;background:transparent;font-weight:800;letter-spacing:2px}.title-menu{position:absolute;right:8px;top:34px;z-index:1000;min-width:140px;padding:6px;border:1px solid var(--line);border-radius:10px;background:var(--surface);box-shadow:0 12px 30px rgba(0,0,0,.18)}.title-menu button{display:block;width:100%;padding:8px 10px;border:0;border-radius:6px;background:transparent;text-align:left}.title-menu button:hover{background:var(--surface-2)}.nav-item:disabled{opacity:.6;cursor:wait}
</style>

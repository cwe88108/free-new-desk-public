<script setup lang="ts">
import { onBeforeUnmount,onMounted,ref } from 'vue';
import type { PlayerStats } from '@free-new-desk/contracts';
import HomeView from './HomeView.vue';

const miniExpanded=ref(localStorage.getItem('ui.miniPlayerExpanded')!=='false');
const playerStats=ref<PlayerStats|null>(null);
const reachable=ref(false);
let poll:ReturnType<typeof setInterval>|undefined;

async function refresh(){
  try{playerStats.value=await window.desktop.playback.query('stats');reachable.value=true;}
  catch{reachable.value=false;}
}
function toggle(){miniExpanded.value=!miniExpanded.value;localStorage.setItem('ui.miniPlayerExpanded',String(miniExpanded.value));}
async function pause(){if(!reachable.value)return;await window.desktop.playback.control({command:'pause',value:!playerStats.value?.paused});await refresh();}
async function mute(){if(!reachable.value)return;await window.desktop.playback.control({command:'mute',value:!playerStats.value?.muted});await refresh();}
async function volume(event:Event){if(!reachable.value)return;await window.desktop.playback.control({command:'volume',value:Number((event.target as HTMLInputElement).value)});await refresh();}

onMounted(async()=>{await refresh();poll=setInterval(refresh,1500);});
onBeforeUnmount(()=>{if(poll)clearInterval(poll);});
</script>

<template>
  <div class="home-shell-view">
    <HomeView/>
    <section class="panel home-concept-mini" :class="{collapsed:!miniExpanded}" aria-label="迷你播放器">
      <div class="mini-head">
        <h2>迷你播放器</h2>
        <button class="icon-button" :aria-expanded="miniExpanded" :aria-label="miniExpanded?'收起迷你播放器':'展开迷你播放器'" @click="toggle">{{miniExpanded?'⌃':'⌄'}}</button>
      </div>
      <div v-if="miniExpanded" class="mini-body">
        <div class="mini-cover" aria-hidden="true">▶</div>
        <div class="mini-meta">
          <strong>{{playerStats?.videoFormat||'当前没有播放内容'}}</strong>
          <small>{{reachable?(playerStats?.paused?'已暂停':'正在播放'):'PlayerHost 未连接'}}</small>
          <span v-if="playerStats?.duration">{{Math.round(playerStats.position/60)}} / {{Math.round(playerStats.duration/60)}} 分钟</span>
          <span v-else>等待播放会话</span>
        </div>
        <div class="mini-actions">
          <button disabled aria-label="上一项" title="当前播放队列没有可用上一项">|◀</button>
          <button :disabled="!reachable" :aria-label="playerStats?.paused?'播放':'暂停'" @click="pause">{{playerStats?.paused?'▶':'Ⅱ'}}</button>
          <button disabled aria-label="下一项" title="当前播放队列没有可用下一项">▶|</button>
        </div>
        <button class="mute-button" :disabled="!reachable" :aria-label="playerStats?.muted?'取消静音':'静音'" @click="mute">{{playerStats?.muted?'🔇':'🔊'}}</button>
        <input type="range" min="0" max="100" :value="playerStats?.volume??80" aria-label="播放器音量" :disabled="!reachable" @change="volume"/>
      </div>
    </section>
  </div>
</template>

<style scoped>
.home-shell-view{min-height:100%;position:relative}.home-concept-mini{margin:0 30px 34px;padding:12px 16px}.mini-head{display:flex;align-items:center;justify-content:space-between}.mini-head h2{font-size:20px}.mini-body{display:grid;grid-template-columns:92px minmax(180px,1fr) auto 40px 190px;align-items:center;gap:14px;margin-top:8px}.mini-cover{height:64px;border-radius:7px;background:var(--surface-2);display:grid;place-items:center;color:var(--accent)}.mini-meta{display:flex;flex-direction:column;gap:4px}.mini-meta small,.mini-meta span{color:var(--muted);font-size:11px}.mini-actions{display:flex;gap:8px}.mini-actions button,.mute-button{width:36px;height:36px;border:0;background:transparent}.mini-body input{width:100%;accent-color:var(--accent)}.home-concept-mini.collapsed{padding-bottom:10px}@media(max-width:1180px){.mini-body{grid-template-columns:72px 1fr auto 36px 130px}}
</style>

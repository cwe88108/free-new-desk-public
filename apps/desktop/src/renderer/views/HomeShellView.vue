<script setup lang="ts">
import { computed,onBeforeUnmount,onMounted,ref } from 'vue';
import type {PlaybackHistoryEntry} from '@free-new-desk/contracts';
import type { PlaybackSessionSnapshot,PlayerCommand } from '@free-new-desk/contracts';
import AppIcon from '../components/AppIcon.vue';
import { adjacentMusicId,readQueue,clockStats,clockStale,refreshPlaybackClock } from '../stores/music-playback';
import HomeView from './HomeView.vue';

const miniExpanded=ref(localStorage.getItem('ui.miniPlayerExpanded')!=='false');
const playerStats=clockStats;
const runtime=ref<PlaybackSessionSnapshot|null>(null);
const reachable=computed(()=>!clockStale.value&&clockStats.value?.sampleFresh===true);const miniError=ref('');
let removeRuntime:(()=>void)|undefined;

async function refresh(){await refreshPlaybackClock().catch(()=>undefined);}
function toggle(){miniExpanded.value=!miniExpanded.value;localStorage.setItem('ui.miniPlayerExpanded',String(miniExpanded.value));}
function controlDisplayedPlayer(command:PlayerCommand){const sample=playerStats.value;if(!sample?.requestId)throw new Error('播放会话已变化，请刷新后重试。');return window.desktop.playback.control({...command,requestId:sample.requestId,...(sample.loadId?{loadId:sample.loadId}:{})});}
async function pause(){if(!reachable.value)return;try{const result=await controlDisplayedPlayer({command:'pause',value:!playerStats.value?.paused});if(!result.ok)throw new Error(result.detail??'暂停/继续操作失败');miniError.value='';await refresh();}catch(error){miniError.value=error instanceof Error?error.message:String(error);}}
async function mute(){if(!reachable.value)return;try{const result=await controlDisplayedPlayer({command:'mute',value:!playerStats.value?.muted});if(!result.ok)throw new Error(result.detail??'静音操作失败');miniError.value='';await refresh();}catch(error){miniError.value=error instanceof Error?error.message:String(error);}}
async function volume(event:Event){if(!reachable.value)return;try{const result=await controlDisplayedPlayer({command:'volume',value:Number((event.target as HTMLInputElement).value)});if(!result.ok)throw new Error(result.detail??'音量调整失败');miniError.value='';await refresh();}catch(error){miniError.value=error instanceof Error?error.message:String(error);await refresh();}}
async function skipMusic(direction:1|-1){const session=runtime.value;if(session?.domain!=='music'||!session.trackId)return;const ids=readQueue(),target=adjacentMusicId(ids,session.trackId,direction,localStorage.getItem('music.mode')??'sequence');if(!target||target===session.trackId){miniError.value='当前音乐队列没有可切换的项目。';return;}try{miniError.value='';await window.desktop.music.play({trackId:target,initiator:'user'});}catch(error){miniError.value=error instanceof Error?error.message:String(error);}}
function currentEntry(history:PlaybackHistoryEntry[]){const session=runtime.value;return session?.domain==='vod'?history.find(item=>item.sourceId===session.sourceId&&item.videoId===session.videoId&&(!session.episodeId||item.episodeId===session.episodeId)):undefined;}
function mediaTitle(history:PlaybackHistoryEntry[]){const entry=currentEntry(history);if(entry)return entry.videoName+(entry.episodeName?' · '+entry.episodeName:'');const raw=playerStats.value?.path?.split(/[?#]/)[0]?.split(/[\\/]/).pop();if(raw)try{return decodeURIComponent(raw);}catch{return raw;}return '当前没有播放内容';}
function formatTime(value=0){const seconds=Math.max(0,Math.floor(value));return Math.floor(seconds/60).toString().padStart(2,'0')+':'+(seconds%60).toString().padStart(2,'0');}
function canSeek(){return reachable.value&&Number(playerStats.value?.duration)>0;}
async function seek(value:number,absolute=false){if(!canSeek())return;try{const result=await controlDisplayedPlayer({command:'seek',value,absolute});if(!result.ok)throw new Error(result.detail??'进度调整失败');miniError.value='';await refresh();}catch(error){miniError.value=error instanceof Error?error.message:String(error);}}
function hasMusicAdjacent(){return runtime.value?.domain==='music'&&readQueue().length>1;}

onMounted(async()=>{runtime.value=await window.desktop.playback.runtimeSession().catch(()=>null);removeRuntime=window.desktop.playback.onRuntimeSessionChanged(value=>{runtime.value=value;});await refresh();});
onBeforeUnmount(()=>{removeRuntime?.();});
</script>

<template>
  <HomeView>
    <template #mini-player="{history}">
      <section class="home-mini-section" aria-label="迷你播放器">
        <div class="mini-head"><h2>迷你播放器</h2><button class="icon-button" :aria-expanded="miniExpanded" :aria-label="miniExpanded?'收起迷你播放器':'展开迷你播放器'" @click="toggle"><AppIcon :name="miniExpanded?'action-chevron-up':'action-chevron-down'" :size="16"/></button></div>
        <div class="panel home-concept-mini" :class="{collapsed:!miniExpanded}">
          <div v-if="miniExpanded" class="mini-body">
            <div class="mini-cover"><img v-if="currentEntry(history)?.poster" :src="currentEntry(history)?.poster" alt="当前影片海报"/><AppIcon v-else name="player-play" :size="26"/></div>
            <div class="mini-meta"><small>{{reachable?(playerStats?.paused?'已暂停':'正在播放'):'等待播放会话'}}</small><strong :title="mediaTitle(history)">{{mediaTitle(history)}}</strong></div>
            <div class="mini-actions">
              <button v-if="runtime?.domain==='music'" :disabled="!hasMusicAdjacent()" aria-label="上一项" title="音乐队列上一项" @click="skipMusic(-1)"><AppIcon name="player-prev" :size="18"/></button>
              <button v-else :disabled="!canSeek()" aria-label="后退 10 秒" @click="seek(-10)"><AppIcon name="player-rewind" :size="18"/></button>
              <button class="mini-play" :disabled="!reachable" :aria-label="playerStats?.paused?'播放':'暂停'" @click="pause"><AppIcon :name="playerStats?.paused?'player-play':'player-pause'" :size="22"/></button>
              <button v-if="runtime?.domain==='music'" :disabled="!hasMusicAdjacent()" aria-label="下一项" title="音乐队列下一项" @click="skipMusic(1)"><AppIcon name="player-next" :size="18"/></button>
              <button v-else :disabled="!canSeek()" aria-label="前进 10 秒" @click="seek(10)"><AppIcon name="player-forward" :size="18"/></button>
            </div>
            <div class="mini-volume"><button class="mute-button" :disabled="!reachable" :aria-label="playerStats?.muted?'取消静音':'静音'" @click="mute"><AppIcon :name="playerStats?.muted?'player-mute':'player-volume'" :size="18"/></button><input type="range" min="0" max="100" :value="playerStats?.volume??80" aria-label="播放器音量" :disabled="!reachable" @change="volume"/></div>
            <RouterLink class="secondary-button mini-return" to="/player">返回播放器</RouterLink>
            <div class="mini-progress"><input type="range" min="0" :max="Math.max(1,playerStats?.duration??0)" step="0.1" :value="playerStats?.position??0" :disabled="!canSeek()" aria-label="迷你播放器进度" @change="seek(Number(($event.target as HTMLInputElement).value),true)"/><div><time>{{formatTime(playerStats?.position)}}</time><time>{{formatTime(playerStats?.duration)}}</time></div></div>
            <small v-if="miniError" class="mini-error" role="alert">{{miniError}}</small>
          </div>
          <div v-else class="mini-collapsed"><AppIcon name="player-play" :size="24"/><span>{{mediaTitle(history)}}</span><button class="text-link" @click="toggle">展开播放器</button></div>
        </div>
      </section>
    </template>
  </HomeView>
</template>

<style scoped>
.home-mini-section{min-width:0}.mini-head{display:flex;align-items:baseline;justify-content:space-between;margin:0 0 11px}.mini-head h2{font-size:calc(18px * var(--font-scale))}.home-concept-mini{height:var(--home-module-height,160px);box-sizing:border-box;padding:20px;background:var(--surface)}
.mini-body{display:grid;height:100%;grid-template-columns:88px minmax(100px,1fr) auto minmax(90px,130px) auto;grid-template-rows:1fr auto;align-items:center;gap:10px 14px;min-width:0}.mini-cover{grid-row:1/3;width:88px;height:106px;border-radius:8px;background:var(--surface-2);display:grid;place-items:center;color:var(--accent);overflow:hidden}.mini-cover img{width:100%;height:100%;object-fit:cover}.mini-meta{min-width:0;display:flex;flex-direction:column;gap:8px}.mini-meta strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:15px}.mini-meta small,.mini-progress time{font-size:11px;color:var(--muted)}.mini-actions,.mini-volume{display:flex;align-items:center;gap:6px}.mini-actions button,.mute-button{width:32px;height:36px;display:grid;place-items:center;border:0;background:transparent;padding:0;flex:none}.mini-actions .mini-play{width:46px;height:46px;background:var(--text);color:var(--surface);border-radius:50%}.mini-body input{min-width:0;width:100%;accent-color:var(--accent)}.mini-progress{grid-column:2/-1;min-width:0}.mini-progress>div{display:flex;justify-content:space-between;margin-top:2px}.mini-error{grid-column:2/-1;color:var(--danger);font-size:11px}.mini-return{white-space:nowrap;font-size:12px}.mini-collapsed{display:flex;align-items:center;justify-content:center;gap:16px;height:100%;color:var(--muted)}button:disabled,input:disabled{opacity:.4;cursor:not-allowed}
@media(max-width:760px){.home-concept-mini{height:auto;min-height:var(--home-module-height,160px);padding:14px}.mini-body{grid-template-columns:58px minmax(0,1fr) auto;gap:10px}.mini-cover{width:58px;height:70px;grid-row:1/3}.mini-meta{grid-column:2}.mini-actions{grid-column:3}.mini-volume{grid-column:2}.mini-return{grid-column:3;grid-row:2}.mini-progress{grid-column:1/-1}.mini-error{grid-column:1/-1}}
</style>

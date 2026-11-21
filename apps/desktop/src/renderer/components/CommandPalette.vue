<script setup lang="ts">
import { computed,nextTick,onBeforeUnmount,onMounted,ref,watch } from 'vue';
import { useRoute,useRouter } from 'vue-router';
import { useToastStore } from '../stores/toast';
import { SEASONS, saveAppearance } from '../appearance';
import { setNativeSurfaceOccluded } from '../native-surface';

interface Command{id:string;group:string;label:string;hint?:string;keywords:string;run:()=>void|Promise<void>;}

const router=useRouter();
const route=useRoute();
const toast=useToastStore();
const open=ref(false);
watch(open, value => setNativeSurfaceOccluded('command-palette', value));
onBeforeUnmount(() => setNativeSurfaceOccluded('command-palette', false));
const query=ref('');
const cursor=ref(0);
const input=ref<HTMLInputElement|null>(null);
const listEl=ref<HTMLElement|null>(null);

function focusPageSearch(){const input=document.querySelector<HTMLElement>('.content [data-search-input]:not([disabled])');if(input){input.focus();input.scrollIntoView({block:'nearest'});return true;}return false;}

async function applyTheme(next:'light'|'dark'|'system'){
  try {
    await saveAppearance('theme',next);
    toast.success('明暗偏好已更新');
    close();
  } catch (error) {
    toast.error('保存明暗偏好失败',String(error));
  }
}

const commands=computed<Command[]>(()=>[
  {id:'nav-home',group:'跳转',label:'首页',hint:'G H',keywords:'home shouye',run:()=>void router.push('/')},
  {id:'nav-vod',group:'跳转',label:'点播',hint:'G V',keywords:'vod dianbo movie',run:()=>void router.push('/vod')},
  {id:'nav-live',group:'跳转',label:'直播',hint:'G L',keywords:'live zhibo tv',run:()=>void router.push('/live')},
  {id:'nav-music',group:'跳转',label:'音乐',hint:'G M',keywords:'music yinyue',run:()=>void router.push('/music')},
  {id:'nav-player',group:'跳转',label:'播放器',hint:'G P',keywords:'player bofang',run:()=>void router.push('/player')},
  {id:'nav-search',group:'跳转',label:'聚合搜索',hint:'G S',keywords:'search sousuo',run:()=>void router.push('/search')},
  {id:'nav-favorites',group:'跳转',label:'收藏',hint:'G I',keywords:'favorites shoucang star',run:()=>void router.push('/favorites')},
  {id:'nav-history',group:'跳转',label:'播放历史',hint:'G T',keywords:'history lishi clock',run:()=>void router.push('/history')},
  {id:'nav-sources',group:'跳转',label:'来源管理',hint:'G U',keywords:'sources laiyuan import',run:()=>void router.push('/sources')},
  {id:'nav-settings',group:'跳转',label:'设置与诊断',hint:'G D',keywords:'settings shezhi',run:()=>void router.push('/settings')},
  {id:'act-find',group:'当前页动作',label:'聚焦本页搜索框',hint:'Ctrl F',keywords:'find search focus',run:()=>{if(!focusPageSearch())toast.info('本页没有搜索框','可前往点播、搜索或收藏页使用。');close();}},
  {id:'act-theme-light',group:'外观',label:'使用浅色外观',keywords:'theme light qianse yang',run:()=>applyTheme('light')},
  {id:'act-theme-dark',group:'外观',label:'使用深色外观',keywords:'theme dark anse mo',run:()=>applyTheme('dark')},
  {id:'act-theme-system',group:'外观',label:'跟随系统明暗',keywords:'theme system',run:()=>applyTheme('system')},
  ...SEASONS.map(choice=>({id:'season-'+choice.id,group:'外观',label:choice.name,keywords:'theme '+choice.id,run:async()=>{
    try { await saveAppearance('ui.season',choice.id); close(); }
    catch(error) { toast.error('保存主题失败',String(error)); }
  }})),
  {id:'act-update',group:'系统',label:'检查应用更新',keywords:'update gengxin check',run:async()=>{close();await router.push('/settings?section=update');}},
  {id:'act-diag',group:'系统',label:'打开诊断中心',keywords:'diagnostics zhenduan log',run:async()=>{close();await router.push('/settings?section=diagnostics');}}
]);

const filtered=computed(()=>{const needle=query.value.trim().toLowerCase();if(!needle)return commands.value;return commands.value.filter(item=>`${item.label} ${item.keywords} ${item.group}`.toLowerCase().includes(needle));});
const grouped=computed(()=>{const map=new Map<string,Command[]>();for(const item of filtered.value){const list=map.get(item.group)??[];list.push(item);map.set(item.group,list);}return[...map.entries()];});
const flatList=computed(()=>filtered.value);

watch(filtered,()=>{cursor.value=0;});
watch(open,async value=>{if(value){query.value='';cursor.value=0;await nextTick();input.value?.focus();}});

function openPalette(){open.value=true;}
function close(){open.value=false;}
function onKeydown(event:KeyboardEvent){const target=event.target as HTMLElement|null;const typing=target&&['INPUT','SELECT','TEXTAREA'].includes(target.tagName);if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='k'){event.preventDefault();open.value?close():openPalette();return;}
  if(!open.value)return;
  if(event.key==='Escape'){event.preventDefault();close();return;}
  if(event.key==='ArrowDown'){event.preventDefault();cursor.value=Math.min(flatList.value.length-1,cursor.value+1);scrollCursor();return;}
  if(event.key==='ArrowUp'){event.preventDefault();cursor.value=Math.max(0,cursor.value-1);scrollCursor();return;}
  if(event.key==='Enter'){event.preventDefault();const item=flatList.value[cursor.value];if(item)void runCommand(item);}}
function scrollCursor(){void nextTick(()=>{listEl.value?.querySelector('.cmd-item.cursor')?.scrollIntoView({block:'nearest'});});}
async function runCommand(item:Command){try{await item.run();}catch(value){toast.error('命令执行失败',value instanceof Error?value.message:String(value));}}
function onKeyupGlobal(event:KeyboardEvent){if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='k')onKeydown(event);}

const goRoutes:Record<string,string>={h:'/',v:'/vod',l:'/live',m:'/music',p:'/player',s:'/search',i:'/favorites',t:'/history',u:'/sources',d:'/settings'};
let goPending=0;
function onGlobalGoKey(event:KeyboardEvent){const target=event.target as HTMLElement|null;if(target&&['INPUT','SELECT','TEXTAREA'].includes(target.tagName))return;if(event.ctrlKey||event.metaKey||event.altKey)return;const key=event.key.toLowerCase();
  if(key==='g'&&!goPending){goPending=window.setTimeout(()=>{goPending=0;},900);return;}
  if(goPending&&goRoutes[key]){clearTimeout(goPending);goPending=0;event.preventDefault();void router.push(goRoutes[key]!);return;}
  if(goPending){clearTimeout(goPending);goPending=0;}}

function highlight(label:string){const term=query.value.trim();if(!term)return label;const index=label.toLowerCase().indexOf(term.toLowerCase());if(index<0)return label;return `${label.slice(0,index)}【${label.slice(index,index+term.length)}】`;}

onMounted(()=>{window.addEventListener('keydown',onKeyupGlobal);window.addEventListener('keydown',onGlobalGoKey);});
onBeforeUnmount(()=>{window.removeEventListener('keydown',onKeyupGlobal);window.removeEventListener('keydown',onGlobalGoKey);if(goPending){clearTimeout(goPending);goPending=0;}});

defineExpose({openPalette});
</script>

<template>
  <dialog :open="open" class="cmd-palette-backdrop" @click.self="close">
    <div v-if="open" class="cmd-palette" role="dialog" aria-modal="true" aria-label="命令面板">
      <input ref="input" v-model="query" placeholder="搜索页面、动作或设置…" aria-label="命令面板搜索" @keydown="onKeydown"/>
      <div ref="listEl" class="cmd-list">
        <template v-for="[group,items] in grouped" :key="group">
          <div class="cmd-group">{{group}}</div>
          <button v-for="item in items" :key="item.id" class="cmd-item" :class="{cursor:flatList[cursor]?.id===item.id}" :data-cmd-id="item.id" @click="runCommand(item)" @mousemove="cursor=flatList.findIndex(entry=>entry.id===item.id)">
            <span>{{highlight(item.label)}}</span>
            <small v-if="item.hint" class="cmd-hint">{{item.hint}}</small>
          </button>
        </template>
        <div v-if="!filtered.length" class="cmd-empty">没有匹配的命令，试试「点播」「主题」或「更新」。</div>
      </div>
    </div>
  </dialog>
</template>

<style scoped>
dialog.cmd-palette-backdrop{border:0;padding:0;background:transparent;max-width:none;max-height:none}
dialog.cmd-palette-backdrop::backdrop{background:color-mix(in srgb,#262218 32%,transparent);backdrop-filter:blur(2px)}
</style>

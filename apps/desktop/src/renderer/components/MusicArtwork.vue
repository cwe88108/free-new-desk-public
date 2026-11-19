<script setup lang="ts">
import { onBeforeUnmount,ref,watch } from 'vue';
import AppIcon from './AppIcon.vue';
const props=defineProps<{trackId?:string;artist?:string}>();
const root=ref<HTMLElement>(),url=ref(''),provider=ref('');let observer:IntersectionObserver|undefined,generation=0,visible=false;
async function load(){const id=++generation;url.value='';provider.value='';if(!visible)return;try{if(props.artist){const result=await window.desktop.music.artistArtwork(props.artist);if(id===generation){url.value=result?.url??'';provider.value=result?.provider??'';}}else if(props.trackId){const result=await window.desktop.music.artwork(props.trackId);if(id===generation)url.value=result??'';}}catch{/* placeholder */}}
watch(root,value=>{observer?.disconnect();if(value){observer=new IntersectionObserver(entries=>{if(entries.some(e=>e.isIntersecting)){visible=true;observer?.disconnect();void load();}},{rootMargin:'80px'});observer.observe(value);}});
watch(()=>[props.trackId,props.artist],()=>{void load();});
async function choose(){const result=await window.desktop.music.chooseArtwork(props.artist?{artist:props.artist}:{trackId:props.trackId!});if(result){generation++;url.value=result;provider.value='用户指定';}}
onBeforeUnmount(()=>{generation++;observer?.disconnect();});
</script>
<template><span ref="root" class="music-artwork" :title="provider||'暂无匹配图片；右键可指定图片'" @contextmenu.prevent.stop="choose"><img v-if="url" :src="url" alt="" loading="lazy"/><AppIcon v-else :name="artist?'music-artist':'nav-music'" :size="24"/></span></template>
<style scoped>.music-artwork{display:grid;place-items:center;width:100%;height:100%;min-height:24px;overflow:hidden;background:var(--surface-1);border-radius:6px}.music-artwork img{width:100%;height:100%;object-fit:cover}.music-artwork svg{width:55%;height:55%;stroke:var(--muted);stroke-width:1.5;fill:none}</style>

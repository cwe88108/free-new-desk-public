<script setup lang="ts">
import { onBeforeUnmount,onMounted,ref } from 'vue';
import MusicIcon from './MusicIcon.vue';
import { loadMusicArtwork } from '../music-artwork-cache';
const props=withDefaults(defineProps<{trackId?:string;alt?:string;online?:boolean;circular?:boolean;compact?:boolean}>(),{alt:'音乐封面',online:true,circular:false,compact:false});
const host=ref<HTMLElement|null>(null);const src=ref('');const loaded=ref(false);let observer:IntersectionObserver|undefined;
async function load(){if(loaded.value||!props.trackId)return;loaded.value=true;src.value=(await loadMusicArtwork(props.trackId,props.online))??'';}
onMounted(()=>{if(!host.value)return;observer=new IntersectionObserver(entries=>{if(entries.some(entry=>entry.isIntersecting)){observer?.disconnect();void load();}},{rootMargin:'120px'});observer.observe(host.value);});
onBeforeUnmount(()=>observer?.disconnect());
</script>

<template>
  <span ref="host" class="artwork-tile" :class="{circular,compact}"><img v-if="src" :src="src" :alt="alt"/><span v-else class="artwork-placeholder"><MusicIcon :name="circular?'artist':'album'" :size="compact?18:34"/></span></span>
</template>

<style scoped>
.artwork-tile{display:grid;place-items:center;width:100%;aspect-ratio:1;overflow:hidden;border-radius:8px;background:color-mix(in srgb,var(--surface-1) 84%,var(--line));color:var(--muted)}.artwork-tile.circular{border-radius:50%}.artwork-tile.compact{width:34px;height:34px;border-radius:5px}.artwork-tile img{width:100%;height:100%;object-fit:cover}.artwork-placeholder{display:grid;place-items:center;width:100%;height:100%;background:linear-gradient(145deg,color-mix(in srgb,var(--music-accent,#a76318) 14%,var(--surface)),var(--surface-1))}
</style>

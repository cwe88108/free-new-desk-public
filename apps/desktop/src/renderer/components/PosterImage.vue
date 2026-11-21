<script setup lang="ts">
import {ref,watch} from 'vue';
import AppIcon from './AppIcon.vue';
const props=defineProps<{src?:string|undefined;alt:string}>();
const failed=ref(false);
watch(()=>props.src,()=>{failed.value=false;});
</script>
<template>
  <img v-if="src&&!failed" :key="src" :src="src" :alt="alt" loading="lazy" decoding="async" @error="failed=true"/>
  <div v-else class="poster-placeholder" role="img" :aria-label="alt+'（暂无海报）'"><AppIcon name="player-play" :size="22"/><span>暂无海报</span></div>
</template>

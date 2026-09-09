<script setup lang="ts">
import { computed } from 'vue';
const props=defineProps<{name:string}>();
const paths:Record<string,string>={play:'M8 5v14l11-7z',pause:'M8 5v14M16 5v14',previous:'M6 4v16M19 5L8 12l11 7z',next:'M18 4v16M5 5l11 7-11 7z',repeat:'M4 7h14l-3-3m3 3-3 3M20 17H6l3 3m-3-3 3-3',shuffle:'M3 6h3c6 0 6 12 12 12h3m-4-4 4 4-4 4M3 18h3c2 0 3-2 4-4m4-4c1-2 2-4 4-4h3m-4-4 4 4-4 4',volume:'M3 9h4l5-5v16l-5-5H3zM16 8c3 2 3 6 0 8m3-11c5 4 5 10 0 14',mute:'M3 9h4l5-5v16l-5-5H3zM16 8l6 8m0-8-6 8',queue:'M4 6h16M4 12h16M4 18h10',heart:'M12 21S2 14 2 7c0-5 8-6 10 0 2-6 10-5 10 0 0 7-10 14-10 14z'};
const d=computed(()=>paths[props.name]??paths.play??'');
</script>
<template><svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path :d="d"/></svg></template>
<style scoped>svg{vertical-align:middle;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}</style>

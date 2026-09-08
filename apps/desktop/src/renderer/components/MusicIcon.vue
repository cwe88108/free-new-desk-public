<script setup lang="ts">
defineProps<{name:'library'|'artist'|'album'|'heart'|'heart-fill'|'plus'|'refresh'|'trash'|'stop'|'play'|'pause'|'previous'|'next'|'shuffle'|'repeat'|'repeat-one'|'volume'|'mute'|'queue'|'grip'|'search'|'check';size?:number}>();
</script>

<template>
  <svg class="music-icon" :width="size??18" :height="size??18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <template v-if="name==='library'"><path d="M5 5h14M5 10h14M5 15h9"/><circle cx="17" cy="17" r="3"/><path d="M20 17v-6"/></template>
    <template v-else-if="name==='artist'"><circle cx="12" cy="8" r="3.2"/><path d="M5.5 19c.7-4 3-6 6.5-6s5.8 2 6.5 6"/></template>
    <template v-else-if="name==='album'"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2"/><path d="M12 4v2M20 12h-2"/></template>
    <template v-else-if="name==='heart'||name==='heart-fill'"><path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10Z" :fill="name==='heart-fill'?'currentColor':'none'"/></template>
    <template v-else-if="name==='plus'"><path d="M12 5v14M5 12h14"/></template>
    <template v-else-if="name==='refresh'"><path d="M19 8a7 7 0 1 0 1 7"/><path d="M19 4v4h-4"/></template>
    <template v-else-if="name==='trash'"><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5"/></template>
    <template v-else-if="name==='stop'"><rect x="7" y="7" width="10" height="10" rx="1"/></template>
    <template v-else-if="name==='play'"><path d="m9 6 9 6-9 6Z" fill="currentColor" stroke="none"/></template>
    <template v-else-if="name==='pause'"><path d="M9 7v10M15 7v10" stroke-width="2.6"/></template>
    <template v-else-if="name==='previous'"><path d="M7 6v12M18 7l-8 5 8 5Z" fill="currentColor" stroke="none"/></template>
    <template v-else-if="name==='next'"><path d="M17 6v12M6 7l8 5-8 5Z" fill="currentColor" stroke="none"/></template>
    <template v-else-if="name==='shuffle'"><path d="M4 7h3c4 0 6 10 10 10h3M17 14l3 3-3 3M4 17h3c2 0 3-2 4-4M17 4l3 3-3 3"/></template>
    <template v-else-if="name==='repeat'||name==='repeat-one'"><path d="M7 6h9l3 3M19 9V5M17 18H8l-3-3M5 15v4"/><text v-if="name==='repeat-one'" x="10" y="15" font-size="7" fill="currentColor" stroke="none">1</text></template>
    <template v-else-if="name==='volume'||name==='mute'"><path d="M5 10v4h4l4 4V6L9 10Z"/><path v-if="name==='volume'" d="M16 9c1.5 1.5 1.5 4.5 0 6M18.5 6.5c3 3 3 8 0 11"/><path v-else d="m17 10 4 4M21 10l-4 4"/></template>
    <template v-else-if="name==='queue'"><path d="M5 7h9M5 12h9M5 17h6"/><path d="m16 15 4 2-4 2Z" fill="currentColor" stroke="none"/></template>
    <template v-else-if="name==='grip'"><circle cx="9" cy="8" r="1" fill="currentColor" stroke="none"/><circle cx="15" cy="8" r="1" fill="currentColor" stroke="none"/><circle cx="9" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="15" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="9" cy="16" r="1" fill="currentColor" stroke="none"/><circle cx="15" cy="16" r="1" fill="currentColor" stroke="none"/></template>
    <template v-else-if="name==='search'"><circle cx="10.5" cy="10.5" r="5.5"/><path d="m15 15 4 4"/></template>
    <template v-else-if="name==='check'"><path d="m5 12 4 4 10-10"/></template>
  </svg>
</template>

<style scoped>.music-icon{display:block;flex:none}</style>

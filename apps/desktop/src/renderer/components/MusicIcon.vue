<script setup lang="ts">
/**
 * 兼容封装：保留原有 name API（play/pause/previous/next/repeat/shuffle/volume/mute/queue/heart），
 * 内部统一走 AppIcon「宋刻金线」图标组，避免调用方改动。
 */
import { computed } from 'vue';
import AppIcon from './AppIcon.vue';

const props = withDefaults(defineProps<{ name: string; size?: number }>(), { size: 20 });

const ALIASES: Record<string, string> = {
  play: 'player-play',
  pause: 'player-pause',
  previous: 'player-prev',
  next: 'player-next',
  repeat: 'music-repeat',
  shuffle: 'music-shuffle',
  volume: 'player-volume',
  mute: 'player-mute',
  queue: 'music-queue',
  heart: 'music-heart'
};

const iconName = computed(() => ALIASES[props.name] ?? 'player-play');
</script>

<template>
  <AppIcon :name="iconName" :size="size" />
</template>

<script setup lang="ts">
/**
 * Free New Desk 图标组件 · 宋刻金线 V1
 * 24x24 母版网格 / 2px 圆头条描边 / 每枚最多一个实心“墨点”。
 * 设计说明见 icon-redesign-v1/Free-New-Desk-图标体系-宋刻金线-V1-设计说明.md
 * 命名规则：<组>-<键>，如 nav-home、player-play、action-filter。
 */
import { computed } from 'vue';

const props = defineProps<{
  name: string;
  size?: number | string;
  /** 细笔画场景（如 16px 行内按钮）可传 1.75 降级，默认 2 */
  strokeWidth?: number;
}>();

const ICON_BODY: Record<string, string> = {
  'nav-home': '<path d="M3.2 10.4 12 3.4l8.8 7"/><path d="M5.4 9v10.2a1.4 1.4 0 0 0 1.4 1.4h3.4v-5.4h3.6v5.4h3.4a1.4 1.4 0 0 0 1.4-1.4V9"/>',
  'nav-vod': '<rect x="2.8" y="7" width="12.6" height="10" rx="2.4"/><path d="m15.4 10.6 5.8-2.9v8.6l-5.8-2.9z"/>',
  'nav-live': '<rect x="2.6" y="7.2" width="18.8" height="13.6" rx="2.8"/><path d="M8.2 3.4 12 7.2l3.8-3.8"/><path class="solid" d="m10.4 10.9 5 2.7-5 2.7z"/>',
  'nav-music': '<path d="M9.6 17.8V6.3l9-1.8v11.1"/><circle cx="7" cy="17.8" r="2.6"/><circle cx="16" cy="15.7" r="2.6"/>',
  'nav-search': '<circle cx="10.6" cy="10.6" r="6.6"/><path d="m15.4 15.4 5.2 5.2"/>',
  'nav-star': '<path d="M12 3.4l2.61 5.29 5.84.85-4.22 4.12.99 5.81L12 16.73l-5.22 2.74.99-5.81L3.55 9.54l5.84-.85z"/>',
  'nav-star-filled': '<path class="solid" d="M12 3.4l2.61 5.29 5.84.85-4.22 4.12.99 5.81L12 16.73l-5.22 2.74.99-5.81L3.55 9.54l5.84-.85z"/>',
  'nav-clock': '<circle cx="12" cy="12" r="8.8"/><path d="M12 7.2V12l3.6 2.1"/>',
  'nav-layers': '<path d="m12 3.4 8.6 4.7-8.6 4.7-8.6-4.7z"/><path d="m3.4 12 8.6 4.7 8.6-4.7"/><path d="m3.4 16.3 8.6 4.7 8.6-4.7"/>',
  'nav-settings': '<path d="M3.4 7.4h9.2M17.2 7.4h3.4M3.4 16.6h3.4M11.4 16.6h9.2"/><circle cx="15" cy="7.4" r="2.4"/><circle cx="9" cy="16.6" r="2.4"/>',
  'nav-player': '<circle cx="12" cy="12" r="8.8"/><path class="solid" d="m10.3 8.4 5.4 3.6-5.4 3.6z"/>',
  'player-play': '<path class="solid" d="M7.4 4.6 19.2 12 7.4 19.4z"/>',
  'player-pause': '<path d="M9 4.8v14.4M15 4.8v14.4"/>',
  'player-prev': '<path d="M6.6 4.8v14.4"/><path class="solid" d="M18.2 5.6 9.4 12l8.8 6.4z"/>',
  'player-next': '<path d="M17.4 4.8v14.4"/><path class="solid" d="M5.8 5.6 14.6 12l-8.8 6.4z"/>',
  'player-rewind': '<path class="solid" d="M11.8 6.2 4.6 12l7.2 5.8zM20.2 6.2 13 12l7.2 5.8z"/>',
  'player-forward': '<path class="solid" d="M12.2 6.2 19.4 12l-7.2 5.8zM3.8 6.2 11 12l-7.2 5.8z"/>',
  'player-volume': '<path d="M4.4 9.4h3.4L12.6 5v14l-4.8-4.4H4.4z"/><path d="M15.8 9a4.2 4.2 0 0 1 0 6M18.6 6.2a8.2 8.2 0 0 1 0 11.6"/>',
  'player-mute': '<path d="M4.4 9.4h3.4L12.6 5v14l-4.8-4.4H4.4z"/><path d="m16.4 9.2 5 5.6M21.4 9.2l-5 5.6"/>',
  'player-fullscreen': '<path d="M4 9.2V5.6A1.6 1.6 0 0 1 5.6 4H9.2M14.8 4h3.6A1.6 1.6 0 0 1 20 5.6v3.6M20 14.8v3.6a1.6 1.6 0 0 1-1.6 1.6h-3.6M9.2 20H5.6A1.6 1.6 0 0 1 4 18.4v-3.6"/>',
  'player-exit-fullscreen': '<path d="M9.2 4v3.6A1.6 1.6 0 0 1 7.6 9.2H4M20 9.2h-3.6A1.6 1.6 0 0 1 14.8 7.6V4M14.8 20v-3.6a1.6 1.6 0 0 1 1.6-1.6H20M4 14.8h3.6a1.6 1.6 0 0 1 1.6 1.6V20"/>',
  'player-pip': '<rect x="2.8" y="4.6" width="18.4" height="14.8" rx="2.6"/><rect x="12" y="11.6" width="7" height="5.4" rx="1.4"/>',
  'player-subtitles': '<rect x="2.8" y="5.2" width="18.4" height="13.6" rx="2.6"/><path d="M6.6 14.4h4.2M13.2 14.4h4.2M6.6 10.4h6.4M15.6 10.4h1.8"/>',
  'player-audio': '<path d="M3.4 10.6v2.8M6.9 7.8v8.4M10.4 5.4v13.2M13.9 8.6v6.8M17.4 6.6v10.8M20.9 10.2v3.6"/>',
  'player-speed': '<path d="M3.6 17.6a8.4 8.4 0 1 1 16.8 0"/><path d="m12 13.4 3.6-3.2"/><circle class="solid" cx="12" cy="13.4" r="1.5"/>',
  'player-screenshot': '<rect x="2.6" y="7.4" width="18.8" height="12.4" rx="2.4"/><path d="M7.6 7.4l1.5-2.4h5.8l1.5 2.4"/><circle cx="12" cy="13.6" r="3.3"/>',
  'player-route': '<circle cx="5.6" cy="6" r="2.4"/><circle cx="18.4" cy="18" r="2.4"/><path d="M8 6h5.6a3 3 0 0 1 3 3v5.4"/>',
  'player-list': '<path d="M4.2 6.6h2.2M10 6.6h9.8M4.2 12h2.2M10 12h9.8M4.2 17.4h2.2M10 17.4h9.8"/>',
  'player-cast': '<path d="M3.4 8.4V6.2a1.8 1.8 0 0 1 1.8-1.8h13.6a1.8 1.8 0 0 1 1.8 1.8v11.6a1.8 1.8 0 0 1-1.8 1.8h-6"/><path d="M3.4 12.6a7.4 7.4 0 0 1 7.4 7.4M3.4 17a3 3 0 0 1 3 3"/><circle class="solid" cx="3.9" cy="20.1" r="1.1"/>',
  'player-record': '<circle cx="12" cy="12" r="8.8"/><circle class="solid" cx="12" cy="12" r="3.2"/>',
  'action-grid': '<rect x="3.2" y="3.2" width="7.4" height="7.4" rx="2"/><rect x="13.4" y="3.2" width="7.4" height="7.4" rx="2"/><rect x="3.2" y="13.4" width="7.4" height="7.4" rx="2"/><rect x="13.4" y="13.4" width="7.4" height="7.4" rx="2"/>',
  'action-filter': '<path d="M3.6 5.4h16.8l-6.4 7.6v5.6l-4-2.2v-3.4z"/>',
  'action-sparkle': '<path d="M11.4 3.4l1.8 5 5 1.8-5 1.8-1.8 5-1.8-5-5-1.8 5-1.8z"/><path class="solid" d="M18.4 14.6l.9 2.4 2.4.9-2.4.9-.9 2.4-.9-2.4-2.4-.9 2.4-.9z"/>',
  'action-refresh': '<path d="M20.4 11.6a8.4 8.4 0 1 1-8.4-8.4c2.6 0 4.9 1.2 6.4 3"/><path d="M20.6 3.6v6.2h-6.2"/>',
  'action-update': '<path d="M12 3.4v11.2M7.6 10.2 12 14.6l4.4-4.4M4 20.6h16"/>',
  'action-import': '<path d="M3.4 8.2V6a1.8 1.8 0 0 1 1.8-1.8h4l2 2.4h7.8a1.8 1.8 0 0 1 1.8 1.8v10a1.8 1.8 0 0 1-1.8 1.8H5.2a1.8 1.8 0 0 1-1.8-1.8z"/><path d="M12 11v5M9.6 13.6 12 16l2.4-2.4"/>',
  'action-export': '<path d="M3.4 8.2V6a1.8 1.8 0 0 1 1.8-1.8h4l2 2.4h7.8a1.8 1.8 0 0 1 1.8 1.8v10a1.8 1.8 0 0 1-1.8 1.8H5.2a1.8 1.8 0 0 1-1.8-1.8z"/><path d="M12 16v-5M9.6 13.4 12 11l2.4 2.4"/>',
  'action-copy': '<rect x="8.6" y="8.6" width="11.8" height="11.8" rx="2.6"/><path d="M15.4 5.6v-.4a2.2 2.2 0 0 0-2.2-2.2H5.6a2.2 2.2 0 0 0-2.2 2.2v7.6a2.2 2.2 0 0 0 2.2 2.2h.4"/>',
  'action-trash': '<path d="M3.8 6.4h16.4M9.2 6.4V4.6a1.4 1.4 0 0 1 1.4-1.4h2.8a1.4 1.4 0 0 1 1.4 1.4v1.8M6.2 6.4l.9 13.2a1.8 1.8 0 0 0 1.8 1.7h6.2a1.8 1.8 0 0 0 1.8-1.7l.9-13.2M10.2 10.4v7.2M13.8 10.4v7.2"/>',
  'action-edit': '<path d="M4 20l1-4.6L16.3 4.1a2.1 2.1 0 0 1 3 0l.6.6a2.1 2.1 0 0 1 0 3L8.5 19z"/><path d="m14.6 5.8 3.6 3.6"/>',
  'action-toggle-on': '<rect x="2.6" y="7" width="18.8" height="10" rx="5"/><circle class="solid" cx="16.8" cy="12" r="2.6"/>',
  'action-toggle-off': '<rect x="2.6" y="7" width="18.8" height="10" rx="5"/><circle cx="7.2" cy="12" r="2.6"/>',
  'action-speedtest': '<path d="M13.4 2.6 5.8 13.4h4.8l-1 8 7.6-10.8h-4.8z"/>',
  'action-reserve': '<rect x="3" y="5.2" width="18" height="15.6" rx="2.6"/><path d="M7.8 3v4.4M16.2 3v4.4M3 9.8h18"/><circle class="solid" cx="12" cy="15" r="1.8"/>',
  'action-epg': '<rect x="3" y="4.8" width="18" height="14.4" rx="2.4"/><path d="M8.4 4.8v14.4M3 9.6h18M3 14.4h18"/>',
  'action-close': '<path d="M6.4 6.4l11.2 11.2M17.6 6.4 6.4 17.6"/>',
  'action-more': '<circle class="solid" cx="5.4" cy="12" r="1.5"/><circle class="solid" cx="12" cy="12" r="1.5"/><circle class="solid" cx="18.6" cy="12" r="1.5"/>',
  'action-back': '<path d="M19.2 12H4.8M11.4 5.4 4.8 12l6.6 6.6"/>',
  'action-enter': '<path d="M4.8 12h14.4M12.6 5.4 19.2 12l-6.6 6.6"/>',
  'action-arrow-up': '<path d="M12 19.2V4.8M5.6 11.2 12 4.8l6.4 6.4"/>',
  'action-arrow-down': '<path d="M12 4.8v14.4M5.6 12.8 12 19.2l6.4-6.4"/>',
  'action-chevron-up': '<path d="M6.4 14.6 12 9l5.6 5.6"/>',
  'action-chevron-down': '<path d="M6.4 9.4 12 15l5.6-5.6"/>',
  'music-queue': '<path d="M3.6 6.8h10.8M3.6 11.6h10.8M3.6 16.4h6.8"/><path class="solid" d="M15.4 14.6v6l4.6-3z"/>',
  'music-shuffle': '<path d="M3.6 6.6h3.4c5.2 0 5.2 10.8 10.4 10.8h3M17.4 14.4l3 3-3 3M3.6 17.4h3.4c1.9 0 3.1-1.4 4.2-3M14.8 9.6c1.1-1.6 2.3-3 4.2-3h2.4M17.4 3.6l3 3-3 3"/>',
  'music-repeat': '<path d="M4.6 7.4h14.8l-3.2-3.2M19.4 7.4l-3.2 3.2M19.4 16.6H4.6l3.2 3.2M4.6 16.6l3.2-3.2"/>',
  'music-repeat-one': '<path d="M4.6 7.4h13.2l-2.8-2.8M17.8 7.4l-2.8 2.8M19.4 16.6H6.2l2.8 2.8M6.2 16.6l2.8-2.8"/><path d="M11.2 11.4 12.2 10.6v5M10.6 15.6h3.2"/>',
  'music-heart': '<path d="M12 20.4S3.6 14.8 3.6 8.9A4.3 4.3 0 0 1 12 6.6a4.3 4.3 0 0 1 8.4 2.3c0 5.9-8.4 11.5-8.4 11.5z"/>',
  'music-lyrics': '<path d="M4.4 6.2h15.2M4.4 11h10M4.4 15.8h6.4"/><path d="M18.2 9.6v6.6"/><circle class="solid" cx="17.2" cy="17" r="1.7"/>',
  'music-disc': '<circle cx="12" cy="12" r="8.8"/><circle cx="12" cy="12" r="2.6"/>',
  'music-artist': '<circle cx="12" cy="8.4" r="3.8"/><path d="M4.6 20.6c0-3.9 3.3-6 7.4-6s7.4 2.1 7.4 6"/>',
  'state-check': '<circle cx="12" cy="12" r="8.8"/><path d="m8.2 12.2 2.6 2.6 5-5.4"/>',
  'state-alert': '<circle cx="12" cy="12" r="8.8"/><path d="M12 7.6v5.6"/><circle class="solid" cx="12" cy="16.4" r="1.2"/>',
  'state-warning': '<path d="M12 3.6 21.2 19.4a1.6 1.6 0 0 1-1.4 2.4H4.2a1.6 1.6 0 0 1-1.4-2.4z"/><path d="M12 9.4v4.4"/><circle class="solid" cx="12" cy="17.2" r="1.2"/>',
  'state-info': '<circle cx="12" cy="12" r="8.8"/><path d="M12 11.2v5.2"/><circle class="solid" cx="12" cy="7.9" r="1.2"/>'
};

const body = computed(() => ICON_BODY[props.name] ?? '');
const dimension = computed(() => (typeof props.size === 'number' ? `${props.size}px` : props.size ?? '20px'));
</script>

<template>
  <svg
    class="app-icon"
    viewBox="0 0 24 24"
    :width="dimension"
    :height="dimension"
    :style="strokeWidth ? { strokeWidth } : undefined"
    aria-hidden="true"
    focusable="false"
  >
    <g v-html="body" />
  </svg>
</template>

<style scoped>
.app-icon {
  display: inline-block;
  flex: none;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
  vertical-align: middle;
}
.app-icon :deep(.solid) {
  fill: currentColor;
  stroke: none;
}
</style>

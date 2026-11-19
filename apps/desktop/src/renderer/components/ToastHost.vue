<script setup lang="ts">
import { useToastStore } from '../stores/toast';
import AppIcon from './AppIcon.vue';
const toast=useToastStore();
</script>

<template>
  <div class="toast-host" aria-live="polite" role="status">
    <transition-group name="toast">
      <div v-for="item in toast.items" :key="item.id" class="toast-item" :class="item.level">
        <span class="toast-dot" aria-hidden="true"/>
        <div class="toast-copy"><strong>{{item.title}}</strong><small v-if="item.detail">{{item.detail}}</small></div>
        <button class="toast-close" aria-label="关闭通知" @click="toast.dismiss(item.id)"><AppIcon name="action-close" :size="13"/></button>
      </div>
    </transition-group>
  </div>
</template>

<style scoped>
.toast-copy{min-width:0}
.toast-leave-active{transition:opacity .18s ease,transform .18s ease}
.toast-leave-to{opacity:0;transform:translateY(6px)}
@media (prefers-reduced-motion:reduce){.toast-leave-active{transition:none}}
</style>

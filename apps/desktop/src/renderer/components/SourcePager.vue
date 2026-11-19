<script setup lang="ts">
import {computed,nextTick,ref} from 'vue';
import {clampSourcePage,sourcePageCount,SOURCE_PAGE_SIZE} from '../source-pagination';
const props=defineProps<{label:string;page:number;total:number}>();
const emit=defineEmits<{change:[page:number]}>();
const current=computed(()=>clampSourcePage(props.page,props.total));
const count=computed(()=>sourcePageCount(props.total));
const pageSelect=ref<HTMLSelectElement|null>(null);
async function changeFromButton(page:number,event:MouseEvent){
  const button=event.currentTarget as HTMLButtonElement;
  const hadFocus=document.activeElement===button;
  emit('change',page);
  await nextTick();
  if(hadFocus&&button.disabled&&(document.activeElement===button||document.activeElement===document.body)){
    pageSelect.value?.focus({preventScroll:true});
  }
}
</script>
<template>
  <nav v-if="total>SOURCE_PAGE_SIZE" class="source-pagination" :aria-label="label+'分页'">
    <span role="status">共 {{total}} 项，每页 {{SOURCE_PAGE_SIZE}} 项</span>
    <button type="button" :disabled="current===1" :aria-label="label+'上一页'" @click="changeFromButton(current-1,$event)">上一页</button>
    <label>页码 <select ref="pageSelect" :aria-label="label+'页码'" :value="current" @change="emit('change',Number(($event.target as HTMLSelectElement).value))"><option v-for="number in count" :key="number" :value="number">{{number}} / {{count}}</option></select></label>
    <button type="button" :disabled="current===count" :aria-label="label+'下一页'" @click="changeFromButton(current+1,$event)">下一页</button>
  </nav>
</template>
<style scoped>
.source-pagination{display:flex;align-items:center;flex-wrap:wrap;gap:8px;padding:8px 0;font-size:12px;color:var(--muted)}
.source-pagination button,.source-pagination select{border:1px solid var(--line);border-radius:5px;padding:5px 8px;background:var(--surface);color:var(--text)}
.source-pagination button:disabled{opacity:.5;cursor:default}
</style>

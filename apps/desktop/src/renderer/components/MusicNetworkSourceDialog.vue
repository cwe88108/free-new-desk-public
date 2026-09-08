<script setup lang="ts">
import { computed,ref,watch } from 'vue';
import type { MusicSource } from '@free-new-desk/contracts';
const props=defineProps<{open:boolean}>();const emit=defineEmits<{close:[];saved:[source:MusicSource,count:number]}>();
const kind=ref<'webdav'|'smb'>('webdav');const name=ref('');const root=ref('');const username=ref('');const password=ref('');const rememberCredential=ref(true);const saving=ref(false);const error=ref('');
const rootPlaceholder=computed(()=>kind.value==='webdav'?'https://example.com/dav/music/':'\\\\NAS\\Music');
watch(()=>props.open,value=>{if(value){error.value='';password.value='';}});
function close(){if(!saving.value)emit('close');}
function requestPayload(disconnectConflicts=false){return{kind:kind.value,name:name.value.trim(),root:root.value.trim(),...(username.value.trim()?{username:username.value.trim()}:{}),...(password.value?{password:password.value}:{}),rememberCredential:rememberCredential.value,...(disconnectConflicts?{disconnectConflicts:true}:{})};}
async function addNetworkSource(){
  try{return await window.desktop.music.addNetworkSource(requestPayload());}
  catch(value){const message=value instanceof Error?value.message:String(value);if(kind.value!=='smb'||!message.includes('[SMB_CREDENTIAL_CONFLICT:1219]'))throw value;const readable=message.replace(/^.*\[SMB_CREDENTIAL_CONFLICT:1219\]\s*/,''),approved=window.confirm(`${readable}\n\næ˜¯å¦åªæ–­å¼€è¿™ä¸ª NAS æœåŠ¡å™¨çš„å†²çªè¿žæŽ¥ï¼Œå¹¶ä½¿ç”¨å½“å‰å¡«å†™çš„è´¦å·é‡æ–°è¿žæŽ¥ï¼Ÿä¸ä¼šæ–­å¼€å…¶ä»–æœåŠ¡å™¨ã€‚`);if(!approved)throw new Error(readable);return window.desktop.music.addNetworkSource(requestPayload(true));}
}
async function save(){const safeName=name.value.trim(),safeRoot=root.value.trim();if(!safeName||!safeRoot){error.value='è¯·å¡«å†™æ¥æºåç§°å’Œåœ°å€ã€‚';return;}saving.value=true;error.value='';try{const result=await addNetworkSource();emit('saved',result.source,result.count);name.value='';root.value='';username.value='';password.value='';}catch(value){error.value=(value instanceof Error?value.message:String(value)).replace(/^.*\[SMB_(?:CREDENTIAL_CONFLICT|NET_ERROR):[^\]]+\]\s*/,'');}finally{saving.value=false;}}
</script>
<template>
  <dialog :open="open" class="music-source-dialog" @cancel.prevent="close">
    <form method="dialog" @submit.prevent="save">
      <header><div><small>网络音乐来源</small><h2>添加 WebDAV / SMB</h2></div><button type="button" aria-label="关闭" @click="close">×</button></header>
      <label>类型<select v-model="kind"><option value="webdav">WebDAV</option><option value="smb">SMB / Windows 共享</option></select></label>
      <label>来源名称<input v-model="name" maxlength="80" autocomplete="off" placeholder="例如：家庭音乐库"/></label>
      <label>{{kind==='webdav'?'WebDAV 地址':'SMB UNC 路径'}}<input v-model="root" autocomplete="off" :placeholder="rootPlaceholder"/></label>
      <div class="two"><label>用户名<input v-model="username" autocomplete="username" placeholder="可选"/></label><label>密码<input v-model="password" type="password" autocomplete="current-password" placeholder="可选"/></label></div>
      <label class="remember"><input v-model="rememberCredential" type="checkbox"/>使用 Windows 安全存储加密保存凭据</label>
      <p class="hint">WebDAV 播放通过仅监听 127.0.0.1 的 Range Bridge 转发；SMB 使用 Windows UNC 会话。密码不会写入播放 URL。</p>
      <p v-if="error" class="error" role="alert">{{error}}</p>
      <footer><button type="button" class="secondary-button" :disabled="saving" @click="close">取消</button><button class="accent-button" :disabled="saving" type="submit">{{saving?'正在连接并扫描…':'添加并扫描'}}</button></footer>
    </form>
  </dialog>
</template>

<style scoped>
.music-source-dialog{position:fixed;inset:0;margin:auto;width:min(520px,calc(100vw - 36px));border:1px solid var(--line);border-radius:12px;background:var(--surface);color:var(--text);box-shadow:0 18px 60px rgba(0,0,0,.28);z-index:7000}.music-source-dialog::backdrop{background:rgba(0,0,0,.32);backdrop-filter:blur(3px)}form{display:grid;gap:14px;padding:18px}header,footer,.two{display:flex;gap:10px;align-items:center}header{justify-content:space-between;border-bottom:1px solid var(--line);padding-bottom:10px}header h2{margin:2px 0 0;font-size:20px}header small,.hint{color:var(--muted)}header>button{border:0;background:transparent;color:inherit;font-size:24px}.two>*{flex:1}label{display:grid;gap:6px;font-size:12px}input,select{min-width:0;padding:9px 10px;border:1px solid var(--line);border-radius:7px;background:var(--surface-1);color:inherit}.remember{display:flex;grid-template-columns:auto 1fr;align-items:center}.hint{margin:0;font-size:11px;line-height:1.55}.error{margin:0;padding:8px 10px;border:1px solid #d45858;border-radius:7px;background:rgba(180,45,45,.1)}footer{justify-content:flex-end;border-top:1px solid var(--line);padding-top:12px}.accent-button,.secondary-button{height:36px;padding:0 14px;border-radius:7px}.accent-button{background:#a76318;border:1px solid #a76318;color:white}.secondary-button{border:1px solid var(--line);background:var(--surface-1);color:inherit}
</style>

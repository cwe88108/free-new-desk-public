<script setup lang="ts">
import { computed,ref,watch } from 'vue';
import type { MusicSource } from '@free-new-desk/contracts';
const props=defineProps<{open:boolean}>();const emit=defineEmits<{close:[];saved:[source:MusicSource,count:number]}>();
const kind=ref<'webdav'|'smb'>('webdav'),name=ref(''),root=ref(''),username=ref(''),password=ref(''),rememberCredential=ref(true),saving=ref(false),error=ref('');
const rootPlaceholder=computed(()=>kind.value==='webdav'?'https://example.com/dav/music/':'\\\\NAS\\Music');
watch(()=>props.open,value=>{if(value){error.value='';password.value='';}});
function close(){if(!saving.value)emit('close');}
function messageOf(value:unknown){return(value instanceof Error?value.message:String(value)).replace(/^Error invoking remote method '[^']+': (?:Error: )?/,'');}
async function resolveConflict(){saving.value=true;try{const result=await window.desktop.music.resolveSmbConflict(root.value);error.value=result.message;}catch(value){error.value=messageOf(value);}finally{saving.value=false;}}
async function useExisting(){username.value='';password.value='';rememberCredential.value=false;await save();}
async function save(){const safeName=name.value.trim(),safeRoot=root.value.trim();if(!safeName||!safeRoot){error.value='请填写来源名称和地址。';return;}saving.value=true;error.value='';try{const result=await window.desktop.music.addNetworkSource({kind:kind.value,name:safeName,root:safeRoot,...(username.value.trim()?{username:username.value.trim()}:{}),...(password.value?{password:password.value}:{}),rememberCredential:rememberCredential.value});emit('saved',result.source,result.count);name.value='';root.value='';username.value='';password.value='';}catch(value){error.value=messageOf(value);}finally{saving.value=false;}}
</script>

<template>
  <dialog :open="open" class="music-source-dialog" @cancel.prevent="close"><form method="dialog" @submit.prevent="save">
    <header><div><small>网络音乐来源</small><h2>添加 WebDAV / SMB</h2></div><button type="button" aria-label="关闭" @click="close">×</button></header>
    <label>类型<select v-model="kind"><option value="webdav">WebDAV</option><option value="smb">SMB / Windows 共享</option></select></label>
    <label>来源名称<input v-model="name" maxlength="80" autocomplete="off" placeholder="例如：家庭音乐库"/></label>
    <label>{{kind==='webdav'?'WebDAV 地址':'SMB UNC 路径'}}<input v-model="root" autocomplete="off" :placeholder="rootPlaceholder"/></label>
    <div class="two"><label>用户名<input v-model="username" autocomplete="username" placeholder="可选"/></label><label>密码<input v-model="password" type="password" autocomplete="current-password" placeholder="可选"/></label></div>
    <label class="remember"><input v-model="rememberCredential" type="checkbox"/>使用 Windows 安全存储加密保存凭据</label>
    <p class="hint">填写 NAS 共享地址及有访问权限的账号；如 Windows 已连接该共享，可留空账号使用现有连接。密码只通过受限管道传给 Windows 网络 API，不进入命令行或播放 URL。</p>
    <p v-if="error" class="error" role="alert">{{error}}</p>
    <div v-if="kind==='smb'&&(error.includes('SMB_CREDENTIAL_CONFLICT')||error.includes('1219'))" class="two conflict-actions"><button type="button" :disabled="saving" @click="useExisting">使用现有 Windows 会话</button><button type="button" :disabled="saving" @click="resolveConflict">查看并处理冲突连接</button></div>
    <footer><button type="button" class="secondary-button" :disabled="saving" @click="close">取消</button><button class="accent-button" :disabled="saving" type="submit">{{saving?'正在连接并扫描…':'添加并扫描'}}</button></footer>
  </form></dialog>
</template>
<style scoped>
.music-source-dialog{position:fixed;inset:0;margin:auto;width:min(520px,calc(100vw - 36px));border:1px solid var(--line);border-radius:12px;background:var(--surface);color:var(--text);box-shadow:0 18px 60px rgba(0,0,0,.28);z-index:7000}.music-source-dialog::backdrop{background:rgba(0,0,0,.32);backdrop-filter:blur(3px)}
form{display:grid;gap:14px;padding:18px}header,footer,.two{display:flex;gap:10px;align-items:center}header{justify-content:space-between;border-bottom:1px solid var(--line);padding-bottom:10px}header h2{margin:2px 0 0;font-size:20px}header small,.hint{color:var(--muted)}header>button{border:0;background:transparent;color:inherit;font-size:24px}
.two>*{flex:1}label{display:grid;gap:6px;font-size:12px}input,select{min-width:0;padding:9px 10px;border:1px solid var(--line);border-radius:7px;background:var(--surface-1);color:inherit}.remember{display:flex;grid-template-columns:auto 1fr;align-items:center}.hint{margin:0;font-size:11px;line-height:1.55}.error{margin:0;padding:8px 10px;border:1px solid #d45858;border-radius:7px;background:rgba(180,45,45,.1);white-space:pre-wrap}.conflict-actions button{min-height:36px;border:1px solid var(--line);border-radius:7px;background:var(--surface-1);color:inherit}
footer{justify-content:flex-end;border-top:1px solid var(--line);padding-top:12px}.accent-button,.secondary-button{height:36px;padding:0 14px;border-radius:7px}.accent-button{background:#a76318;border:1px solid #a76318;color:white}.secondary-button{border:1px solid var(--line);background:var(--surface-1);color:inherit}
</style>

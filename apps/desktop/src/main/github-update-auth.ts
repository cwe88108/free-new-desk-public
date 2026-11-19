import {safeStorage} from 'electron';
import type {DataService} from '@free-new-desk/data-service';

export const GITHUB_UPDATE_CREDENTIAL_KEY='update.credential.github';
type Store=Pick<DataService,'getSetting'|'setSetting'>;
function encryptionAvailable():boolean{return safeStorage.isEncryptionAvailable()&&(process.platform!=='linux'||safeStorage.getSelectedStorageBackend()!=='basic_text');}
export function validateGitHubUpdateToken(value:unknown):string{
  if(typeof value!=='string'||!(/^[A-Za-z0-9_]{20,512}$/).test(value.trim()))throw new Error('请输入本人GitHub账号签发的有效只读令牌');
  return value.trim();
}
export function readGitHubUpdateToken(store:Store):string{
  const encrypted=store.getSetting(GITHUB_UPDATE_CREDENTIAL_KEY);
  if(!encrypted)throw new Error('[UPDATE_AUTH_REQUIRED] 请在更新设置中授权本人GitHub账号访问私有仓库');
  if(!encryptionAvailable())throw new Error('[UPDATE_AUTH_UNAVAILABLE] 系统安全凭据存储不可用，请恢复后重试');
  try{return validateGitHubUpdateToken(safeStorage.decryptString(Buffer.from(encrypted,'base64')));}
  catch{throw new Error('[UPDATE_AUTH_UNAVAILABLE] 本机保存的GitHub授权无法读取，请重新授权');}
}
export function githubUpdateAuthorization(store:Store):{configured:boolean;encryptionAvailable:boolean}{
  let configured=false;try{readGitHubUpdateToken(store);configured=true;}catch{/* status never exposes credential data */}
  return{configured,encryptionAvailable:encryptionAvailable()};
}
export function saveGitHubUpdateToken(store:Store,value:unknown):void{
  const token=validateGitHubUpdateToken(value);
  if(!encryptionAvailable())throw new Error('系统安全凭据存储不可用，未保存GitHub令牌');
  store.setSetting(GITHUB_UPDATE_CREDENTIAL_KEY,safeStorage.encryptString(token).toString('base64'));
}
export function forgetGitHubUpdateToken(store:Store):void{
  store.setSetting(GITHUB_UPDATE_CREDENTIAL_KEY,'');
  store.setSetting('update.lastAttempt','');
  store.setSetting('update.lastCheck','');
  store.setSetting('update.lastResult','');
  store.setSetting('update.lastError','[UPDATE_AUTH_REQUIRED] 本机GitHub授权已移除');
}
export function publicUpdateSettings(store:Pick<DataService,'listSettings'>):Record<string,string>{
  return Object.fromEntries(Object.entries(store.listSettings()).filter(([key])=>key!==GITHUB_UPDATE_CREDENTIAL_KEY));
}

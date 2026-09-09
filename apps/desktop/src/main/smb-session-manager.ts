import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import path from 'node:path';
export interface SmbCredentials{username?:string;password?:string;}
export function smbShareRoot(root:string):string|undefined{
  const match=/^\\\\([^\\\0]+)\\([^\\\0]+)(?:\\|$)/.exec(root.replaceAll('/','\\'));
  if(!match||['?','.'].includes(match[1]!))return;
  return `\\\\${match[1]}\\${match[2]}`;
}
export class SmbError extends Error{
  readonly errorCode:number;
  constructor(code:number){
    const info:Record<number,[string,string]>={3:['SMB_PATH_NOT_FOUND','共享中的目标路径不存在。'],5:['SMB_ACCESS_DENIED','没有共享目录访问权限。'],53:['SMB_UNREACHABLE','服务器不可达，请检查网络及地址。'],64:['SMB_CONNECTION_LOST','NAS 连接已中断，请检查网络后重试。'],67:['SMB_SHARE_NOT_FOUND','找不到共享目录。'],86:['SMB_INVALID_PASSWORD','密码错误。'],1219:['SMB_CREDENTIAL_CONFLICT','Windows 已使用其他凭据连接同一服务器。可尝试使用现有 Windows 会话，或查看冲突连接。'],1231:['SMB_NETWORK_UNREACHABLE','当前网络无法访问 NAS。'],1232:['SMB_HOST_UNREACHABLE','无法访问 NAS 主机。'],1326:['SMB_LOGON_FAILED','用户名或密码错误。'],1460:['SMB_TIMEOUT','连接操作超时，请检查网络后重试。'],2250:['SMB_NOT_CONNECTED','共享当前没有连接。'],2401:['SMB_IN_USE','连接正在使用中，请先关闭占用文件。']};
    const [key,message]=info[code]??['SMB_CONNECTION_FAILED','无法连接 NAS，请检查共享地址、权限和网络。'];
    super(`[${key} / ${code}] ${message}`);this.name='SmbError';this.errorCode=code;
  }
}
type NativeResult={errorCode:number;shares?:string[];complete?:boolean};
const locks=new Map<string,Promise<unknown>>();
const sessions=new Map<string,{ownership:'owned'|'reused';connectedAt:number}>();
function helperPath():string{return process.resourcesPath?path.join(process.resourcesPath,'native','player-host','smb-helper.exe'):path.resolve('native/player-host/build/Release/smb-helper.exe');}
async function probeDirectory(root:string,timeoutMs=5000):Promise<boolean>{let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([stat(root).then(value=>value.isDirectory()).catch(()=>false),new Promise<boolean>(resolve=>{timer=setTimeout(()=>resolve(false),timeoutMs);})]);}finally{if(timer)clearTimeout(timer);}}
async function native(action:'connect'|'list'|'disconnect',share:string,credentials:SmbCredentials={}):Promise<NativeResult>{
  const packaged=helperPath(),executable=await stat(packaged).then(()=>packaged).catch(()=>path.resolve('native/player-host/build/Release/smb-helper.exe'));
  const values=[action,share,credentials.username??'',credentials.password??''];
  const fields=values.map(value=>{const bytes=Buffer.from(value,'utf8');if(bytes.length>16384||value.includes('\0'))throw new Error('SMB 参数无效');const length=Buffer.alloc(4);length.writeUInt32LE(bytes.length);return Buffer.concat([length,bytes]);});
  const payload=Buffer.concat(fields);
  return new Promise((resolve,reject)=>{
    const child=spawn(executable,[],{windowsHide:true,stdio:['pipe','pipe','ignore']});let output=Buffer.alloc(0),settled=false;
    const finish=(error?:Error,value?:NativeResult)=>{if(settled)return;settled=true;clearTimeout(timer);payload.fill(0);for(const field of fields)field.fill(0);if(error)reject(error);else resolve(value!);};
    const timer=setTimeout(()=>{child.kill();finish(new SmbError(1460));},20000);
    child.on('error',()=>finish(new Error('SMB 原生辅助程序不可用，请重新安装当前版本。')));
    child.stdout.on('data',(chunk:Buffer)=>{if(output.length+chunk.length>65536){child.kill();finish(new Error('SMB 响应超过上限'));}else output=Buffer.concat([output,chunk]);});
    child.on('close',()=>{try{const value=JSON.parse(output.toString('utf8')) as NativeResult;if(!Number.isInteger(value.errorCode))throw 0;finish(undefined,value);}catch{finish(new Error('SMB 原生响应无效'));}});
    child.stdin.on('error',()=>finish(new Error('SMB 凭据管道已关闭')));child.stdin.end(payload);
  });
}
async function exclusive<T>(root:string,work:()=>Promise<T>):Promise<T>{const server=root.split('\\')[2]!.toLowerCase(),previous=locks.get(server)??Promise.resolve();const pending=previous.catch(()=>undefined).then(work);locks.set(server,pending);try{return await pending;}finally{if(locks.get(server)===pending)locks.delete(server);}}
export async function ensureSmbConnection(root:string,credentials?:SmbCredentials):Promise<void>{
  if(process.platform!=='win32')throw new Error('SMB 音乐源仅在 Windows 上受支持');const share=smbShareRoot(root);if(!share)throw new Error('SMB 地址必须是 \\\\server\\share 形式');
  return exclusive(share,async()=>{
    if(await probeDirectory(root)){sessions.set(share,{ownership:'reused',connectedAt:Date.now()});return;}
    const result=await native('connect',share,credentials);if(result.errorCode){if(await probeDirectory(root)){sessions.set(share,{ownership:'reused',connectedAt:Date.now()});return;}throw new SmbError(result.errorCode);}
    sessions.set(share,{ownership:'owned',connectedAt:Date.now()});if(!await probeDirectory(root))throw new SmbError(3);
  });
}
export async function listSmbConnections(root:string):Promise<string[]>{
  const share=smbShareRoot(root);if(!share)throw new Error('无效共享路径');const result=await native('list',share);if(result.errorCode)throw new SmbError(result.errorCode);
  return [...new Set((result.shares??[]).map(value=>smbShareRoot(value)).filter((value):value is string=>Boolean(value)))];
}
/** Only call after explicit in-app confirmation and after releasing app handles. */
export async function disconnectSmbShare(root:string):Promise<void>{const share=smbShareRoot(root);if(!share)throw new Error('无效共享路径');await exclusive(share,async()=>{const result=await native('disconnect',share);if(result.errorCode&&result.errorCode!==2250)throw new SmbError(result.errorCode);sessions.delete(share);});}
/** Windows connections can be reused by other apps: never disconnect them on exit. */
export async function disconnectSmbConnections():Promise<void>{sessions.clear();}

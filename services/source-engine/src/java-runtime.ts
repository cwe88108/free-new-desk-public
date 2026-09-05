import { spawn } from 'node:child_process';

export interface JavaRuntimeInfo{command:string;major:number;version:string;}

export async function probeJavaRuntime(command=process.env.FREE_NEW_DESK_JAVA?.trim()||'java',timeoutMs=5_000):Promise<JavaRuntimeInfo>{
  return new Promise((resolve,reject)=>{
    let settled=false,output='';
    const child=spawn(command,['-version'],{windowsHide:true,stdio:['ignore','pipe','pipe']});
    const finish=(error:Error|null,value?:JavaRuntimeInfo)=>{if(settled)return;settled=true;clearTimeout(timer);if(error)reject(error);else resolve(value as JavaRuntimeInfo);};
    const timer=setTimeout(()=>{child.kill();finish(new Error('[SRC_JAVA_NOT_FOUND] Java 17+ runtime probe timed out'));},timeoutMs);
    child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
    child.stdout.on('data',chunk=>{output+=chunk;});child.stderr.on('data',chunk=>{output+=chunk;});
    child.once('error',()=>finish(new Error('[SRC_JAVA_NOT_FOUND] 未找到 Java 17+ Runtime，请安装 Java 17+ 或设置 FREE_NEW_DESK_JAVA')));
    child.once('exit',code=>{if(settled)return;if(code!==0)return finish(new Error(`[SRC_JAVA_NOT_FOUND] Java Runtime 启动失败（exit ${code??'unknown'}）`));const match=/(?:java|openjdk) version "(?:1\.)?(\d+)(?:\.([0-9._+-]+))?/i.exec(output)||/version "(?:1\.)?(\d+)(?:\.([0-9._+-]+))?/i.exec(output);if(!match)return finish(new Error('[SRC_JAVA_NOT_FOUND] 无法识别 Java Runtime 版本'));const major=Number(match[1]);if(!Number.isFinite(major)||major<17)return finish(new Error(`[SRC_JAVA_NOT_FOUND] 需要 Java 17+，当前检测到 Java ${match[1]??'unknown'}`));finish(null,{command,major,version:(match[0]??'').replace(/^.*version\s*/i,'').replaceAll('"','')});});
  });
}

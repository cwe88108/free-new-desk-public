import {readdir,readFile,mkdir,writeFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const metrics=new Set(['surfaceTraceFlushRequested','surfaceReleaseQueuePending','surfaceReleaseIpcPending','surfacePipePending','surfaceClaimMs','surfaceAttachMs','surfaceHideMs','surfaceSyncMs','surfaceReleaseQueueMs','surfaceReleaseIpcMs','surfaceHostReadyWaitMs','surfacePipeConnectMs','surfacePipeRoundTripMs','surfaceCommandVisible','surfaceNativeCommandLockMs','surfaceNativeSurfaceLockMs','surfaceNativeApplyMs','surfaceNativeTotalMs']);
export async function collectSurfaceTiming({sourceDir,outputDir,prefix,flushed=false}){
  if(!/^scale-[0-9]+(?:-[0-9]+)?-(?:normal|high-contrast)$/.test(prefix))throw new Error('INVALID_EVIDENCE_PREFIX');
  const output=path.join(outputDir,`${prefix}-surface-timing.jsonl`),reportPath=path.join(outputDir,`${prefix}-surface-evidence.json`);
  // Invalidate only this collector's dedicated outputs before touching input.
  // A read/write failure must not leave a previous run labelled complete.
  await mkdir(outputDir,{recursive:true});
  try{await writeFile(reportPath,JSON.stringify({schemaVersion:1,status:'failed',error:'COLLECTION_INCOMPLETE',outputBytes:0,sha256:null})+'\n','utf8');}
  catch(error){await rm(reportPath,{force:true}).catch(()=>{});throw error;}
  await rm(output,{force:true});
  const files=[];
  async function visit(directory){
    for(const entry of await readdir(directory,{withFileTypes:true}).catch(error=>{if(error.code==='ENOENT')return[];throw error;})){
      const target=path.join(directory,entry.name);
      if(entry.isDirectory())await visit(target);
      else if(entry.isFile()&&entry.name==='surface-timing.jsonl')files.push(target);
    }
  }
  await visit(sourceDir);
  const lines=[],seen=new Set();let rejected=0;
  for(const file of files.sort()){
    for(const line of (await readFile(file,'utf8')).split(/\r?\n/)){
      if(!line.trim())continue;
      try{
        // JSON.parse preserves timestamp strings on every supported Node version.
        // Never emit unknown fields, raw rejected input, filenames or source paths.
        const sample=JSON.parse(line);
        if(typeof sample.time!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(sample.time)||!Number.isFinite(Date.parse(sample.time))||!metrics.has(sample.metric)||typeof sample.value!=='number'||!Number.isFinite(sample.value)||sample.value<0||sample.value>120000){rejected++;continue;}
        lines.push(JSON.stringify({time:sample.time,metric:sample.metric,value:sample.value}));seen.add(sample.metric);
      }catch{rejected++;}
    }
  }
  const bytes=Buffer.from(lines.length?lines.join('\n')+'\n':'','utf8');
  if(bytes.length)await writeFile(output,bytes);else await rm(output,{force:true});
  const requiredMetrics=['surfaceHideMs','surfaceReleaseQueueMs','surfaceReleaseIpcMs','surfaceHostReadyWaitMs','surfacePipeConnectMs','surfacePipeRoundTripMs','surfaceNativeCommandLockMs','surfaceNativeSurfaceLockMs','surfaceNativeApplyMs','surfaceNativeTotalMs'];
  const missingMetrics=requiredMetrics.filter(metric=>!seen.has(metric));
  const report={schemaVersion:1,sourceFiles:files.length,accepted:lines.length,rejected,flushAcknowledged:flushed,requiredMetrics,missingMetrics,status:flushed&&bytes.length>0&&missingMetrics.length===0&&rejected===0?'complete':'partial',outputBytes:bytes.length,sha256:bytes.length?createHash('sha256').update(bytes).digest('hex'):null};
  await writeFile(reportPath,JSON.stringify(report,null,2)+'\n','utf8');
  return{report,lines};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  const [sourceDir,outputDir,prefix,flushed]=process.argv.slice(2);
  try{
    const result=await collectSurfaceTiming({sourceDir,outputDir,prefix,flushed:flushed==='true'});
    console.log('Surface timing evidence report: '+JSON.stringify(result.report));
    for(const line of result.lines.slice(-30))console.log(line);
    if(result.report.status!=='complete')process.exitCode=1;
  }catch{console.error('SURFACE_EVIDENCE_COLLECTION_FAILED');process.exitCode=1;}
}

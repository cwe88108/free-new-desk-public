import {readFile,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import path from 'node:path';

const names=['surfaceAttachCommandMs','surfaceHideCommandMs','surfacePipeConnectMs','statsQueryMs','loadStatusQueryMs','tracksQueryMs'];
const percentile=values=>[...values].sort((a,b)=>a-b)[Math.ceil(values.length*.95)-1];
export function comparePlayerRuntime(baseline,candidate){
  if(baseline.length!==2||candidate.length!==2)throw Error('Two completed runs per version are required');
  const runs=[...baseline,...candidate],reference=runs[0];
  for(const run of runs){
    if(run.status!=='passed'||run.workload!=='native-player-local-paused-v2')throw Error('Incomplete or different benchmark workload');
    for(const key of ['electron','node','mpvSha256','mediaSha256','benchmarkSha256'])if(run[key]!==reference[key])throw Error('Benchmark environment mismatch: '+key);
    if(JSON.stringify(run.geometry)!==JSON.stringify(reference.geometry)||JSON.stringify(run.media)!==JSON.stringify(reference.media))throw Error('Media or surface geometry mismatch');
    for(const name of names)if(!Array.isArray(run.samples?.[name])||run.samples[name].length<100||!run.samples[name].every(value=>Number.isFinite(value)&&value>=0))throw Error('Insufficient valid samples: '+name);
  }
  for(const pair of [baseline,candidate])for(const key of ['appVersion','nativeSha256','compiledClientSha256'])if(pair[0][key]!==pair[1][key])throw Error('Version changed between its repeated runs: '+key);
  const metrics=Object.fromEntries(names.map(name=>{
    const before=baseline.flatMap(run=>run.samples[name]),after=candidate.flatMap(run=>run.samples[name]);
    const baselineP95=percentile(before),candidateP95=percentile(after),reductionPercent=baselineP95>0?(1-candidateP95/baselineP95)*100:null;
    const pairedReductionPercent=baseline.map((run,index)=>{const value=percentile(run.samples[name]);return value>0?Math.round((1-percentile(candidate[index].samples[name])/value)*10000)/100:null;});
    return[name,{baselineSamples:before.length,candidateSamples:after.length,baselineP95,candidateP95,
      baselineRunP95:baseline.map(run=>percentile(run.samples[name])),candidateRunP95:candidate.map(run=>percentile(run.samples[name])),
      pairedReductionPercent,allPairedRunsTarget50PercentMet:pairedReductionPercent.every(value=>value!==null&&value>=50),
      reductionPercent:reductionPercent===null?null:Math.round(reductionPercent*100)/100,target50PercentMet:reductionPercent!==null&&reductionPercent>=50}];
  }));
  return{schemaVersion:1,scope:reference.scope,workload:reference.workload,baselineVersion:baseline[0].appVersion,candidateVersion:candidate[0].appVersion,
    electron:reference.electron,node:reference.node,mpvSha256:reference.mpvSha256,mediaSha256:reference.mediaSha256,geometry:reference.geometry,media:reference.media,
    metrics,fullAppPerformanceVerified:false,warnings:['This measures native PlayerClient/PlayerHost only; Vue navigation, renderer frames and Electron IPC require separate evidence.','Pooled P95 improvement does not prove every repeated run improved; inspect the paired-run result too.','Raw-video fixture and paused state do not establish streaming/H264/4K or audible playback performance.']};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  const [a1,a2,b1,b2,output]=process.argv.slice(2);if(!output)throw Error('Usage: node compare-player-runtime.mjs <baseline1> <baseline2> <candidate1> <candidate2> <new-output>');
  const runs=await Promise.all([a1,a2,b1,b2].map(file=>readFile(file,'utf8').then(JSON.parse)));
  const comparison=comparePlayerRuntime(runs.slice(0,2),runs.slice(2));await writeFile(output,JSON.stringify(comparison,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify(comparison.metrics,null,2));
}

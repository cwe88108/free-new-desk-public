import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const METRICS=[
  'navigationMs','playbackNavigationMs',
  'playbackStatsIpcMs','playbackLoadStatusIpcMs','playbackTracksIpcMs',
  'playerHostStatsQueryMs','playerHostLoadStatusQueryMs','playerHostTracksQueryMs',
  'rendererFrameP95Ms','rendererFrameOver33MsRate',
  'surfaceHideMs','surfaceReleaseIpcMs'
];
const COUNTERS=[
  'playbackStatsIpcCalls','playbackLoadStatusIpcCalls','playbackTracksIpcCalls',
  'playerHostStatsQueryCalls','playerHostLoadStatusQueryCalls','playerHostTracksQueryCalls'
];
function metricValue(snapshot,name){
  const value=snapshot?.uiMetrics?.[name];
  if(!value||!Number.isFinite(value.count)||value.count<1||!Number.isFinite(value.p95))return null;
  return value;
}
function counterRate(snapshot,name){
  const count=snapshot?.counters?.[name],duration=Number(snapshot?.durationMs);
  if(!Number.isFinite(count)||count<0||!Number.isFinite(duration)||duration<=0)return null;
  return count/(duration/60000);
}
function compareMetric(baseline,candidate,name,blocked){
  if(blocked)return{status:'not-comparable',reason:'workload identifiers differ'};
  const before=metricValue(baseline,name),after=metricValue(candidate,name);
  if(!before||!after)return{status:'not-comparable',reason:'metric missing from one or both evidence files'};
  const reductionPercent=before.p95>0?Number(((before.p95-after.p95)/before.p95*100).toFixed(2)):null;
  return{
    status:'comparable',
    baseline:{count:before.count,p95:before.p95},
    candidate:{count:after.count,p95:after.p95},
    reductionPercent,
    target50PercentMet:reductionPercent!==null&&reductionPercent>=50
  };
}
export function comparePerformance(baseline,candidate){
  if(!baseline||!candidate||typeof baseline!=='object'||typeof candidate!=='object')throw new Error('PERFORMANCE_EVIDENCE_INVALID');
  const blocked=Boolean(baseline.workload&&candidate.workload&&baseline.workload!==candidate.workload);
  const metrics={};
  for(const name of METRICS)metrics[name]=compareMetric(baseline,candidate,name,blocked);
  const ipcRates={};
  for(const name of COUNTERS){
    const before=counterRate(baseline,name),after=counterRate(candidate,name);
    if(blocked||before===null||after===null||before<=0)ipcRates[name]={status:'not-comparable',reason:blocked?'workload identifiers differ':'counters or duration metadata missing'};
    else ipcRates[name]={status:'comparable',baselinePerMinute:before,candidatePerMinute:after,reductionPercent:Number(((before-after)/before*100).toFixed(2))};
  }
  const navigation=metrics.navigationMs;
  const frameJank=metrics.rendererFrameOver33MsRate;
  const ipcMetrics=['playbackStatsIpcMs','playbackLoadStatusIpcMs','playbackTracksIpcMs'].map(name=>metrics[name]);
  const allIpcComparable=ipcMetrics.every(item=>item.status==='comparable');
  return{
    schemaVersion:1,
    baseline:{appVersion:baseline.appVersion??'unknown',workload:baseline.workload??'unknown',durationMs:Number(baseline.durationMs)||null},
    candidate:{appVersion:candidate.appVersion??'unknown',workload:candidate.workload??'unknown',durationMs:Number(candidate.durationMs)||null},
    sameWorkload:blocked?false:(baseline.workload&&candidate.workload?true:null),
    metrics,
    ipcRates,
    targets:{
      navigationP95Reduced50Percent:navigation.status==='comparable'?navigation.target50PercentMet:null,
      allPlaybackQueryP95Reduced50Percent:allIpcComparable?ipcMetrics.every(item=>item.target50PercentMet):null,
      rendererFrameOver33MsRateHalved:frameJank.status==='comparable'?frameJank.target50PercentMet:null,
      overallResponseTimeReduced50Percent:navigation.status==='comparable'&&allIpcComparable
        ?navigation.target50PercentMet&&ipcMetrics.every(item=>item.target50PercentMet):null
    },
    warnings:[
      ...(!baseline.workload||!candidate.workload?['One evidence file lacks workload metadata; confirm the same packaged UI smoke scenario was used.']:[]),
      ...(!Number.isFinite(Number(baseline.durationMs))||!Number.isFinite(Number(candidate.durationMs))?['IPC rates cannot be normalized because one evidence file lacks durationMs.']:[]),
      ...(!baseline.counters||!candidate.counters?['IPC call-rate comparison requires telemetry counters in both evidence files.']:[]),
      'A 50% navigation/IPC reduction is not proof of a universal 2x fluency improvement; frame-jank evidence is reported separately.'
    ]
  };
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  const [baselinePath,candidatePath]=process.argv.slice(2);
  if(!baselinePath||!candidatePath){
    console.error('Usage: node scripts/compare-performance.mjs <baseline-performance.json> <candidate-performance.json>');
    process.exitCode=2;
  }else{
    try{
      const [baseline,candidate]=await Promise.all([
        readFile(baselinePath,'utf8').then(JSON.parse),
        readFile(candidatePath,'utf8').then(JSON.parse)
      ]);
      console.log(JSON.stringify(comparePerformance(baseline,candidate),null,2));
    }catch(error){
      console.error('PERFORMANCE_COMPARISON_FAILED: '+(error instanceof Error?error.message:'unknown error'));
      process.exitCode=1;
    }
  }
}

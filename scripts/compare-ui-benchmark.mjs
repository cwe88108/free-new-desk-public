import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const pages=['home','vod','live','music','player','search','favorites','history','sources','settings'];
const metrics=['navigationMs','pageShellInteractiveMs','pageReadinessProbeMs','playbackStatsIpcMs','playbackLoadStatusIpcMs','playbackTracksIpcMs','rendererFrameGapMs','sourceListReadyMs','sourceFirstPageReadyMs',...pages.map(page=>'pageShellInteractiveMs.'+page)];
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const canonical=value=>JSON.stringify(Object.fromEntries(Object.entries(value??{}).sort(([a],[b])=>a.localeCompare(b))));
function p95(values){const sorted=[...values].sort((a,b)=>a-b);return sorted[Math.ceil(sorted.length*.95)-1];}
function finiteSamples(result,name,minimum){
  const values=result.samples?.[name];
  if(!Array.isArray(values)||values.length<minimum||values.some(value=>!Number.isFinite(value)||value<0))throw Error('Incomplete or invalid samples: '+name);
  return values;
}
function validate(round){
  const{run,result}=round;
  if(!run?.completed||run.diagnostic||!result?.completed||result.workload!=='observed-ui-150-v8'||run.sourceCount!==712||!Number.isFinite(result.durationMs)||result.durationMs<=0)throw Error('Incomplete or mismatched UI workload');
  if(!hash(run.electronSha256)||!hash(run.prepareScriptSha256)||!hash(run.sourceInventorySha256))throw Error('Missing provenance');
  for(const name of ['ui-observer.ts','ui-preload.cts','ui-workload.ts'])if(!hash(run.templateHashes?.[name]))throw Error('Missing observation template digest');
  if(finiteSamples(result,'pageShellInteractiveMs',150).length!==150||finiteSamples(result,'navigationMs',149).length!==149)throw Error('Wrong navigation workload length');
  if(finiteSamples(result,'pageVisible',150).length!==150||result.samples.pageVisible.some(value=>value!==1))throw Error('Benchmark visibility was not verified');
  if(finiteSamples(result,'pageFocused',150).length!==150||result.samples.pageFocused.some(value=>value!==0&&value!==1))throw Error('Benchmark focus evidence was not verified');
  for(const name of metrics)finiteSamples(result,name,name==='playbackTracksIpcMs'?30:(name==='sourceListReadyMs'||name==='sourceFirstPageReadyMs')||name.startsWith('pageShellInteractiveMs.')?10:name==='rendererFrameGapMs'?100:100);
  const rows=finiteSamples(result,'sourceRowsRendered',10);
  if(rows.length!==10||rows.some(value=>!Number.isInteger(value)||value<1||value>712))throw Error('Invalid displayed source row count');
  const visited=finiteSamples(result,'sourceRowsVisited',10);
  if(visited.length!==10||visited.some(value=>value!==712))throw Error('Source fixture was not fully visited');
  const frames=finiteSamples(result,'rendererFrameGapMs',100);
  const actual=frames.filter(value=>value>33.3).length/frames.length;
  const declared=finiteSamples(result,'rendererFrameOver33MsRate',1);
  if(declared.length!==1||Math.abs(actual-declared[0])>1e-12)throw Error('Frame jank rate does not match raw samples');
  if(!result.errors||Object.values(result.errors).some(value=>!Number.isSafeInteger(value)||value<0))throw Error('Missing or invalid error counts');
}
function comparison(before,after){
  const a=p95(before),b=p95(after),reductionPercent=a>0?(a-b)/a*100:null;
  return{baseline:{samples:before.length,p95:a},candidate:{samples:after.length,p95:b},reductionPercent,observedReductionAtLeast50Percent:reductionPercent!==null&&reductionPercent>=50};
}
export function compareUiBenchmark(baseline,candidate){
  if(baseline.length!==2||candidate.length!==2)throw Error('Two complete rounds per version required');
  const all=[...baseline,...candidate];all.forEach(validate);
  const reference=baseline[0].run;
  for(const round of all){
    if(round.run.electronSha256!==reference.electronSha256||round.run.prepareScriptSha256!==reference.prepareScriptSha256||canonical(round.run.templateHashes)!==canonical(reference.templateHashes))throw Error('Runtime or observation code differs');
  }
  for(const group of [baseline,candidate])if(group[0].result.appVersion!==group[1].result.appVersion||group[0].run.sourceInventorySha256!==group[1].run.sourceInventorySha256)throw Error('Version changed within repeated rounds');
  if(baseline[0].result.appVersion===candidate[0].result.appVersion)throw Error('Baseline and candidate versions must differ');
  const report={schemaVersion:1,workload:'observed-ui-150-v8',baselineVersion:baseline[0].result.appVersion,candidateVersion:candidate[0].result.appVersion,metrics:{},frameJank:{},queryCounts:{},navigationOver100Ms:{baseline:baseline.map(round=>round.result.samples.navigationMs.filter(value=>value>100)),candidate:candidate.map(round=>round.result.samples.navigationMs.filter(value=>value>100))},errors:{baseline:baseline.map(round=>round.result.errors),candidate:candidate.map(round=>round.result.errors)},pageLocalControlAvailability:{baseline:baseline.map(round=>Object.fromEntries(pages.map(page=>[page,round.result.samples['pageLocalControlAvailable.'+page]??[]]))),candidate:candidate.map(round=>Object.fromEntries(pages.map(page=>[page,round.result.samples['pageLocalControlAvailable.'+page]??[]])))},firstInteractiveMs:{baseline:baseline.map(round=>round.result.samples.firstInteractiveMs??[]),candidate:candidate.map(round=>round.result.samples.firstInteractiveMs??[]),targetVerified:false,reason:'Only two launches per version; not sufficient to establish startup P95.'},warnings:['Observation copies include the same timing code and scripted workload; they are not shipping builds. The smoke-only 100ms assertion is recorded rather than thrown in these copies, so slow samples are retained; production gates are unchanged.','Page shell measurement requires visible target content and a focusable local control, or the active navigation control for pages without local actions; it does not prove all network content has loaded.','Source first-page readiness requires at least 50 rows (or all rows for smaller fixtures); full traversal visits all 712 distinct expected names via pages or the complete table. These are different metrics, not interchangeable.',
'Source scroll step includes a deliberate 100ms observation interval and is not reported as input latency.','IPC timings include both successful and rejected settlements; assess error counts separately.','Synthetic disabled sources and silent WAV do not prove real source playback, video quality or universal 2x fluency.']};
  for(const name of metrics){
    const pooled=comparison(baseline.flatMap(round=>round.result.samples[name]),candidate.flatMap(round=>round.result.samples[name]));
    const paired=baseline.map((round,index)=>comparison(round.result.samples[name],candidate[index].result.samples[name]));
    report.metrics[name]={...pooled,paired,bothPairsAtLeast50Percent:paired.every(pair=>pair.observedReductionAtLeast50Percent)};
  }
  const jank=rounds=>{const frames=rounds.flatMap(round=>round.result.samples.rendererFrameGapMs);return{samples:frames.length,over33Count:frames.filter(value=>value>33.3).length,over33Rate:frames.filter(value=>value>33.3).length/frames.length,maxMs:Math.max(...frames)};};
  report.frameJank={baseline:jank(baseline),candidate:jank(candidate)};
  for(const name of ['playbackStatsIpcMs','playbackLoadStatusIpcMs','playbackTracksIpcMs'])report.queryCounts[name]={baseline:baseline.map(round=>round.result.samples[name].length),candidate:candidate.map(round=>round.result.samples[name].length),note:'Counts per identical 150-operation workload, not per arbitrary wall-clock duration.'};
  report.focusEvidence={baseline:baseline.map(round=>round.result.samples.pageFocused.filter(value=>value===1).length),candidate:candidate.map(round=>round.result.samples.pageFocused.filter(value=>value===1).length)};
  report.foregroundConditionsVerified=[...report.focusEvidence.baseline,...report.focusEvidence.candidate].every(count=>count===150);
  if(!report.foregroundConditionsVerified)report.warnings.push('Foreground focus was not maintained throughout every round. Timing differences are descriptive only and cannot establish a performance acceptance target.');
  report.allResponseMetricsObserved50Percent=report.foregroundConditionsVerified&&['navigationMs','pageShellInteractiveMs','playbackStatsIpcMs','playbackLoadStatusIpcMs','playbackTracksIpcMs'].every(name=>report.metrics[name].bothPairsAtLeast50Percent);
  report.universalTwoTimesFluencyVerified=false;
  return report;
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
  const[a1,a2,c1,c2,output]=process.argv.slice(2);if(!output)throw Error('Usage: node scripts/compare-ui-benchmark.mjs <baseline1 run dir> <baseline2> <candidate1> <candidate2> <new output>');
  const read=async file=>JSON.parse((await readFile(file,'utf8')).replace(/^\uFEFF/,''));
  const rounds=await Promise.all([a1,a2,c1,c2].map(async directory=>({run:await read(path.join(directory,'run.json')),result:await read(path.join(directory,'result.json'))})));
  const report=compareUiBenchmark(rounds.slice(0,2),rounds.slice(2));
  await writeFile(output,JSON.stringify(report,null,2),{flag:'wx'});console.log(JSON.stringify({output,allResponseMetricsObserved50Percent:report.allResponseMetricsObserved50Percent}));
}

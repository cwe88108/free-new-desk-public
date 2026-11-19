import test from 'node:test';
import assert from 'node:assert/strict';
import {compareUiBenchmark} from '../../scripts/compare-ui-benchmark.mjs';
const repeated=(n,value)=>Array(n).fill(value);
function round(version,value=10){
  const samples={navigationMs:repeated(149,value),pageShellInteractiveMs:repeated(150,value),playbackStatsIpcMs:repeated(100,value),playbackLoadStatusIpcMs:repeated(100,value),playbackTracksIpcMs:repeated(30,value),rendererFrameGapMs:[...repeated(199,16.7),40],rendererFrameOver33MsRate:[1/200],sourceListReadyMs:repeated(10,value),sourceRowsRendered:repeated(10,712),sourceRowsVisited:repeated(10,712),sourceFirstPageReadyMs:repeated(10,value),firstInteractiveMs:[100]};
  for(const page of ['home','vod','live','music','player','search','favorites','history','sources','settings'])samples['pageShellInteractiveMs.'+page]=repeated(10,value);
  samples.pageReadinessProbeMs=repeated(150,.2);
  samples.pageVisible=repeated(150,1);
  samples.pageFocused=repeated(150,1);
  return{run:{completed:true,sourceCount:712,electronSha256:'a'.repeat(64),prepareScriptSha256:'b'.repeat(64),sourceInventorySha256:(version==='1.5.2'?'c':'d').repeat(64),templateHashes:{'ui-observer.ts':'1'.repeat(64),'ui-preload.cts':'2'.repeat(64),'ui-workload.ts':'3'.repeat(64)}},result:{appVersion:version,completed:true,workload:'observed-ui-150-v8',durationMs:1000,samples,errors:{}}};
}
test('UI comparison reports measured paired reductions without claiming universal fluency or startup P95',()=>{
  const result=compareUiBenchmark([round('1.5.2'),round('1.5.2')],[round('1.5.9',4),round('1.5.9',4)]);
  assert.equal(result.allResponseMetricsObserved50Percent,true);assert.equal(result.universalTwoTimesFluencyVerified,false);assert.equal(result.firstInteractiveMs.targetVerified,false);assert.equal(result.frameJank.baseline.over33Count,2);
});
test('UI comparison refuses changed runtime, observation method, incomplete source rows or rounded-away jank',()=>{
  for(const change of [r=>r.run.electronSha256='f'.repeat(64),r=>r.run.templateHashes['ui-workload.ts']='e'.repeat(64),r=>r.run.diagnostic=true,r=>r.result.samples.sourceRowsVisited[0]=711,r=>r.result.samples.rendererFrameOver33MsRate=[0],r=>r.result.completed=false,r=>r.result.samples.pageShellInteractiveMs.pop()]){
    const changed=round('1.5.9');change(changed);assert.throws(()=>compareUiBenchmark([round('1.5.2'),round('1.5.2')],[changed,round('1.5.9')]));
  }
});
test('UI comparison cannot conceal an unachieved paired response target behind pooled samples',()=>{
  const result=compareUiBenchmark([round('1.5.2',10),round('1.5.2',2)],[round('1.5.9',3),round('1.5.9',3)]);
  assert.equal(result.metrics.navigationMs.observedReductionAtLeast50Percent,true);assert.equal(result.metrics.navigationMs.bothPairsAtLeast50Percent,false);assert.equal(result.allResponseMetricsObserved50Percent,false);
});
test('unfocused rounds retain descriptive results but cannot pass performance acceptance',()=>{
  const candidate=round('1.5.10',3);candidate.result.samples.pageFocused[5]=0;
  const result=compareUiBenchmark([round('1.5.2'),round('1.5.2')],[candidate,round('1.5.10',3)]);
  assert.equal(result.metrics.navigationMs.bothPairsAtLeast50Percent,true);
  assert.equal(result.foregroundConditionsVerified,false);
  assert.equal(result.allResponseMetricsObserved50Percent,false);
  assert.deepEqual(result.focusEvidence.candidate,[149,150]);
});

test('paginated presentation is accepted only with complete traversal; older workloads cannot be mixed',()=>{
  const paged=round('1.5.14',4);paged.result.samples.sourceRowsRendered=repeated(10,12);
  assert.equal(compareUiBenchmark([round('1.5.2'),round('1.5.2')],[paged,structuredClone(paged)]).foregroundConditionsVerified,true);
  for(const change of [r=>r.result.samples.sourceRowsVisited.pop(),r=>r.result.samples.sourceRowsRendered[0]=0,r=>r.result.samples.sourceFirstPageReadyMs=[],r=>r.result.workload='observed-ui-150-v6']){
    const invalid=structuredClone(paged);change(invalid);
    assert.throws(()=>compareUiBenchmark([round('1.5.2'),round('1.5.2')],[paged,invalid]));
  }
});

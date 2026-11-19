import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {comparePerformance} from '../../scripts/compare-performance.mjs';

const read=path=>readFile(new URL('../../'+path,import.meta.url),'utf8');
function evidence({version='1.5.6',duration=60000,workload='packaged-ui-smoke-v1',nav=100,frameJank=.2,statsRate=600,ipcScale=1}={}){
  return{
    schemaVersion:1,appVersion:version,workload,durationMs:duration,
    counters:{
      playbackStatsIpcCalls:statsRate,
      playbackLoadStatusIpcCalls:statsRate,
      playbackTracksIpcCalls:60,
      playerHostStatsQueryCalls:Math.round(statsRate*.9),
      playerHostLoadStatusQueryCalls:Math.round(statsRate*.9),
      playerHostTracksQueryCalls:60
    },
    uiMetrics:{
      navigationMs:{count:12,p95:nav},
      playbackNavigationMs:{count:3,p95:nav},
      playbackStatsIpcMs:{count:30,p95:40*ipcScale},
      playbackLoadStatusIpcMs:{count:30,p95:35*ipcScale},
      playbackTracksIpcMs:{count:10,p95:25*ipcScale},
      playerHostStatsQueryMs:{count:30,p95:30*ipcScale},
      playerHostLoadStatusQueryMs:{count:30,p95:28*ipcScale},
      playerHostTracksQueryMs:{count:10,p95:20*ipcScale},
      rendererFrameP95Ms:{count:1,p95:16.8},
      rendererFrameOver33MsRate:{count:1,p95:frameJank},
      surfaceHideMs:{count:12,p95:80},
      surfaceReleaseIpcMs:{count:12,p95:45}
    }
  };
}

test('comparison calculates P95 reduction, normalized IPC rates, and frame-jank proxy separately',()=>{
  const report=comparePerformance(
    evidence({version:'1.5.2',nav:100,frameJank:.2,statsRate:600,ipcScale:1}),
    evidence({version:'1.5.6',nav:45,frameJank:.08,statsRate:240,ipcScale:.4})
  );
  assert.equal(report.sameWorkload,true);
  assert.equal(report.metrics.navigationMs.reductionPercent,55);
  assert.equal(report.targets.navigationP95Reduced50Percent,true);
  assert.equal(report.targets.rendererFrameOver33MsRateHalved,true);
  assert.equal(report.ipcRates.playbackStatsIpcCalls.reductionPercent,60);
  assert.equal(report.targets.allPlaybackQueryP95Reduced50Percent,true);
  assert.equal(report.targets.overallResponseTimeReduced50Percent,true);
});

test('legacy V1.5.2 evidence compares shared metrics but does not invent IPC counters',()=>{
  const baseline={appVersion:'1.5.2',uiMetrics:{navigationMs:{count:10,p95:120},surfaceHideMs:{count:10,p95:180}}};
  const candidate=evidence({nav:55});
  const report=comparePerformance(baseline,candidate);
  assert.equal(report.metrics.navigationMs.status,'comparable');
  assert.equal(report.targets.navigationP95Reduced50Percent,true);
  assert.equal(report.ipcRates.playbackStatsIpcCalls.status,'not-comparable');
  assert.equal(report.targets.allPlaybackQueryP95Reduced50Percent,null);
  assert.ok(report.warnings.some(value=>value.includes('durationMs')));
});

test('different workload identifiers block misleading comparisons',()=>{
  const report=comparePerformance(evidence({workload:'smoke-a'}),evidence({workload:'smoke-b'}));
  assert.equal(report.sameWorkload,false);
  assert.equal(report.metrics.navigationMs.status,'not-comparable');
  assert.equal(report.targets.overallResponseTimeReduced50Percent,null);
});

test('main process counts renderer IPC requests separately from actual PlayerHost queries',async()=>{
  const [main,client]=await Promise.all([
    read('apps/desktop/src/main/index.ts'),
    read('apps/desktop/src/main/player-client.ts')
  ]);
  for(const name of ['playbackStatsIpcCalls','playbackLoadStatusIpcCalls','playbackTracksIpcCalls'])assert.ok(main.includes(name),name);
  for(const name of ['playerHostStatsQueryCalls','playerHostLoadStatusQueryCalls','playerHostTracksQueryCalls'])assert.ok(main.includes(name),name);
  assert.ok(main.includes("incrementPerformanceCounter(prefix+'IpcCalls')"));
  assert.ok(main.includes("recordPerformanceMetric(prefix+'IpcMs'"));
  assert.ok(client.includes("this.recordCounter(metric+'Calls')"));
  assert.ok(client.includes("this.recordMetric(metric+'Ms'"));
});

test('UI smoke aggregates requestAnimationFrame gaps without IPC per frame',async()=>{
  const renderer=await read('apps/desktop/src/renderer/main.ts');
  assert.ok(renderer.includes('requestAnimationFrame(sampleSmokeFrame)'));
  assert.ok(renderer.includes('rendererFrameP95Ms'));
  assert.ok(renderer.includes('rendererFrameOver33MsRate'));
  assert.ok(renderer.includes('await stopSmokeFrameSampling()'));
  assert.ok(renderer.includes('for(const[metric,value]of metrics)await window.desktop.diagnostics.recordPerformance'));
  assert.ok(!renderer.includes("recordPerformance('rendererFrameGapMs'"));
});

test('performance snapshot is numeric-only and written before flush acknowledgement',async()=>{
  const main=await read('apps/desktop/src/main/index.ts');
  const start=main.indexOf('function performanceRuntimeSnapshot');
  const end=main.indexOf('\n}',start);
  assert.ok(start>=0&&end>start);
  const snapshot=main.slice(start,end);
  for(const token of ['schemaVersion:1','appVersion:app.getVersion()','durationMs:','counters:performanceCounterSnapshot()','uiMetrics:performanceSummary()'])assert.ok(snapshot.includes(token),token);
  const flush=main.slice(main.indexOf("ipcMain.handle('diagnostics:recordPerformance'"));
  assert.ok(flush.indexOf("'performance-runtime.json'")<flush.indexOf("'surface-timing-flushed.json'"));
});

test('PowerShell smoke copies performance evidence and Windows uploads do not fail a validated build on quota errors',async()=>{
  const [smoke,workflow]=await Promise.all([
    read('scripts/test-packaged-ui.ps1'),
    read('.github/workflows/build-windows.yml')
  ]);
  assert.ok(smoke.includes('performance-runtime.json'));
  assert.ok(smoke.includes('rendererFrameP95Ms'));
  assert.ok(smoke.includes('performanceOutput'));
  assert.ok(workflow.includes('Validate packaged UI performance evidence'));
  assert.ok(workflow.includes('continue-on-error: true'));
  assert.ok(workflow.includes('Report Windows artifact delivery status'));
  assert.ok(workflow.includes('dist/ui-smoke/*-performance.json'));
});

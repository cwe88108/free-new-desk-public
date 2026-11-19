import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const read=p=>readFile(new URL('../../'+p,import.meta.url),'utf8');
test('surface evidence is asynchronous, numeric only, retained after failures at every DPI',async()=>{
  const [main,script,workflow,client]=await Promise.all(['apps/desktop/src/main/index.ts','scripts/test-packaged-ui.ps1','.github/workflows/build-windows.yml','apps/desktop/src/main/player-client.ts'].map(read));
  assert.match(main,/surfaceTraceWrites=surfaceTraceWrites\.then\(\(\)=>appendFile\(file,line,'utf8'\)\)\.catch\(\(\)=>\{surfaceTraceWriteFailed=true;\}\)/);
  assert.match(main,/JSON\.stringify\(\{time:new Date\(\)\.toISOString\(\),metric,value:/);
  const retention=script.slice(script.indexOf('} finally {'));
  assert.match(retention,/collect-surface-timing\.mjs/);
  assert.match(retention,/if \(\$collectorExitCode -ne 0\)/);
  assert.match(retention,/performance-runtime\.json/);assert.match(retention,/Copy-Item -LiteralPath \$performanceFiles\[0\]\.FullName/);assert.doesNotMatch(retention,/app\.log'|\.sqlite/);
  assert.match(main,/await surfaceTraceWrites;if\(surfaceTraceWriteFailed\)return false;await writeFile/);
  assert.match(retention,/Surface timing flush acknowledged/);
  const upload=workflow.match(/- name: Upload all DPI surface timing evidence\r?\n([\s\S]*?)(?=\r?\n      - |$)/)?.[1];
  assert.ok(upload,'surface evidence upload step exists');
  assert.match(upload,/^        continue-on-error: true\s*$/m);
  assert.match(upload,/^        if: always\(\)\s*$/m);
  assert.match(workflow,/dist\/ui-smoke\/\*-surface-evidence\.json/);
  for(const field of ['commandLockMs','surfaceLockMs','applyMs','totalMs'])assert.ok(client.includes(field));
  assert.match(client,/Number\.isFinite\(value\)&&value>=0/);
});

test('smoke flush waits for asynchronous writes and never acknowledges a failed write',async()=>{
  const [{default:ts},{default:vm}]=await Promise.all([import('typescript'),import('node:vm')]);
  const main=await read('apps/desktop/src/main/index.ts');
  const metrics=main.slice(main.indexOf('let surfaceTraceWrites:'),main.indexOf('\nconst player=',main.indexOf('let surfaceTraceWrites:')));
  const handler=main.match(/ipcMain\.handle\('diagnostics:recordPerformance',trusted\(async input=>\{[^\n]+/)[0];
  for(const failed of [false,true]){
    let finishWrite;const blocked=new Promise(resolve=>{finishWrite=resolve;});
    const files=[],ctx={Promise,Date,Number,Math,JSON,Map,process:{env:{FND_UI_SMOKE:'1'}},performanceMetricNames:new Set(['surfaceHideMs','surfaceTraceFlushRequested']),performanceSamples:new Map(),logger:{filePath:'/logs/app.log'},path:{dirname:()=>'/logs',join:(...parts)=>parts.join('/')},appendFile:async()=>{await blocked;if(failed)throw new Error('disk full');},writeFile:async(file)=>files.push(file),trusted:fn=>fn,performanceRuntimeSnapshot:()=>({schemaVersion:1,workload:'packaged-ui-smoke-v1'}),ipcMain:{handle:(_name,fn)=>{ctx.flush=fn;}}};
    vm.runInNewContext(ts.transpileModule(metrics+'\n'+handler+'\nglobalThis.record=recordPerformanceMetric;',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,ctx);
    ctx.record('surfaceHideMs',213.3);
    let settled=false;const flush=ctx.flush({metric:'surfaceTraceFlush',value:0}).then(value=>{settled=true;return value;});
    await Promise.resolve();assert.equal(settled,false);assert.equal(files.length,0);
    finishWrite();assert.equal(await flush,!failed);
    assert.equal(files.length,failed?0:2);
    if(!failed){assert.match(files[0],/performance-runtime\.json$/);assert.match(files[1],/surface-timing-flushed\.json$/);}
  }
});

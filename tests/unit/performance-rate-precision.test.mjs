import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';

test('performance collection preserves rare frame jank ratios and rejects invalid rates',async()=>{
  const source=await readFile(new URL('../../apps/desktop/src/main/index.ts',import.meta.url),'utf8');
  const start=source.indexOf('function recordPerformanceMetric(');
  const end=source.indexOf('\nconst player=',start);
  assert.ok(start>=0&&end>start);
  const performanceSamples=new Map();
  const context=vm.createContext({performanceSamples,performanceMetricNames:new Set(['rendererFrameOver33MsRate','navigationMs']),process:{env:{}}});
  vm.runInContext(ts.transpileModule(source.slice(start,end),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context);
  const record=context.recordPerformanceMetric;
  record('rendererFrameOver33MsRate',1/1796);
  record('rendererFrameOver33MsRate',0);
  record('rendererFrameOver33MsRate',1);
  assert.deepEqual(Array.from(performanceSamples.get('rendererFrameOver33MsRate')),[1/1796,0,1]);
  for(const value of [1.01,-1,NaN,Infinity])record('rendererFrameOver33MsRate',value);
  assert.equal(performanceSamples.get('rendererFrameOver33MsRate').length,3);
  record('navigationMs',4.444);
  assert.equal(performanceSamples.get('navigationMs')[0],4.4);
  for(let i=0;i<220;i++)record('rendererFrameOver33MsRate',1/1796);
  assert.equal(performanceSamples.get('rendererFrameOver33MsRate').length,200);
  assert.equal(performanceSamples.get('rendererFrameOver33MsRate').at(-1),1/1796);
});

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const matrixUrl=new URL('../functional/v138-baseline-matrix.json',import.meta.url);

test('v1.3.8 functional baseline contains all 356 unique cases',async()=>{
  const matrix=JSON.parse(await readFile(matrixUrl,'utf8'));
  assert.equal(matrix.total,356);
  assert.equal(matrix.baseline.pass,220);
  assert.equal(matrix.baseline.fail,136);
  assert.equal(matrix.cases.length,356);
  const ids=matrix.cases.map(item=>item.id);
  assert.equal(new Set(ids).size,356,'functional case IDs must be unique');
  assert.equal(matrix.cases.filter(item=>item.baseline==='pass').length,220);
  assert.equal(matrix.cases.filter(item=>item.baseline==='fail').length,136);
  for(const item of matrix.cases){
    assert.match(item.id,/^FT-[A-Z0-9]+-\d+$/);
    assert.ok(item.title?.trim());
    assert.ok(item.baseline==='pass'||item.baseline==='fail');
  }
});


test('v1.3.9 acceptance maps every baseline failure to executable evidence',async()=>{
  const baseline=JSON.parse(await readFile(matrixUrl,'utf8'));
  const acceptance=JSON.parse(await readFile(new URL('../functional/v139-acceptance-evidence.json',import.meta.url),'utf8'));
  const failedIds=baseline.cases.filter(item=>item.baseline==='fail').map(item=>item.id).sort();
  const acceptedIds=acceptance.cases.map(item=>item.id).sort();
  assert.deepEqual(acceptedIds,failedIds,'acceptance evidence must cover exactly the 136 baseline failures');
  assert.equal(acceptance.summary.baselineFailed,136);
  assert.equal(acceptance.summary.remediated,136);
  assert.equal(acceptance.summary.remaining,0);
  const suiteNames=new Set(Object.keys(acceptance.suites));
  for(const item of acceptance.cases){
    assert.equal(item.status,'pass');
    assert.ok(Array.isArray(item.evidence)&&item.evidence.length>0,`missing evidence for ${item.id}`);
    for(const suite of item.evidence)assert.ok(suiteNames.has(suite),`unknown evidence suite ${suite} for ${item.id}`);
  }
  for(const suite of Object.values(acceptance.suites)){
    assert.ok(suite.path?.trim());
    await readFile(new URL('../../'+suite.path,import.meta.url),'utf8');
  }
});

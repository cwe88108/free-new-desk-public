import test from 'node:test';
import assert from 'node:assert/strict';
import {pythonFailureDetail} from '../../services/source-engine/dist/python-spider-adapter.js';
test('Python diagnostic identifies common failure classes without accepting arbitrary source text',()=>{
  assert.match(pythonFailureDetail('URLError'),/网络请求失败/);
  assert.match(pythonFailureDetail('TimeoutError'),/请求超时/);
  assert.match(pythonFailureDetail('ModuleNotFoundError'),/缺少Python模块/);
  assert.match(pythonFailureDetail('AssertionError'),/断言失败/);
  for(const value of ['https://private.example/?token=secret','SecretException','constructor','__proto__',null,{},42,['URLError']])assert.equal(pythonFailureDetail(value),'');
});

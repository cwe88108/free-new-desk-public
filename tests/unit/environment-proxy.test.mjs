import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';

test('environment proxy requires explicit opt-in and uses the native API without rewriting bypass rules',async()=>{
  const source=await readFile(new URL('../../packages/source-sdk/src/environment-proxy.ts',import.meta.url),'utf8');
  const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
  for(const flag of [undefined,'0','1']){
    let calls=0;const env={NODE_USE_ENV_PROXY:flag,NO_PROXY:'localhost,127.0.0.1',HTTPS_PROXY:'http://proxy.example:7890'};
    const before={...env};
    vm.runInNewContext(code,{exports:{},process:{env},require:name=>{assert.equal(name,'node:http');return{setGlobalProxyFromEnv:()=>calls++};}});
    assert.equal(calls,flag==='1'?1:0);assert.deepEqual(env,before);
  }
  assert.doesNotThrow(()=>vm.runInNewContext(code,{exports:{},process:{env:{NODE_USE_ENV_PROXY:'1'}},require:()=>({})}));
});

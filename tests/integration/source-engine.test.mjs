import test from 'node:test';
import assert from 'node:assert/strict';
import { SourceEngine } from '../../services/source-engine/dist/index.js';

test('SourceEngine replacement is deterministic and ignores disabled sources',async()=>{
  const engine=new SourceEngine();
  await engine.replaceSources([
    {id:'b',name:'Beta',kind:'T1_JSON',endpoint:'https://beta.example/api',enabled:true,trust:'A'},
    {id:'a',name:'Alpha',kind:'T0_XML',endpoint:'https://alpha.example/api',enabled:true,trust:'A'},
    {id:'off',name:'Disabled',kind:'T1_JSON',endpoint:'https://off.example/api',enabled:false,trust:'A'}
  ]);
  assert.deepEqual(engine.listSources().map(source=>source.id),['a','b']);
  await engine.replaceSources([
    {id:'c',name:'Charlie',kind:'T1_JSON',endpoint:'https://charlie.example/api',enabled:true,trust:'A'}
  ]);
  assert.deepEqual(engine.listSources().map(source=>source.id),['c']);
  await engine.destroy();
  assert.deepEqual(engine.listSources(),[]);
});

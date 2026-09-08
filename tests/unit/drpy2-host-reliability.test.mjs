import test from 'node:test';
import assert from 'node:assert/strict';
import {assertSafeDrpyNetworkUrl,assertSafeDrpyUrl,parseDrpyImportSpecifiers} from '../../services/source-engine/dist/drpy-engine-manager.js';
import {resolveDrpy2Profile} from '../../services/source-engine/dist/drpy2-profile.js';

test('drpy module graph lexer ignores comments and strings and accepts literal reexports/dynamic imports',async()=>{
  const code=`// import './fake.js'\nconst fake="export * from './also-fake.js'";export {x} from './real.js';const y=import('./dynamic.js');`;
  assert.deepEqual(await parseDrpyImportSpecifiers(code),['./real.js','./dynamic.js']);
  await assert.rejects(()=>parseDrpyImportSpecifiers(`const name='x.js';import('./'+name)`),/non-literal dynamic import/);
});

test('drpy network guard blocks literal and DNS-local targets including IPv6',async()=>{
  for(const url of ['http://0.1.2.3/a','http://[::1]/a','http://[fc00::1]/a','http://[fe80::1]/a'])assert.throws(()=>assertSafeDrpyUrl(url),/DRPY_REQ_BLOCKED/);
  await assert.rejects(()=>assertSafeDrpyNetworkUrl('http://localhost/a'),/DRPY_REQ_BLOCKED/);
});

test('qist engine profile requires the pinned engine and core hashes',()=>{
  const manifest={engineUrl:'https://raw.githubusercontent.com/qist/tvbox/master/lib/drpy2.min.js',family:'drpy2-esm',version:'3.9.52beta3',sha256:'67f4f6b460db1ec7ef50585953ce826c5263ca91d72958490ef4702b4e154fe1',dependencies:[{url:'https://raw.githubusercontent.com/qist/tvbox/master/lib/drpy-core-lite.min.js',sha256:'18bab373dfa67a4956f25f273fafb3e5b6b9fdf7bafb21acf0f6264b474900f5'}],fetchedAt:0,lastKnownGood:false,validation:'downloaded'};
  const profile=resolveDrpy2Profile(manifest);assert.equal(profile.id,'qist-drpy2-3.9.52beta3-20250801');assert.equal(profile.hostAbiVersion,'fnd-drpy2-host/2');
  assert.throws(()=>resolveDrpy2Profile({...manifest,sha256:'0'.repeat(64)}),/PROFILE_UNVERIFIED/);
});

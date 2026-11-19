import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

test('actual runtime staging includes root and desktop production dependencies and versions',async t=>{
  const base=path.resolve(os.tmpdir()),root=await mkdtemp(path.join(base,'fnd-runtime-stage-'));
  t.after(async()=>{assert.ok(path.resolve(root).startsWith(base+path.sep));await rm(root,{recursive:true,force:true});});
  const write=async(relative,bytes)=>{const target=path.join(root,relative);await mkdir(path.dirname(target),{recursive:true});await writeFile(target,bytes);};
  await mkdir(path.join(root,'services'));await mkdir(path.join(root,'.packaging'));
  await write('.packaging/stale.txt','old generated staging');
  await write('scripts/prepare-runtime-workspaces.mjs',await readFile(new URL('../../scripts/prepare-runtime-workspaces.mjs',import.meta.url)));
  await write('scripts/release-manifest.mjs','export async function sourceProvenance(){return {fixture:true};}');
  await write('package.json',JSON.stringify({type:'module',name:'root-app',dependencies:{'root-only':'1.0.0'}}));
  await write('apps/desktop/package.json',JSON.stringify({name:'desktop-app',dependencies:{'music-metadata':'11.16.1'}}));
  await write('apps/desktop/dist/main/index.js',"import '@free-new-desk/contracts'; import 'music-metadata';");
  await write('packages/contracts/package.json',JSON.stringify({type:'module',name:'@free-new-desk/contracts',version:'0.1.0'}));
  await write('packages/contracts/dist/index.js','export const fixture=true;');
  for(const [name,version]of [['root-only','1.0.0'],['music-metadata','11.16.1']]){
    await write('node_modules/'+name+'/package.json',JSON.stringify({name,version,type:'module'}));
    await write('node_modules/'+name+'/index.js','export const version='+JSON.stringify(version)+';');
  }
  assert.ok(path.resolve(root,'.packaging').startsWith(path.resolve(root)+path.sep));
  await promisify(execFile)(process.execPath,[path.join(root,'scripts/prepare-runtime-workspaces.mjs')],{cwd:root,timeout:15_000,windowsHide:true});
  const manifest=JSON.parse(await readFile(path.join(root,'.packaging/runtime-workspaces.json'),'utf8'));
  assert.deepEqual(manifest.externalPackages.map(item=>[item.name,item.version,item.requestedBy]),[['music-metadata','11.16.1','desktop-app'],['root-only','1.0.0','root-app']]);
  const metadata=JSON.parse(await readFile(path.join(root,'.packaging/runtime-node-modules/music-metadata/package.json'),'utf8'));
  assert.equal(metadata.version,'11.16.1');
});

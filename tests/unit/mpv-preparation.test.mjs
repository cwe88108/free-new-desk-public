import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {prepareMpvRuntime} from '../../scripts/ensure-mpv-runtime.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex');
async function fixture(t){
  const root=await mkdtemp(path.join(os.tmpdir(),'fnd-mpv-check-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const runtime=path.join(root,'third_party','mpv','win-x64');
  await mkdir(runtime,{recursive:true});
  return{root,runtime,metadata:async(archive,dll)=>writeFile(path.join(runtime,'SOURCE.txt'),`source: https://example.com/pinned.7z\narchive sha256: ${sha(archive)}\ndll sha256: ${sha(dll)}\n`)};
}
test('mpv preparation reuses a verified DLL and rejects tampering or missing metadata',async t=>{
  const{root,runtime,metadata}=await fixture(t),dll=Buffer.from('controlled-dll');
  await metadata('archive',dll);await writeFile(path.join(runtime,'libmpv-2.dll'),dll);
  const originalFetch=globalThis.fetch;
  globalThis.fetch=()=>{throw new Error('verified DLL must not be downloaded');};
  t.after(()=>{globalThis.fetch=originalFetch;});
  await prepareMpvRuntime(root);
  await writeFile(path.join(runtime,'libmpv-2.dll'),'tampered');
  await assert.rejects(()=>prepareMpvRuntime(root),/Existing.*mismatch/);
  await writeFile(path.join(runtime,'SOURCE.txt'),'source: https://example.com/x\narchive sha256: '+'0'.repeat(64));
  await assert.rejects(()=>prepareMpvRuntime(root),/dll sha256/);
});
test('Windows mpv preparation validates downloaded archive and extracted DLL before installing',{skip:process.platform!=='win32'},async t=>{
  const{root,runtime,metadata}=await fixture(t),dll=Buffer.from('controlled-dll');
  const input=path.join(root,'input');await mkdir(input);await writeFile(path.join(input,'libmpv-2.dll'),dll);
  const archivePath=path.join(root,'sample.7z');
  const tar=path.join(process.env.SystemRoot||'C:\\Windows','System32','tar.exe');
  execFileSync(tar,['--format=7zip','-cf',archivePath,'-C',input,'libmpv-2.dll'],{windowsHide:true});
  const archive=await readFile(archivePath);await metadata(archive,dll);
  const originalFetch=globalThis.fetch;globalThis.fetch=async()=>new Response(archive);
  t.after(()=>{globalThis.fetch=originalFetch;});
  await prepareMpvRuntime(root);assert.deepEqual(await readFile(path.join(runtime,'libmpv-2.dll')),dll);
  await rm(path.join(runtime,'libmpv-2.dll'));
  await metadata(archive,'wrong-dll');
  await assert.rejects(()=>prepareMpvRuntime(root),/Extracted.*mismatch/);
  await assert.rejects(()=>readFile(path.join(runtime,'libmpv-2.dll')),/ENOENT/);
  await metadata('wrong-archive',dll);
  await assert.rejects(()=>prepareMpvRuntime(root),/archive SHA256 mismatch/);
});
test('vendored archive is required, hash checked, and never replaced by a download',async t=>{
  const {root,runtime,metadata}=await fixture(t);
  await metadata('controlled-archive','dll');
  const source=path.join(runtime,'SOURCE.txt');
  await writeFile(source,(await readFile(source,'utf8'))+'vendored archive: pinned.7z\n');
  const originalFetch=globalThis.fetch;
  globalThis.fetch=()=>{throw new Error('vendored runtime must not access network');};
  t.after(()=>{globalThis.fetch=originalFetch;});
  await assert.rejects(()=>prepareMpvRuntime(root),/ENOENT/);
  const vendor=path.join(root,'third_party','mpv','vendor');await mkdir(vendor);
  await writeFile(path.join(vendor,'pinned.7z'),'tampered');
  await assert.rejects(()=>prepareMpvRuntime(root),/archive SHA256 mismatch/);
  await writeFile(source,(await readFile(source,'utf8')).replace('vendored archive: pinned.7z','vendored archive: ../pinned.7z'));
  await assert.rejects(()=>prepareMpvRuntime(root),/Invalid vendored archive/);
});
test('Windows clean checkout prepares the real vendored DLL without network or cache',{skip:process.platform!=='win32'},async t=>{
  const {root,runtime}=await fixture(t);
  const sourceRoot=path.resolve(import.meta.dirname,'../..');
  const source=await readFile(path.join(sourceRoot,'third_party/mpv/win-x64/SOURCE.txt'),'utf8');
  await writeFile(path.join(runtime,'SOURCE.txt'),source);
  const name=source.match(/^vendored archive:\s*(.+)$/m)[1].trim();
  const vendor=path.join(root,'third_party/mpv/vendor');await mkdir(vendor);
  await writeFile(path.join(vendor,name),await readFile(path.join(sourceRoot,'third_party/mpv/vendor',name)));
  const originalFetch=globalThis.fetch;
  globalThis.fetch=()=>{throw new Error('cold-cache test must be offline');};
  t.after(()=>{globalThis.fetch=originalFetch;});
  await prepareMpvRuntime(root);
  assert.equal(sha(await readFile(path.join(runtime,'libmpv-2.dll'))),source.match(/^dll sha256:\s*(.+)$/m)[1].trim());
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const repoRoot=fileURLToPath(new URL('../..',import.meta.url));
import {normalizeSmbPath,smbShareRoot,smbServerIdentitiesMatch,SmbError} from '../../apps/desktop/dist/main/smb-session-manager.js';

test('v1.4.14 SMB accepts UNC single-leading and smb URL forms',()=>{
  assert.equal(normalizeSmbPath(String.raw`\\NAS\Music\HiRes`),String.raw`\\NAS\Music\HiRes`);
  assert.equal(normalizeSmbPath(String.raw`\NAS\Music\HiRes`),String.raw`\\NAS\Music\HiRes`);
  assert.equal(normalizeSmbPath('smb://NAS/Music/HiRes'),String.raw`\\NAS\Music\HiRes`);
  assert.equal(smbShareRoot('smb://NAS/Music/HiRes'),String.raw`\\NAS\Music`);
  assert.equal(normalizeSmbPath('smb://user:secret@NAS/Music'),undefined);
  assert.equal(normalizeSmbPath(String.raw`\\?\C:\Music`),undefined);
});

test('v1.4.14 SMB server identity matches aliases through resolved addresses',()=>{
  assert.equal(smbServerIdentitiesMatch('nas','NAS.'),true);
  assert.equal(smbServerIdentitiesMatch('nas','192.168.1.10',['192.168.1.10'],[]),true);
  assert.equal(smbServerIdentitiesMatch('nas-a','nas-b',['10.0.0.5'],['10.0.0.5']),true);
  assert.equal(smbServerIdentitiesMatch('nas-a','nas-b',['10.0.0.5'],['10.0.0.6']),false);
});
test('v1.4.14 SMB user-facing Chinese stays valid UTF-8 without mojibake',async()=>{
  const root=repoRoot;
  const files=['apps/desktop/src/main/music-network.ts','apps/desktop/src/main/smb-session-manager.ts','apps/desktop/src/main/music-service.ts','apps/desktop/src/renderer/components/MusicNetworkSourceDialog.vue'];
  const badHex=['c3a5c2b7c2b2','c3a5c2','c3a6c2','c3a7c2','c3a4c2'];
  for(const rel of files){const bytes=await readFile(path.join(root,rel));const hex=bytes.toString('hex');for(const pattern of badHex)assert.equal(hex.includes(pattern),false,`${rel} contains double-encoded UTF-8 pattern ${pattern}`);}
  assert.match(new SmbError(1219).message,/Windows 已存在同服务器的其他凭据连接/);
});

test('v1.4.14 SMB source keeps tolerant enumeration and confirmed auto-retry wiring',async()=>{
  const root=repoRoot;
  const manager=await readFile(path.join(root,'apps/desktop/src/main/smb-session-manager.ts'),'utf8');
  const helper=await readFile(path.join(root,'native/player-host/src/smb_helper.cpp'),'utf8');
  const dialog=await readFile(path.join(root,'apps/desktop/src/renderer/components/MusicNetworkSourceDialog.vue'),'utf8');
  assert.match(manager,/try\{result=await native\('list',share\);\}catch\{return\[\];\}/);
  assert.match(helper,/connections\(DWORD& error\)/);
  assert.doesNotMatch(helper,/_wcsicmp\(serverOf\(name\)/);
  assert.match(dialog,/if\(retry\)await save\(\)/);
});

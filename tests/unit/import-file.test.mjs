import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,truncate,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {readImportFile} from '../../apps/desktop/dist/main/import-file.js';

test('local imports preserve bytes at the limit and reject oversized files',async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'fnd-import-limit-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,'fixture.json');
  const bytes=Buffer.from('\uFEFF{"sites":[]}');
  await writeFile(file,bytes);
  assert.deepEqual(await readImportFile(file,bytes.length,'too large'),bytes);
  await assert.rejects(readImportFile(file,bytes.length-1,'too large'),/too large/);
  await truncate(file,64*1024*1024);
  await assert.rejects(readImportFile(file,1024,'too large'),/too large/);
  // Failed imports release the handle, allowing replacement/retry on Windows.
  await writeFile(file,'{}');
  assert.equal((await readImportFile(file,1024,'too large')).toString(),'{}');
  await assert.rejects(readImportFile(dir,1024,'too large'));
  await assert.rejects(readImportFile(file,0,'too large'),/Invalid import size limit/);
});

test('local import reader handles empty files and multiple chunks exactly',async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'fnd-import-chunks-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,'fixture.m3u');
  await writeFile(file,'');
  assert.equal((await readImportFile(file,1,'too large')).length,0);
  const bytes=Buffer.alloc(131077,0x61);bytes[65536]=0x62;bytes[131076]=0x63;
  await writeFile(file,bytes);
  assert.deepEqual(await readImportFile(file,bytes.length,'too large'),bytes);
});

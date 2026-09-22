import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const read=relative=>readFile(path.join(root,relative),'utf8');

test('v1.4.16 release gates keep child routes and session-safe stats',async()=>{
  const main=await read('apps/desktop/src/main/index.ts');
  const player=await read('apps/desktop/src/main/player-client.ts');
  const manifest=await read('package.json');
  assert.match(main,/function createWindow\(route\?:string,primary=true\)/);
  assert.match(main,/loadFile\([^\n]+route\?\{hash:route\}:undefined\)/);
  assert.match(main,/createWindow\(route,false\)/);
  assert.match(main,/trayIconPath\(\)/);
  assert.ok(manifest.includes('"from": "assets/tray-icon.png"'));
  assert.match(player,/#statsInFlight/);
  assert.match(player,/sampleFresh:false/);
  assert.match(player,/cached\.seekRevision/);
});

test('application icon is a decodable PNG in both runtime locations',async()=>{
  const [rootIcon,rendererIcon]=await Promise.all([readFile(path.join(root,'assets/app-icon.png')),readFile(path.join(root,'apps/desktop/src/renderer/assets/app-icon.png'))]);
  assert.deepEqual(rootIcon,rendererIcon);
  assert.deepEqual([...rootIcon.subarray(0,8)],[137,80,78,71,13,10,26,10]);
  const idat=[];for(let offset=8;offset<rootIcon.length;){const length=rootIcon.readUInt32BE(offset);const type=rootIcon.toString('ascii',offset+4,offset+8);if(type==='IDAT')idat.push(rootIcon.subarray(offset+8,offset+8+length));offset+=length+12;}
  assert.ok(idat.length>0);assert.doesNotThrow(()=>inflateSync(Buffer.concat(idat)));
});
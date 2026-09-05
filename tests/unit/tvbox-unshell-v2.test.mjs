import test from 'node:test';
import assert from 'node:assert/strict';
import {createCipheriv} from 'node:crypto';
import { parseTVBoxConfig,unshell } from '../../packages/tvbox-config/dist/index.js';
const config='{"sites":[{"key":"cms","name":"CMS","type":1,"api":"https://api.example/vod","playUrl":"json:https://parser.example/?url=","playerType":2}],"lives":[]}';
const pad=value=>Buffer.from(value.trim().slice(0,16).padEnd(16,'0'),'utf8');
function encrypt(plain,key,mode,iv=''){const cipher=createCipheriv(mode==='cbc'?'aes-128-cbc':'aes-128-ecb',pad(key),mode==='cbc'?pad(iv):null);return Buffer.concat([cipher.update(Buffer.from(plain,'utf8')),cipher.final()]).toString('hex');}
test('base64-star config shell decodes and preserves playback metadata',()=>{const wrapped='abc123**'+Buffer.from(config).toString('base64');const result=unshell(wrapped);assert.equal(result.shell,'base64-star-v1');const parsed=parseTVBoxConfig(wrapped);assert.equal(parsed.sources[0].playUrl,'json:https://parser.example/?url=');assert.equal(parsed.sources[0].playerType,2);assert.equal(parsed.sources[0].configShell,'base64-star-v1');});
test('hex wrapper decodes recursively',()=>{const result=unshell(Buffer.from(config).toString('hex'));assert.equal(result.shell,'hex-wrapper-v1');assert.match(result.text,/\"sites\"/);});
test('TVBox hex dollar CBC shell follows the deterministic key and 13-byte IV protocol',()=>{const key='demo-key',iv='iv-seed-12345';assert.equal(iv.length,13);const wrapped=Buffer.from('$#'+key+'#$').toString('hex')+encrypt(config,key,'cbc',iv)+Buffer.from(iv).toString('hex');const result=unshell(wrapped);assert.equal(result.shell,'hex-dollar-cbc-v1');assert.equal(parseTVBoxConfig(wrapped).sources[0].configShell,'hex-dollar-cbc-v1');});
test('TVBox ;pk; AES ECB payload uses the explicit config key instead of guessed keys',()=>{const key='config-secret';const wrapped=encrypt(config,key,'ecb');const result=unshell(wrapped,0,{configKey:key});assert.equal(result.shell,'pk-aes-ecb-v1');assert.equal(parseTVBoxConfig(wrapped,{configKey:key}).sources[0].configShell,'pk-aes-ecb-v1');});
test('unknown dollar shell returns stable decrypt error and does not guess MD5/SHA keys',()=>{assert.throws(()=>parseTVBoxConfig('$#demo#$0011223344556677'),/SRC_CONFIG_DECRYPT_FAIL/);});
test('TVBox config parser rejects inputs above the 8 MB safety limit',()=>{const oversized='x'.repeat(8*1024*1024+1);assert.throws(()=>parseTVBoxConfig(oversized),/SRC_CONFIG_FORMAT_INVALID/);assert.throws(()=>unshell(oversized),/8 MB/);});

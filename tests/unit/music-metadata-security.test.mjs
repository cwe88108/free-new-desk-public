import test from 'node:test';
import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import {parseBuffer} from 'music-metadata';

test('malformed MP4 stsd entries are rejected within a bounded worker',async t=>{
  const atom=(type,payload)=>{const bytes=Buffer.alloc(8+payload.length);bytes.writeUInt32BE(bytes.length);bytes.write(type,4,4,'ascii');payload.copy(bytes,8);return bytes;};
  const entries=Buffer.alloc(12);entries.writeUInt32BE(0x3fffffff,4);
  const payload=atom('moov',atom('trak',atom('mdia',atom('minf',atom('stbl',atom('stsd',entries))))));
  const worker=new Worker(`const {parentPort,workerData}=require('node:worker_threads');import('music-metadata').then(async({parseBuffer})=>{try{await parseBuffer(Buffer.from(workerData),{mimeType:'video/mp4'});parentPort.postMessage({accepted:true});}catch(error){parentPort.postMessage({error:error.message});}}).catch(error=>{throw error;});`,{eval:true,workerData:payload,resourceLimits:{maxOldGenerationSizeMb:64}});
  t.after(()=>worker.terminate());
  const result=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{void worker.terminate();reject(new Error('Metadata parser exceeded 5s safety deadline'));},5000);
    worker.once('message',value=>{clearTimeout(timer);resolve(value);});worker.once('error',error=>{clearTimeout(timer);reject(error);});
  });
  assert.match(result.error,/Invalid stsd sample entry size: 0/);
});

test('updated metadata parser still recognizes normal PCM WAV audio',async()=>{
  const wav=Buffer.alloc(44+160);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(8000,24);wav.writeUInt32LE(16000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(160,40);
  const result=await parseBuffer(wav,{mimeType:'audio/wav'});
  assert.equal(result.format.sampleRate,8000);assert.equal(result.format.numberOfChannels,1);assert.equal(result.format.duration,.01);
});

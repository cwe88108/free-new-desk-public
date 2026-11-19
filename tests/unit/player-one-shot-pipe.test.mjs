import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {EventEmitter} from 'node:events';import vm from 'node:vm';import ts from 'typescript';

async function subject(){
 const text=await readFile(new URL('../../apps/desktop/src/main/player-client.ts',import.meta.url),'utf8');
 const ast=ts.createSourceFile('client.ts',text,ts.ScriptTarget.Latest,true),cls=ast.statements.find(node=>ts.isClassDeclaration(node)&&node.name.text==='PlayerClient');
 const method=cls.members.find(node=>ts.isMethodDeclaration(node)&&node.name.getText(ast)==='#send').getText(ast);
 const socket=new EventEmitter();socket.writes=[];socket.closed=0;socket.ended=0;socket.setEncoding=()=>{};socket.write=data=>socket.writes.push(data);socket.destroy=()=>socket.closed++;socket.end=()=>socket.ended++;
 const context={net:{createConnection:()=>socket},performance,randomUUID:()=> 'rpc-1',setTimeout,clearTimeout,PlayerRemoteError:class extends Error{},PlayerTransportTimeoutError:Error,PlayerTransportConnectionError:Error};
 vm.runInNewContext(ts.transpileModule(`class Subject {#pipeName='fixture';recordMetric(){}${method}send(...args){return this.#send(...args)}}globalThis.client=new Subject();`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,context);
 return{socket,client:context.client};
}

test('one-shot pipe retains partial response then closes both directions after a complete frame',async()=>{
 const {socket,client}=await subject(),request=client.send('player.query',{query:'stats'});socket.emit('connect');assert.equal(socket.writes.length,1);assert.equal(JSON.parse(socket.writes[0]).method,'player.query');
 socket.emit('data','{"result":');assert.equal(socket.closed,0);socket.emit('data','{"ok":true}}\n');assert.equal((await request).ok,true);assert.equal(socket.closed,1);assert.equal(socket.ended,0);
});
test('remote errors release the listener slot without replaying the command',async()=>{
 const {socket,client}=await subject(),request=client.send('player.command',{command:'seek',value:30});socket.emit('connect');socket.emit('data','{"error":{"message":"PLAYBACK_SUPERSEDED"}}\n');await assert.rejects(request,/PLAYBACK_SUPERSEDED/);assert.equal(socket.closed,1);assert.equal(socket.writes.length,1);
});
test('invalid JSON releases the completed one-shot connection and rejects the response',async()=>{
 const {socket,client}=await subject(),request=client.send('player.query',{query:'stats'});socket.emit('connect');socket.emit('data','{invalid}\n');await assert.rejects(request);assert.equal(socket.closed,1);assert.equal(socket.writes.length,1);
});

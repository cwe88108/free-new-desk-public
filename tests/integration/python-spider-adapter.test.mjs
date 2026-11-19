import test from 'node:test';
import {createServer} from 'node:http';
import assert from 'node:assert/strict';
import {mkdtemp,rm,stat,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {PythonSpiderAdapter} from '../../services/source-engine/dist/python-spider-adapter.js';
import {SourceEngine} from '../../services/source-engine/dist/index.js';
import {prepareExecutableReview,writeExecutableApproval,revokeExecutableApproval} from '../../services/source-engine/dist/executable-trust.js';
import {parseTVBoxConfig} from '../../packages/tvbox-config/dist/index.js';

const fixtureCode=`
import os
class Spider:
    def init(self, ext):
        self.ext = ext
        assert os.environ.get('FND_PRIVATE_CANARY') is None
    def homeContent(self, filter):
        print('source log does not corrupt protocol')
        return {'class': [{'type_id': '1', 'type_name': 'Test'}], 'list': []}
    def homeVideoContent(self):
        return {'list': [{'vod_id': 'v1', 'vod_name': 'Fixture'}]}
    def categoryContent(self, tid, pg, filter, extend):
        return {'page': int(pg), 'pagecount': 3, 'list': [{'vod_id': tid, 'vod_name': extend.get('label', 'Category')}]}
    def detailContent(self, ids):
        return {'list': [{'vod_id': ids[0], 'vod_name': 'Fixture', 'vod_play_from': 'test', 'vod_play_url': 'Episode$https://media.example/1.mp4'}]}
    def searchContent(self, key, quick, pg):
        return {'page': int(pg), 'list': [{'vod_id': 'v1', 'vod_name': key}]}
    def playerContent(self, flag, id, vipFlags):
        return {'url': id, 'parse': 0, 'header': {'User-Agent': 'fixture'}}
`;
function env(t,key,value){const old=process.env[key];process.env[key]=value;t.after(()=>{if(old===undefined)delete process.env[key];else process.env[key]=old;});}
async function setup(t,code=fixtureCode){
  const store=await mkdtemp(path.join(os.tmpdir(),'fnd-python-test-'));t.after(()=>rm(store,{recursive:true,force:true}));
  env(t,'FND_PYTHON_TRUSTED_RUNTIME','1');env(t,'FND_PRIVATE_CANARY','must-not-inherit');
  let current=code;t.mock.method(globalThis,'fetch',async()=>new Response(current));
  const config={id:'python-fixture',name:'Python fixture',kind:'T3_PY',endpoint:'https://203.0.113.1/spider.py',enabled:true,trust:'A',configRevision:'r1',ext:'fixture-config'};
  const ctx={sourceId:config.id,executableTrustStoreDir:store};
  const approve=async()=>writeExecutableApproval(store,await prepareExecutableReview(config));
  return{config,ctx,store,approve,setCode:value=>{current=value;}};
}

test('Python imports are explicitly typed and disabled; explicit HTTP Type4 is preserved',()=>{
  const {sources}=parseTVBoxConfig(JSON.stringify({sites:[{key:'p',type:3,api:'https://example.com/Alist.py?x=1'},{key:'e',type:3,api:'python',ext:'https://example.com/a.py#v1'},{key:'h',type:4,api:'https://example.com/service.py'}]}));
  assert.deepEqual(sources.map(s=>[s.kind,s.enabled,s.trust]),[['T3_PY',false,'B'],['T3_PY',false,'B'],['T4_EXT',true,'A']]);
});
test('Python execution is disabled by default even when metadata claims trust',async t=>{
  const f=await setup(t);env(t,'FND_PYTHON_TRUSTED_RUNTIME','0');
  const adapter=new PythonSpiderAdapter(f.config);await assert.rejects(()=>adapter.init(f.ctx),/SRC_PYTHON_RUNTIME_DISABLED/);await adapter.destroy();
});
test('Python review binds bytes, config revision and revocation before execution',async t=>{
  const f=await setup(t);
  const denied=async config=>{const adapter=new PythonSpiderAdapter(config);await assert.rejects(()=>adapter.init(f.ctx),/SOURCE_EXECUTABLE_NOT_APPROVED/);await adapter.destroy();};
  await denied(f.config);await f.approve();f.setCode(fixtureCode+'\n# remote changed');await denied(f.config);
  f.setCode(fixtureCode);await denied({...f.config,configRevision:'r2'});
  await revokeExecutableApproval(f.store,f.config.id);await denied(f.config);
});
test('CPython lifecycle normalizes home, category, search, detail and V2 play through SourceEngine',async t=>{
  const f=await setup(t);await f.approve();const engine=new SourceEngine();t.after(()=>engine.destroy());engine.configureRuntime({executableTrustStoreDir:f.store});await engine.replaceSources([f.config]);
  assert.equal((await engine.getHome(f.config.id)).items[0].name,'Fixture');
  assert.equal((await engine.getCategory(f.config.id,'1',2,{label:'Filtered'})).items[0].name,'Filtered');
  assert.equal((await engine.search(f.config.id,'needle',2)).page,2);
  const detail=await engine.getDetail(f.config.id,['v1']);assert.equal(detail.episodes.length,1);
  const play=await engine.getPlayV2(f.config.id,'test',detail.episodes[0].id);assert.equal(play.candidates[0].target.kind,'media');assert.equal(play.candidates[0].headers['User-Agent'],'fixture');
  assert.equal(engine.runtimeSnapshot().length,1);await engine.resetExecutable(f.config.id);assert.equal(engine.runtimeSnapshot().length,0);
});
test('Python timeout kills the host and later calls fail instead of hanging',async t=>{
  const f=await setup(t,fixtureCode.replace("return {'url': id, 'parse': 0, 'header': {'User-Agent': 'fixture'}}","__import__('time').sleep(60)"));await f.approve();
  const adapter=new PythonSpiderAdapter(f.config);t.after(()=>adapter.destroy());await adapter.init(f.ctx);
  // Start the deadline after real initialization: a 300 ms cold-start budget made
  // this invocation-timeout test fail before it reached the behavior under test.
  t.mock.timers.enable({apis:['setTimeout']});
  const timedOut=assert.rejects(()=>adapter.getPlay('test','https://media.example/1.mp4'),/SRC_PYTHON_TIMEOUT/);
  try{t.mock.timers.tick(15_000);}finally{t.mock.timers.reset();}
  await timedOut;
  await assert.rejects(()=>adapter.getHome(),/SRC_PYTHON_EXITED/);await adapter.destroy();
});
test('Python cancellation kills in-flight code and cleans up',async t=>{
  const f=await setup(t,fixtureCode.replace("return {'url': id, 'parse': 0, 'header': {'User-Agent': 'fixture'}}","__import__('time').sleep(60)"));await f.approve();
  const adapter=new PythonSpiderAdapter(f.config);t.after(()=>adapter.destroy());await adapter.init(f.ctx);const controller=new AbortController();
  const pending=adapter.getPlay('test','https://media.example/1.mp4',controller.signal);controller.abort();await assert.rejects(pending,{name:'AbortError'});await adapter.destroy();
});
test('Python direct playback cannot return a local file or unsupported proxy URL',async t=>{
  const f=await setup(t);await f.approve();const adapter=new PythonSpiderAdapter(f.config);t.after(()=>adapter.destroy());await adapter.init(f.ctx);
  for(const id of ['file:///etc/passwd','proxy://callback','\\\\host\\share'])await assert.rejects(()=>adapter.getPlay('test',id),/SRC_PYTHON_PLAY_UNSUPPORTED/);
});
test('Python large stdout and source exception secrets never become successful payloads',async t=>{
  const f=await setup(t,fixtureCode.replace("return {'url': id, 'parse': 0, 'header': {'User-Agent': 'fixture'}}","raise RuntimeError('Authorization: Bearer private-canary')"));await f.approve();
  let adapter=new PythonSpiderAdapter(f.config);await adapter.init(f.ctx);await assert.rejects(()=>adapter.getPlay('test','id'),error=>/SRC_PYTHON_INVOKE_FAILED/.test(error.message)&&!error.message.includes('private-canary'));await adapter.destroy();
  f.setCode(fixtureCode.replace("return {'url': id, 'parse': 0, 'header': {'User-Agent': 'fixture'}}","os.write(1, b'x' * (5 * 1024 * 1024))"));await f.approve();adapter=new PythonSpiderAdapter(f.config);t.after(()=>adapter.destroy());await adapter.init(f.ctx);await assert.rejects(()=>adapter.getPlay('test','id'),/SRC_PYTHON_OUTPUT_LIMIT/);await adapter.destroy();
});
test('missing CPython produces a bounded actionable failure',async t=>{
  const f=await setup(t);await f.approve();env(t,'FND_PYTHON_COMMAND','/nonexistent/fnd-python');const adapter=new PythonSpiderAdapter(f.config);t.after(()=>adapter.destroy());await assert.rejects(()=>adapter.init(f.ctx),/SRC_PYTHON_NOT_FOUND/);
});

test('destroy waits for actual host exit and removes its temporary directory',async t=>{
  const f=await setup(t,fixtureCode.replace("{'vod_id': 'v1', 'vod_name': 'Fixture'}", "{'vod_id': str(os.getpid()), 'vod_name': 'Fixture', 'vod_pic': os.getcwd()}"));await f.approve();
  const adapter=new PythonSpiderAdapter(f.config);t.after(()=>adapter.destroy());await adapter.init(f.ctx);
  const card=(await adapter.getHome()).items[0];assert.ok((await stat(card.poster)).isDirectory());const pid=Number(card.id);assert.ok(pid>0);
  await adapter.destroy();assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});await assert.rejects(()=>stat(card.poster),{code:'ENOENT'});
});
test('invalid result shapes and unavailable dependency profiles fail explicitly',async t=>{
  const f=await setup(t,fixtureCode.replace("return {'url': id, 'parse': 0, 'header': {'User-Agent': 'fixture'}}",'return 42'));await f.approve();
  let adapter=new PythonSpiderAdapter(f.config);await adapter.init(f.ctx);await assert.rejects(()=>adapter.getPlay('test','id'),/SRC_PYTHON_INVOKE_FAILED/);await adapter.destroy();
  f.setCode('from base.spider import Spider\n');await f.approve();adapter=new PythonSpiderAdapter(f.config);await assert.rejects(()=>adapter.init(f.ctx),/SRC_PYTHON_INVOKE_FAILED/);await adapter.destroy();
});

for(const mode of ['destroy','timeout'])test(`Windows ${mode} removes the real Python host and its inherited-pipe child`, {skip:process.platform!=='win32'},async t=>{
  const code=fixtureCode.replace('self.ext = ext', "self.ext = ext\n        import subprocess, sys\n        self.child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(20)'])")
    .replace("{'vod_id': 'v1', 'vod_name': 'Fixture'}", "{'vod_id': str(os.getpid()) + ':' + str(self.child.pid), 'vod_name': 'Fixture'}")
    .replace("return {'url': id, 'parse': 0, 'header': {'User-Agent': 'fixture'}}", "__import__('time').sleep(20)");
  const f=await setup(t,code);await f.approve();const adapter=new PythonSpiderAdapter(f.config);
  t.after(()=>adapter.destroy());
  await adapter.init(f.ctx);
  const ids=(await adapter.getHome()).items[0].id.split(':').map(Number);
  assert.equal(ids.length,2);for(const id of ids){assert.ok(Number.isInteger(id)&&id>0);assert.doesNotThrow(()=>process.kill(id,0));}
  const started=Date.now();
  if(mode==='timeout'){
    t.mock.timers.enable({apis:['setTimeout']});
    const pending=assert.rejects(()=>adapter.getPlay('test','id'),/SRC_PYTHON_TIMEOUT/);
    try{t.mock.timers.tick(15_000);}finally{t.mock.timers.reset();}
    await pending;
  }
  await adapter.destroy();
  assert.ok(Date.now()-started<5000,'destroy must finish before the child sleep expires');
  for(const id of ids)assert.throws(()=>process.kill(id,0),{code:'ESRCH'},'both host and test child must exit');
});

test('detached descendants retaining stdio cannot block Python destruction', {skip:process.platform==='win32'},async t=>{
  const code=fixtureCode.replace('self.ext = ext', "self.ext = ext\n        import subprocess, sys\n        self.detached = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'], start_new_session=True)")
    .replace("{'vod_id': 'v1', 'vod_name': 'Fixture'}", "{'vod_id': str(self.detached.pid), 'vod_name': 'Fixture'}")
    .replace("return {'url': id, 'parse': 0, 'header': {'User-Agent': 'fixture'}}", "__import__('time').sleep(60)");
  const f=await setup(t,code);await f.approve();const adapter=new PythonSpiderAdapter(f.config,300);let descendant;
  t.after(async()=>{if(descendant)try{process.kill(descendant,'SIGKILL');}catch{}await adapter.destroy();});
  await adapter.init(f.ctx);descendant=Number((await adapter.getHome()).items[0].id);assert.ok(descendant>0);
  await assert.rejects(()=>adapter.getPlay('test','id'),/SRC_PYTHON_TIMEOUT/);
  const started=Date.now();await adapter.destroy();assert.ok(Date.now()-started<3000,'destroy must not wait for detached descendant EOF');
  // We explicitly do not claim containment of a process that escaped the process group.
  assert.doesNotThrow(()=>process.kill(descendant,0));process.kill(descendant,'SIGKILL');descendant=undefined;
});

test('aborting Python initialization during download never executes the delayed approved code',async t=>{
  const f=await setup(t);const marker=path.join(f.store,'must-not-run');
  const code=`from pathlib import Path\nPath(${JSON.stringify(marker)}).write_text('executed')\n`+fixtureCode;
  f.setCode(code);await f.approve();
  let release,started;const gate=new Promise(resolve=>{release=resolve;});const requested=new Promise(resolve=>{started=resolve;});
  t.mock.method(globalThis,'fetch',async()=>{started();await gate;return new Response(code);});
  const adapter=new PythonSpiderAdapter(f.config);t.after(()=>adapter.destroy());const controller=new AbortController();
  const pending=adapter.init(f.ctx,controller.signal);const rejected=assert.rejects(pending,{name:'AbortError'});
  await requested;controller.abort();release();await rejected;await adapter.destroy();
  await assert.rejects(()=>stat(marker),{code:'ENOENT'});
});

test('SourceEngine cancellation during download cannot execute code after the caller has returned',async t=>{
  const f=await setup(t);const marker=path.join(f.store,'engine-must-not-run');
  const code=`from pathlib import Path\nPath(${JSON.stringify(marker)}).write_text('executed')\n`+fixtureCode;
  f.setCode(code);await f.approve();
  let release,started;const gate=new Promise(resolve=>{release=resolve;});const requested=new Promise(resolve=>{started=resolve;});
  t.mock.method(globalThis,'fetch',async()=>{started();await gate;return new Response(code);});
  const engine=new SourceEngine();t.after(()=>engine.destroy());engine.configureRuntime({executableTrustStoreDir:f.store});await engine.replaceSources([f.config]);
  const controller=new AbortController();const pending=engine.getHome(f.config.id,controller.signal);const rejected=assert.rejects(pending,{name:'AbortError'});
  await requested;controller.abort();await rejected;release();
  // Await the abandoned initialization, not an arbitrary delay, before checking absence of execution.
  await engine.resetExecutable(f.config.id);assert.equal(engine.runtimeSnapshot().length,0);
  await assert.rejects(()=>stat(marker),{code:'ENOENT'});
  // A subsequent explicit request is a fresh initialization and remains usable.
  assert.equal((await engine.getHome(f.config.id)).items[0].name,'Fixture');assert.ok((await stat(marker)).isFile());
});

test('one cancelled SourceEngine initialization waiter does not cancel another live waiter',async t=>{
  const f=await setup(t);await f.approve();let release,started,downloads=0;
  const gate=new Promise(resolve=>{release=resolve;});const requested=new Promise(resolve=>{started=resolve;});
  t.mock.method(globalThis,'fetch',async()=>{downloads++;started();await gate;return new Response(fixtureCode);});
  const engine=new SourceEngine();t.after(()=>engine.destroy());engine.configureRuntime({executableTrustStoreDir:f.store});await engine.replaceSources([f.config]);
  const controller=new AbortController();const first=engine.getHome(f.config.id,controller.signal);const rejected=assert.rejects(first,{name:'AbortError'});
  await requested;const second=engine.getHome(f.config.id);controller.abort();await rejected;release();
  assert.equal((await second).items[0].name,'Fixture');assert.equal(downloads,1);assert.equal(engine.runtimeSnapshot().length,1);
});

const catvodCode=await readFile(new URL('../fixtures/python/catvod_spider.py',import.meta.url),'utf8');
test('bundled CatVod base module is reviewed and original fixture completes the source lifecycle',async t=>{
  const f=await setup(t,catvodCode);const review=await prepareExecutableReview(f.config);
  assert.equal(review.artifacts.length,2);
  const dependency=review.artifacts.find(artifact=>artifact.role==='dependency');
  assert.match(dependency.location,/python-catvod-stdlib-v3/);
  assert.match(dependency.content,/class Spider:/);
  await f.approve();const adapter=new PythonSpiderAdapter(f.config);t.after(()=>adapter.destroy());await adapter.init(f.ctx);
  assert.equal((await adapter.getHome()).items[0].name,'fixture-config');
  assert.equal((await adapter.getCategory('film',2,{label:'Filtered'})).items[0].name,'Filtered');
  assert.equal((await adapter.search('two-argument search',2)).items[0].name,'two-argument search');
  const detail=await adapter.getDetail(['fixture']);assert.equal(detail.episodes.length,1);
  assert.equal((await adapter.getPlay('fixture',detail.episodes[0].id)).headers['User-Agent'],'authored-fixture');
});
test('CatVod search supports optional positional and keyword-only pg without retrying source errors',async t=>{
  for(const signature of ["key, quick, pg='1'", "key, quick, *, pg='1'"]){
    const f=await setup(t,catvodCode.replace('key, quick):',signature+'):').replace("return {'list': [{'vod_id': 'fixture', 'vod_name': key}]}","return {'page': int(pg), 'list': [{'vod_id': 'fixture', 'vod_name': key}]}"));
    await f.approve();const adapter=new PythonSpiderAdapter(f.config);try{await adapter.init(f.ctx);assert.equal((await adapter.search('query',3)).page,3);}finally{await adapter.destroy();}
  }
  const f=await setup(t,catvodCode.replace("return {'list': [{'vod_id': 'fixture', 'vod_name': key}]}","self.label += 'x'\n        raise TypeError('source failure')"));
  await f.approve();const adapter=new PythonSpiderAdapter(f.config);t.after(()=>adapter.destroy());await adapter.init(f.ctx);
  await assert.rejects(()=>adapter.search('query'),/SRC_PYTHON_INVOKE_FAILED/);
  assert.equal((await adapter.getHome()).items[0].name,'fixture-configx');
});
test('CatVod rejects undeclared executable dependencies and unsupported proxy helpers',async t=>{
  for(const code of [catvodCode+"\n    def getDependence(self): return ['remote.spider']\n", 'import lxml\n'+catvodCode]){
    const f=await setup(t,code);await f.approve();const adapter=new PythonSpiderAdapter(f.config);
    try{await assert.rejects(()=>adapter.init(f.ctx),/SRC_PYTHON_INVOKE_FAILED/);}finally{await adapter.destroy();}
  }
  const f=await setup(t,catvodCode.replace("return self.json2str({'parse': 0, 'url': id, 'header': {'User-Agent': 'authored-fixture'}})",'return self.getProxyUrl()'));
  await f.approve();const adapter=new PythonSpiderAdapter(f.config);t.after(()=>adapter.destroy());await adapter.init(f.ctx);
  await assert.rejects(()=>adapter.getPlay('fixture','id'),/SRC_PYTHON_INVOKE_FAILED/);
});

test('CatVod stdlib helpers exercise HTTP GET/POST, JSON, status, cache expiry and explicit unsupported options',async t=>{
  const server=createServer(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk;
    res.setHeader('Content-Type','application/json; charset=utf-8');
    if(req.url.startsWith('/status'))res.statusCode=404;
    if(req.url.startsWith('/redirect')){res.statusCode=302;res.setHeader('Location','/result');}
    res.end(JSON.stringify({method:req.method,url:req.url,body,cookie:req.headers.cookie??'',agent:req.headers['user-agent']}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const url=`http://127.0.0.1:${server.address().port}`;
  const assertions=`
        response = self.fetch('${url}/result#fragment', params={'key': '中 文'}, cookies={'fixture': 'value'}, headers={'User-Agent': 'fixture'})
        assert response.status_code == 200
        assert response.json()['cookie'] == 'fixture=value'
        assert response.json()['url'] == '/result?key=%E4%B8%AD+%E6%96%87'
        assert response.json()['agent'] == 'fixture'
        assert self.post('${url}/result', json={'fixture': True}).json()['body'] == '{"fixture": true}'
        assert self.post('${url}/result', data={'fixture': 'a b'}).json()['body'] == 'fixture=a+b'
        assert self.fetch('${url}/status').status_code == 404
        assert self.fetch('${url}/redirect', allow_redirects=False).status_code == 302
        assert self.fetch('${url}/redirect').url.endswith('/result')
        self.setCache('expired', {'expires': 1})
        assert self.getCache('expired') is None
        self.delCache('fixture')
        assert self.getCache('fixture') is None
        for target, options in [('file:///etc/passwd', {}), ('${url}', {'verify': False}), ('${url}', {'stream': True})]:
            try:
                self.fetch(target, **options)
            except (ValueError, NotImplementedError):
                pass
            else:
                raise AssertionError('unsupported option accepted')
`;
  const f=await setup(t,catvodCode.replace('self.label = extend','self.label = extend'+assertions));
  await f.approve();const adapter=new PythonSpiderAdapter(f.config);t.after(()=>adapter.destroy());await adapter.init(f.ctx);
  assert.equal((await adapter.getHome()).items[0].name,'fixture-config');
});

test('bounded requests compatibility facade supports module calls and Session GET/POST',async t=>{
  const server=createServer(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk;
    res.setHeader('Content-Type','application/json; charset=utf-8');
    res.end(JSON.stringify({method:req.method,url:req.url,body,cookie:req.headers.cookie??'',header:req.headers['x-test']??req.headers['x-session']??''}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const url=`http://127.0.0.1:${server.address().port}`;
  const code=`
import requests
from requests.exceptions import RequestException
class Spider:
    def init(self, ext):
        self.ext = ext
        assert issubclass(RequestException, Exception)
        response = requests.get(ext + '/get', params={'q': 'hello'}, headers={'X-Test': 'module'}, timeout=3)
        assert response.status_code == 200 and response.ok
        assert response.json()['url'] == '/get?q=hello'
        assert response.json()['header'] == 'module'
        with requests.Session() as session:
            session.headers.update({'X-Session': 'yes'})
            session.cookies.update({'sid': 'cookie'})
            posted = session.post(ext + '/post', params={'q': 'post'}, json={'value': 1}, timeout=3)
            assert posted.json()['body'] == '{"value": 1}'
            assert posted.json()['url'] == '/post?q=post'
            assert posted.json()['cookie'] == 'sid=cookie'
            assert posted.json()['header'] == 'yes'
    def homeContent(self, filter):
        return {'class': [], 'list': [{'vod_id': 'ok', 'vod_name': 'requests'}]}
    def categoryContent(self, tid, pg, filter, extend):
        return {'list': []}
    def detailContent(self, ids):
        return {'list': []}
    def searchContent(self, key, quick, pg='1'):
        return {'list': []}
    def playerContent(self, flag, id, vipFlags):
        return {'url': id, 'parse': 0}
`;
  const f=await setup(t,code);f.config.ext=url;await f.approve();
  const adapter=new PythonSpiderAdapter(f.config);t.after(()=>adapter.destroy());await adapter.init(f.ctx);
  assert.equal((await adapter.getHome()).items[0].name,'requests');
});

test('entry-only approval cannot authorize a changed bundled Python profile',async t=>{
  const f=await setup(t,catvodCode);const review=await prepareExecutableReview(f.config);
  const {createExecutableReview}=await import('../../services/source-engine/dist/executable-trust.js');
  await writeExecutableApproval(f.store,createExecutableReview(f.config,review.artifacts.filter(artifact=>artifact.role==='entry')));
  const adapter=new PythonSpiderAdapter(f.config);t.after(()=>adapter.destroy());
  await assert.rejects(()=>adapter.init(f.ctx),/SOURCE_EXECUTABLE_NOT_APPROVED/);
});

for(const change of ['disable','remove','revise'])test(`reconcile ${change} cancels pending Python initialization before approved bytes execute`,async t=>{
  const f=await setup(t);const marker=path.join(f.store,'retired-must-not-run');
  const code=`from pathlib import Path\nPath(${JSON.stringify(marker)}).write_text('executed')\n`+fixtureCode;
  f.setCode(code);await f.approve();let release,started;
  const gate=new Promise(resolve=>{release=resolve;});const requested=new Promise(resolve=>{started=resolve;});
  t.mock.method(globalThis,'fetch',async()=>{started();await gate;return new Response(code);});
  const engine=new SourceEngine();t.after(()=>engine.destroy());engine.configureRuntime({executableTrustStoreDir:f.store});await engine.replaceSources([f.config]);
  const pending=engine.getHome(f.config.id);const rejected=assert.rejects(pending,{name:'AbortError'});
  await requested;
  await engine.replaceSources(change==='remove'?[]:[{...f.config,...(change==='disable'?{enabled:false}:{configRevision:'r2'})}]);
  await rejected;release();await engine.resetExecutable(f.config.id);
  assert.equal(engine.runtimeSnapshot().length,0);await assert.rejects(()=>stat(marker),{code:'ENOENT'});
  if(change==='revise')await assert.rejects(()=>engine.getHome(f.config.id),/SOURCE_EXECUTABLE_NOT_APPROVED/);
  else await assert.rejects(()=>engine.getHome(f.config.id),/disabled or missing/);
});

test('CatVod HTTP helpers strip cross-origin credentials and reject oversized or stalled responses',async t=>{
  const target=createServer((req,res)=>res.end(JSON.stringify({authorization:req.headers.authorization??'',cookie:req.headers.cookie??''})));
  await new Promise(resolve=>target.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>target.close(resolve)));
  const targetUrl=`http://127.0.0.1:${target.address().port}`;
  const server=createServer((req,res)=>{
    if(req.url==='/large'){res.end(Buffer.alloc(4*1024*1024+1,120));return;}
    if(req.url==='/slow'){res.writeHead(200);res.write('x');return;}
    res.writeHead(302,{Location:targetUrl});res.end();
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve));});
  const url=`http://127.0.0.1:${server.address().port}`;
  const assertions=`
        result = self.fetch('${url}/redirect', headers={'Authorization': 'fixture-secret', 'Cookie': 'fixture-secret'}).json()
        assert result == {'authorization': '', 'cookie': ''}
        try:
            self.fetch('${url}/large')
        except ValueError:
            pass
        else:
            raise AssertionError('oversized response accepted')
        import time
        start = time.monotonic()
        try:
            self.fetch('${url}/slow', timeout=0.1)
        except TimeoutError:
            pass
        else:
            raise AssertionError('stalled response accepted')
        assert time.monotonic() - start < 3
`;
  const f=await setup(t,catvodCode.replace('self.label = extend','self.label = extend'+assertions));
  await f.approve();const adapter=new PythonSpiderAdapter(f.config);t.after(()=>adapter.destroy());await adapter.init(f.ctx);
  assert.equal((await adapter.getHome()).items[0].name,'fixture-config');
});

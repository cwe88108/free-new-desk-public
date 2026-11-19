import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';

// Execute the actual main-process functions with the network and storage replaced.
const source=await readFile(new URL('../../apps/desktop/src/main/index.ts',import.meta.url),'utf8');
const parsed=ts.createSourceFile('index.ts',source,ts.ScriptTarget.Latest,true);
const names=new Set(['newer','allowedExternal','checkRepoUpdate','checkUpdateAndRecord']);
const functions=parsed.statements.filter(node=>ts.isFunctionDeclaration(node)&&names.has(node.name?.text)).map(node=>node.getText(parsed)).join('\n');
assert.equal(parsed.statements.filter(node=>ts.isFunctionDeclaration(node)&&names.has(node.name?.text)).length,names.size);
async function harness(transport,current='1.4.18',privateDistribution=false){
  const values=new Map(),calls=[],store={getSetting:key=>values.get(key),setSetting:(key,value)=>values.set(key,value)};
  let authorized=true;
  const repositoryPath=privateDistribution?'test-owner/test-private-repo':'cwe88108/free-new-desk-public';
  const context={privateDistribution,repositoryPath,releasesUrl:`https://github.com/${repositoryPath}/releases`,URL,Date,console,data:store,app:{getVersion:()=>current},readGitHubUpdateToken:()=>{if(!authorized)throw new Error('[UPDATE_AUTH_REQUIRED] authorize');return 'github_pat_SYNTHETIC_ONLY';},broker:{json:async request=>{calls.push(request);return transport(request);}}};
  const script='let updateCheckRevision=0;\n'+functions+'\nglobalThis.api={checkRepoUpdate,checkUpdateAndRecord,changeAuthorization:()=>{updateCheckRevision++;}};';
  vm.runInNewContext(ts.transpileModule(script,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,context);
  return{...context.api,store,values,calls,setAuthorized:value=>{authorized=value;}};
}

test('private build never queries the public release channel or records a false success',async()=>{
  const h=await harness(()=>{throw new Error('network must not be called');},'1.5.14',true);
  h.setAuthorized(false);
  h.values.set('update.lastResult','stale success');
  await assert.rejects(h.checkUpdateAndRecord(h.store,'stable'),/UPDATE_AUTH_REQUIRED/);
  assert.equal(h.calls.length,0);
  assert.equal(h.values.get('update.lastResult'),'');
  assert.equal(h.values.get('update.lastCheck'),undefined);
});

test('private update sends authorization only to the configured GitHub API and refuses redirects',async()=>{
  const h=await harness(()=>({tag_name:'v1.5.15'}),'1.5.14',true);
  assert.equal((await h.checkUpdateAndRecord(h.store,'stable')).available,true);
  assert.equal(h.calls[0].url,'https://api.github.com/repos/test-owner/test-private-repo/releases/latest');
  assert.equal(h.calls[0].headers.Authorization,'Bearer github_pat_SYNTHETIC_ONLY');
  assert.equal(h.calls[0].redirect,'error');
  assert.equal(h.calls[0].allowSensitiveDefaults,false);
  assert.doesNotMatch(JSON.stringify([...h.values]),/SYNTHETIC_ONLY/);
});

test('private update stores a safe error if transport failure contains sensitive detail',async()=>{
  const h=await harness(()=>{throw new Error('private transport detail SYNTHETIC_ONLY');},'1.5.14',true);
  await assert.rejects(h.checkUpdateAndRecord(h.store,'stable'),/UPDATE_UNAVAILABLE/);
  assert.doesNotMatch(JSON.stringify([...h.values]),/SYNTHETIC_ONLY/);
});

test('public release check needs no credential and refuses redirects',async()=>{
  const h=await harness(()=>({tag_name:'v1.4.19',html_url:'https://github.com/cwe88108/free-new-desk-public/releases/tag/v1.4.19'}));
  h.setAuthorized(false);
  const result=await h.checkUpdateAndRecord(h.store,'stable');
  assert.equal(result.latest,'1.4.19');assert.equal(result.available,true);
  assert.equal(h.calls[0].headers.Authorization,undefined);assert.match(h.calls[0].url,/free-new-desk-public\/releases\/latest$/);
  assert.equal(h.calls[0].headers.Cookie,undefined);
  assert.equal(h.calls[0].redirect,'error');assert.equal(h.calls[0].allowSensitiveDefaults,false);
  assert.equal(h.store.getSetting('update.lastCheck'),result.checkedAt);
  assert.equal(h.store.getSetting('update.lastError'),'');
  assert.equal(JSON.stringify([...h.values]).includes('github_pat_SYNTHETIC_ONLY'),false);
});

test('auth failure and invalid release metadata clear stale success without faking latest',async()=>{
  for(const failure of [new Error('HTTP 401 for source request'),new Error('HTTP 403 for source request'),new Error('HTTP 404 for source request'),null,{},[],{tag_name:'not-a-version'}]){
    const h=await harness(()=>{if(failure instanceof Error)throw failure;return failure;});
    h.values.set('update.lastResult','old success');h.values.set('update.lastCheck','last actual success');
    await assert.rejects(h.checkUpdateAndRecord(h.store,'stable'),/UPDATE_UNAVAILABLE|UPDATE_NOT_PUBLISHED|UPDATE_METADATA_INVALID/);
    assert.equal(h.store.getSetting('update.lastResult'),'');assert.equal(h.store.getSetting('update.lastCheck'),'last actual success');
    assert.ok(h.store.getSetting('update.lastError'));assert.ok(h.store.getSetting('update.lastAttempt'));
  }
});

test('daily check excludes drafts and a superseded check rejects the old response',async()=>{
  let finish;const pending=new Promise(resolve=>{finish=resolve;});
  const h=await harness(()=>pending);
  const check=h.checkUpdateAndRecord(h.store,'daily');h.changeAuthorization();
  finish([{tag_name:'v9.0.0',draft:true},{tag_name:'v1.4.19',draft:false}]);
  await assert.rejects(check,/UPDATE_CHECK_SUPERSEDED/);
  assert.equal(h.store.getSetting('update.lastResult'),undefined);
  assert.equal(h.store.getSetting('update.lastCheck'),undefined);
  assert.match(h.calls[0].url,/releases\?per_page=20$/);
  assert.equal((await h.checkRepoUpdate('daily')).latest,'1.4.19');
});

test('release navigation rejects another host or a repository-name prefix lookalike',async()=>{
  for(const url of ['https://example.com/releases','https://github.com/cwe88108/free-new-desk-public-extra/releases','https://github.com/cwe88108/other/releases']){
    const h=await harness(()=>({tag_name:'v1.4.19',html_url:url}));
    assert.equal((await h.checkRepoUpdate('stable')).url,'https://github.com/cwe88108/free-new-desk-public/releases');
  }
});

test('release comparison respects prerelease identifiers and ignores build metadata',async()=>{
  for(const [current,latest,available] of [
    ['1.4.19-rc.2','v1.4.19-rc.10',true],['1.4.19-rc.10','v1.4.19',true],
    ['1.4.19','v1.4.19-rc.10',false],['1.4.19+build1','v1.4.19+build2',false],
    ['1.4.19-rc.10','v1.4.19-rc.2',false],
  ]){const h=await harness(()=>({tag_name:latest}),current);assert.equal((await h.checkRepoUpdate('stable')).available,available,current+' -> '+latest);}
});

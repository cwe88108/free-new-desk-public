import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';

const electron = `
  export class BrowserWindow {
    onHeadersReceived;
    webContents = {
      once() {},
      session: {
        webRequest: {
          onBeforeSendHeaders() {},
          onHeadersReceived: (_filter, listener) => { this.onHeadersReceived = listener; },
        },
      },
    };
    isDestroyed() { return false; }
    destroy() {}
    async loadURL(url) {
      for (const [path, resourceType, contentType, statusCode = 200] of JSON.parse(new URL(url).searchParams.get('fixture'))) {
        if (!this.onHeadersReceived) break;
        this.onHeadersReceived({
          id: 1, url: new URL(path, url).href, resourceType, statusCode,
          responseHeaders: {'content-type': [contentType]},
        }, () => {});
      }
    }
  }`;
const hooks=registerHooks({
  resolve(specifier,context,nextResolve) {
    if(specifier==='electron')return {url:`data:text/javascript,${encodeURIComponent(electron)}`,shortCircuit:true};
    return nextResolve(specifier,context);
  },
});
const {SniffingService}=await import('../../apps/desktop/dist/main/sniffing-service.js');
hooks.deregister();

async function sniff(responses) {
  const page=new URL('https://fixture.invalid/player');
  page.searchParams.set('fixture',JSON.stringify(responses));
  const result=await new SniffingService().resolve('fixture',page.href,{},500);
  return new URL(result.url).pathname;
}

test('sniffing waits for the manifest after generic binary page assets',async()=>{
  const assets=['image','font','script','stylesheet','ping'].map(type=>[`/${type}`,type,'application/octet-stream']);
  assert.equal(await sniff([...assets,['/stream.m3u8','xhr','application/vnd.apple.mpegurl']]),'/stream.m3u8');
});

test('sniffing still accepts extensionless binary media and XHR streams',async()=>{
  for(const type of ['media','xhr'])assert.equal(await sniff([['/stream',type,'application/octet-stream']]),'/stream');
});

test('sniffing reports a main document HTTP error instead of waiting for media',async()=>{
  await assert.rejects(sniff([['/missing','mainFrame','text/html',404]]),/\[PLAY_PARSER_FAILED\].*HTTP 404/);
});

test('sniffing can continue after redirects and failed page assets',async()=>{
  assert.equal(await sniff([
    ['/redirect','mainFrame','text/html',302],
    ['/frame','subFrame','text/html',404],
    ['/poster','image','text/html',404],
    ['/stream.m3u8','xhr','application/vnd.apple.mpegurl'],
  ]),'/stream.m3u8');
});

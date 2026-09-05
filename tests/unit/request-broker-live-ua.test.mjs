import test from 'node:test';
import assert from 'node:assert/strict';
import { RequestBroker } from '../../packages/source-sdk/dist/index.js';

test('live playlist retries 403 with a compatibility user agent', async () => {
  const originalFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (_url, init = {}) => {
    const headers = new Headers(init.headers);
    seen.push(headers.get('user-agent'));
    if (seen.length === 1) return new Response('forbidden', { status: 403 });
    return new Response('#EXTM3U\n', { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  };
  try {
    const broker = new RequestBroker();
    const text = await broker.text({ sourceId: 'live:test', url: 'https://example.test/live.m3u', retries: 0 });
    assert.equal(text, '#EXTM3U\n');
    assert.match(seen[0] ?? '', /Mozilla\/5\.0/);
    assert.equal(seen[1], 'okhttp/3.15');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('explicit live user agent is never replaced by compatibility fallback', async () => {
  const originalFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (_url, init = {}) => {
    const headers = new Headers(init.headers);
    seen.push(headers.get('user-agent'));
    return new Response('forbidden', { status: 403 });
  };
  try {
    const broker = new RequestBroker();
    await assert.rejects(
      broker.text({ sourceId: 'live:test', url: 'https://example.test/live.m3u', headers: { 'User-Agent': 'custom-tvbox' }, retries: 0 }),
      /HTTP 403/
    );
    assert.deepEqual(seen, ['custom-tvbox']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

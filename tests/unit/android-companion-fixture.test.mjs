import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createServer } from 'node:tls';
import { createHash, randomBytes, X509Certificate } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { AndroidCompanionFixtureClient } from '../../services/source-engine/dist/android-companion-fixture.js';

// This is a transport fixture, NOT Android/ART/device evidence. Test keys are ephemeral.
const hasOpenSsl = spawnSync('openssl', ['version'], { stdio: 'ignore' }).status === 0;
let directory, key, cert, pin;
const token = randomBytes(32).toString('base64url');
const sessionId = randomBytes(32).toString('base64url');
const resourceHandle = randomBytes(32).toString('base64url');
before(async () => {
  if (!hasOpenSsl) return;
  directory = await mkdtemp(path.join(tmpdir(), 'fnd-companion-tls-'));
  const result = spawnSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes',
    '-keyout', path.join(directory, 'key.pem'), '-out', path.join(directory, 'cert.pem'), '-days', '1', '-subj', '/CN=fixture'], { stdio: 'ignore' });
  assert.equal(result.status, 0, 'generate ephemeral TLS test certificate');
  key = await readFile(path.join(directory, 'key.pem')); cert = await readFile(path.join(directory, 'cert.pem'));
  pin = createHash('sha256').update(new X509Certificate(cert).raw).digest('hex');
});
after(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

async function fixture(t, respond) {
  const sockets = new Set(); let received = 0;
  const server = createServer({ key, cert }, socket => {
    socket.on('error', () => {});
    let buffer = Buffer.alloc(0), answered = false;
    socket.on('data', data => {
      received += data.length; buffer = Buffer.concat([buffer, data]);
      const separator = buffer.indexOf('\r\n\r\n');
      if (separator < 0 || answered) return;
      const head = buffer.subarray(0, separator).toString(), length = Number(/Content-Length: (\d+)/i.exec(head)?.[1] ?? '0');
      if (buffer.length < separator + 4 + length) return;
      answered = true; respond(socket, head, buffer.subarray(separator + 4));
    });
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.on('tlsClientError', () => {});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  const pairing = { port: server.address().port, certificateSha256: pin, token };
  return { client: new AndroidCompanionFixtureClient(pairing), pairing, received: () => received };
}
function reply(socket, body, status = 200, headers = '') {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  socket.end(`HTTP/1.1 ${status} Result\r\nContent-Length: ${bytes.length}\r\nContent-Type: application/json\r\n${headers}\r\n` + bytes.toString());
}
const transportTest = (name, fn) => test(name, { skip: hasOpenSsl ? false : 'OpenSSL unavailable: TLS transport tests not run' }, fn);

test('Android pairing rejects invalid pin/token/port/config before connecting', () => {
  const valid = { port: 1234, certificateSha256: 'a'.repeat(64), token };
  for (const altered of [{ port: 0 }, { port: 65536 }, { port: 1.1 }, { certificateSha256: 'wrong' }, { token: `${token}\r\nX: y` }]) {
    assert.throws(() => new AndroidCompanionFixtureClient({ ...valid, ...altered }), /PAIRING_INVALID/);
  }
  assert.throws(() => new AndroidCompanionFixtureClient(valid, 'x\r\ny'), /PAIRING_INVALID/);
});

transportTest('Certificate mismatch sends zero auth or application bytes', async t => {
  const f = await fixture(t, socket => reply(socket, {}));
  const client = new AndroidCompanionFixtureClient({ ...f.pairing, certificateSha256: '0'.repeat(64) });
  await assert.rejects(client.capabilities(), /CERTIFICATE_MISMATCH/);
  assert.equal(f.received(), 0);
});

transportTest('Pinned fixture RPC lifecycle and scoped Range request', async t => {
  const methods = [];
  const f = await fixture(t, (socket, head, bytes) => {
    assert.match(head, new RegExp(`Authorization: Bearer ${token}`));
    if (head.startsWith('GET')) {
      assert.match(head, new RegExp(`/media/${resourceHandle} HTTP/1.1`));
      assert.match(head, new RegExp(`X-Companion-Session: ${sessionId}`));
      assert.match(head, /Range: bytes=4-7/);
      reply(socket, Buffer.from('WAVE'), 206, 'Content-Range: bytes 4-7/32044\r\n'); return;
    }
    const request = JSON.parse(bytes); methods.push(request.method);
    assert.equal(request.sourceId, 'android-builtin-tone'); assert.equal(request.profile, 'builtin-tone-v1');
    assert.equal(request.configRevision, 'fixture-1');
    if (request.method === 'init') reply(socket, { sessionId });
    else if (request.method === 'capabilities') reply(socket, { externalCode: false });
    else { assert.equal(request.sessionId, sessionId); reply(socket, request.method === 'play' ? { resourceHandle } : {}); }
  });
  assert.equal((await f.client.capabilities()).externalCode, false);
  await assert.rejects(f.client.call('home'), /SESSION_MISSING/);
  await f.client.init();
  for (const method of ['home', 'category', 'search', 'detail']) await f.client.call(method);
  const play = await f.client.call('play');
  const media = await f.client.media(play.resourceHandle, { start: 4, end: 7 });
  assert.equal(media.status, 206); assert.equal(media.body.toString(), 'WAVE');
  await assert.rejects(f.client.media('../escape'), /RESOURCE_INVALID/);
  await assert.rejects(f.client.media(resourceHandle, { start: 5, end: 4 }), /RANGE_INVALID/);
  await f.client.destroy(); await assert.rejects(f.client.call('home'), /SESSION_MISSING/);
  assert.deepEqual(methods, ['capabilities', 'init', 'home', 'category', 'search', 'detail', 'play', 'destroy']);
});

transportTest('Authentication denial and redirect never leak response detail or follow URLs', async t => {
  const f = await fixture(t, socket => reply(socket, { error: `private-detail-${token}` }, 401));
  await assert.rejects(f.client.capabilities(), error => error.message === 'ANDROID_RPC_REJECTED');
  const redirected = await fixture(t, socket => reply(socket, {}, 302, 'Location: https://example.invalid/\r\n'));
  await assert.rejects(redirected.client.capabilities(), /RPC_REJECTED/);
});

transportTest('Duplicate headers, transfer encoding and truncated body fail closed', async t => {
  for (const raw of [
    'Content-Length: 2\r\nContent-Length: 2\r\n\r\n{}',
    'Content-Length: 2\r\nTransfer-Encoding: chunked\r\n\r\n{}',
    'Content-Length: 20\r\n\r\n{}',
  ]) {
    const f = await fixture(t, socket => socket.end(`HTTP/1.1 200 OK\r\n${raw}`));
    await assert.rejects(f.client.capabilities(), /RESPONSE_INVALID/);
  }
});

transportTest('Oversized replies are bounded', async t => {
  const f = await fixture(t, socket => socket.end(Buffer.alloc(1024 * 1024 + 8193, 65)));
  await assert.rejects(f.client.capabilities(), /RESPONSE_LIMIT/);
});

transportTest('Abort and close cancel pending TLS calls without resurrecting sessions', async t => {
  let notify;
  const started = new Promise(resolve => { notify = resolve; });
  const f = await fixture(t, () => notify());
  const pending = f.client.init(); await started; f.client.close();
  await assert.rejects(pending, /REQUEST_CANCELLED/);
  await assert.rejects(f.client.call('home'), /SESSION_MISSING/);
  const controller = new AbortController();
  const request = f.client.capabilities(controller.signal); controller.abort();
  await assert.rejects(request, /REQUEST_CANCELLED/);
});

transportTest('Older destroy cleanup cannot abort a replacement init', async t => {
  let destroyed;
  const destroyStarted = new Promise(resolve => { destroyed = resolve; });
  const f = await fixture(t, (socket, head, body) => {
    const request = JSON.parse(body);
    if (request.method === 'destroy') { destroyed(); return; }
    reply(socket, request.method === 'init' ? { sessionId } : {});
  });
  await f.client.init();
  const previous = f.client.destroy();
  const rejected = assert.rejects(previous, /REQUEST_CANCELLED/);
  await destroyStarted;
  await f.client.init();
  await rejected;
  await f.client.call('home');
  f.client.close();
});

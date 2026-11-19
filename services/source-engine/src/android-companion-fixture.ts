import { createHash, timingSafeEqual } from 'node:crypto';
import { connect } from 'node:tls';

/** Explicit opt-in transport proof only. Not registered as a SourceAdapter. */
export interface CompanionPairing {
  port: number;
  certificateSha256: string;
  token: string;
}
export interface CompanionResponse {
  status: number;
  headers: Readonly<Record<string, string>>;
  body: Buffer;
}
const MAX_RESPONSE = 1024 * 1024;
const HANDLE = /^[A-Za-z0-9_-]{43}$/;

/** Uses only loopback, pins the certificate BEFORE sending credentials or payload.
 * No ambient proxy, redirects, certificate bypass flag, arbitrary URL or DNS lookup.
 * The self-signed certificate is authenticated by its out-of-band exact SHA-256 pin.
 */
export class AndroidCompanionFixtureClient {
  readonly #pairing: CompanionPairing;
  readonly #revision: string;
  #sessionId = '';
  #epoch = 0;
  #requests = new Set<AbortController>();
  constructor(pairing: CompanionPairing, configRevision = 'fixture-1') {
    if (!Number.isInteger(pairing.port) || pairing.port < 1 || pairing.port > 65535
      || !/^[a-f0-9]{64}$/.test(pairing.certificateSha256) || !HANDLE.test(pairing.token)
      || !/^[A-Za-z0-9._-]{1,64}$/.test(configRevision)) throw new Error('ANDROID_PAIRING_INVALID');
    this.#pairing = { ...pairing };
    this.#revision = configRevision;
  }

  async #request(path: string, payload: Buffer | undefined, headers: Record<string, string>, signal?: AbortSignal): Promise<CompanionResponse> {
    signal?.throwIfAborted();
    const controller = new AbortController();
    this.#requests.add(controller);
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    try {
      return await new Promise<CompanionResponse>((resolve, reject) => {
        // CA validation is replaced ONLY by the mandatory exact-certificate pin below.
        const socket = connect({ host: '127.0.0.1', port: this.#pairing.port, rejectUnauthorized: false, minVersion: 'TLSv1.2' });
        let settled = false;
        const chunks: Buffer[] = [];
        let size = 0;
        const finish = (error?: string, result?: CompanionResponse) => {
          if (settled) return;
          settled = true; clearTimeout(timer); controller.signal.removeEventListener('abort', cancelled); socket.destroy();
          if (error) reject(new Error(error)); else resolve(result!);
        };
        const cancelled = () => finish('ANDROID_REQUEST_CANCELLED');
        const timer = setTimeout(() => finish('ANDROID_REQUEST_TIMEOUT'), 5000);
        controller.signal.addEventListener('abort', cancelled, { once: true });
        socket.on('error', () => finish('ANDROID_TRANSPORT_FAILED'));
        socket.on('secureConnect', () => {
          const raw = socket.getPeerCertificate().raw;
          if (!raw || !timingSafeEqual(createHash('sha256').update(raw).digest(), Buffer.from(this.#pairing.certificateSha256, 'hex'))) {
            finish('ANDROID_CERTIFICATE_MISMATCH'); return;
          }
          const fields = { Host: 'localhost', Authorization: `Bearer ${this.#pairing.token}`, Connection: 'close', ...headers,
            ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': String(payload.length) } : {}) };
          socket.write(`${payload ? 'POST' : 'GET'} ${path} HTTP/1.1\r\n${Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`);
          if (payload) socket.write(payload);
        });
        socket.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_RESPONSE + 8192) { finish('ANDROID_RESPONSE_LIMIT'); return; }
          chunks.push(chunk);
        });
        socket.on('end', () => {
          try {
            const bytes = Buffer.concat(chunks), separator = bytes.indexOf('\r\n\r\n');
            if (separator < 0 || separator > 8192) throw new Error();
            const lines = bytes.subarray(0, separator).toString('ascii').split('\r\n');
            const status = /^HTTP\/1\.1 (\d{3}) [^\r\n]*$/.exec(lines.shift() ?? '');
            if (!status) throw new Error();
            const responseHeaders: Record<string, string> = Object.create(null) as Record<string, string>;
            for (const line of lines) {
              const colon = line.indexOf(':'), key = line.slice(0, colon).toLowerCase();
              if (colon < 1 || !/^[a-z0-9-]+$/.test(key) || key in responseHeaders) throw new Error();
              responseHeaders[key] = line.slice(colon + 1).trim();
            }
            const length = responseHeaders['content-length'] ?? '', body = bytes.subarray(separator + 4);
            if ('transfer-encoding' in responseHeaders || !/^\d{1,7}$/.test(length) || Number(length) !== body.length || body.length > MAX_RESPONSE) throw new Error();
            finish(undefined, { status: Number(status[1]), headers: responseHeaders, body });
          } catch { finish('ANDROID_RESPONSE_INVALID'); }
        });
        socket.on('close', () => { if (!settled) finish('ANDROID_TRANSPORT_CLOSED'); });
        if (controller.signal.aborted) cancelled();
      });
    } finally {
      signal?.removeEventListener('abort', abort);
      this.#requests.delete(controller);
    }
  }

  async #rpc(method: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const response = await this.#request('/rpc', Buffer.from(JSON.stringify({ method,
      sourceId: 'android-builtin-tone', profile: 'builtin-tone-v1', configRevision: this.#revision, sessionId: this.#sessionId })), {}, signal);
    if (response.status !== 200 || response.headers['content-type'] !== 'application/json') throw new Error('ANDROID_RPC_REJECTED');
    try {
      const body: unknown = JSON.parse(response.body.toString('utf8'));
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
      return body as Record<string, unknown>;
    } catch { throw new Error('ANDROID_RPC_INVALID'); }
  }

  capabilities(signal?: AbortSignal): Promise<Record<string, unknown>> { return this.#rpc('capabilities', signal); }
  async init(signal?: AbortSignal): Promise<void> {
    this.close();
    const epoch = this.#epoch;
    const response = await this.#rpc('init', signal);
    if (epoch !== this.#epoch) throw new Error('ANDROID_SESSION_SUPERSEDED');
    if (typeof response.sessionId !== 'string' || !HANDLE.test(response.sessionId)) throw new Error('ANDROID_SESSION_INVALID');
    this.#sessionId = response.sessionId;
  }
  call(method: 'home' | 'category' | 'search' | 'detail' | 'play', signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (!this.#sessionId) return Promise.reject(new Error('ANDROID_SESSION_MISSING'));
    return this.#rpc(method, signal);
  }
  media(handle: string, range?: { start: number; end?: number }, signal?: AbortSignal): Promise<CompanionResponse> {
    if (!this.#sessionId || !HANDLE.test(handle)) return Promise.reject(new Error('ANDROID_RESOURCE_INVALID'));
    if (range && (!Number.isSafeInteger(range.start) || range.start < 0 || range.start > 999999999
      || (range.end !== undefined && (!Number.isSafeInteger(range.end) || range.end < range.start || range.end > 999999999)))) {
      return Promise.reject(new Error('ANDROID_RANGE_INVALID'));
    }
    return this.#request(`/media/${handle}`, undefined, { 'X-Companion-Session': this.#sessionId,
      ...(range ? { Range: `bytes=${range.start}-${range.end ?? ''}` } : {}) }, signal);
  }
  async destroy(signal?: AbortSignal): Promise<void> {
    const epoch = this.#epoch;
    try { if (this.#sessionId) await this.#rpc('destroy', signal); }
    finally { if (epoch === this.#epoch) this.close(); }
  }
  /** Abort/disconnect is immediate locally; explicit destroy or the device lease TTL revokes remote handles. */
  close(): void {
    this.#epoch++; this.#sessionId = '';
    for (const request of this.#requests) request.abort();
    this.#requests.clear();
  }
}

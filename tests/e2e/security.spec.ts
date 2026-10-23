import { X509Certificate } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import tls from 'node:tls';
import { expect, test } from '@playwright/test';
import { WebSocket } from 'ws';
import type { AppSnapshot } from '../../src/shared/types';
import { launchTestApp, type TestApp } from './harness';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: Buffer | string;
  ca?: string | Buffer;
  rejectUnauthorized?: boolean;
  timeoutMs?: number;
  label?: string;
}

function request(target: string, options: RequestOptions = {}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const url = new URL(target);
    const transport = url.protocol === 'https:' ? https : http;
    const body = options.body === undefined ? null : Buffer.isBuffer(options.body) ? options.body : Buffer.from(options.body);
    const headers: Record<string, string> = { ...options.headers };
    if (body) headers['Content-Length'] = String(body.length);
    const req = transport.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: options.method ?? 'GET',
        headers,
        ca: options.ca,
        rejectUnauthorized: options.rejectUnauthorized ?? true,
        servername: isIP(url.hostname) ? undefined : url.hostname,
        checkServerIdentity: (_hostname, cert) => tls.checkServerIdentity(url.hostname, cert),
        agent: false,
        timeout: options.timeoutMs ?? 15_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      },
    );
    req.on('timeout', () => req.destroy(new Error(`${options.label ?? target} request timeout`)));
    req.on('error', reject);
    if (body) req.end(body);
    else req.end();
  });
}

function json(response: RawResponse): Record<string, unknown> {
  return JSON.parse(response.body.toString('utf8')) as Record<string, unknown>;
}

function sessionCookie(headers: http.IncomingHttpHeaders): string {
  const raw = Array.isArray(headers['set-cookie']) ? headers['set-cookie'][0] ?? '' : '';
  const match = /ep_session=([^;]+)/.exec(raw);
  return match?.[1] ?? '';
}

function pair(clientId: string, deviceName: string): Promise<RawResponse> {
  return (async () => {
    const code = (await app.snapshot()).connect.code;
    return request(`${origin}/api/pair/code`, {
      method: 'POST',
      ca,
      headers: { 'Content-Type': 'application/json', Origin: origin },
      body: JSON.stringify({ code, deviceName, clientId }),
    });
  })();
}

function tlsHandshake(port: number, caPem: string): Promise<{ cert: X509Certificate; protocol: string }> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: '127.0.0.1', port, ca: caPem, rejectUnauthorized: true }, () => {
      try {
        const peer = socket.getPeerCertificate();
        const cert = new X509Certificate(peer.raw);
        const protocol = socket.getProtocol() ?? '';
        socket.end();
        resolve({ cert, protocol });
      } catch (error) {
        socket.destroy();
        reject(error);
      }
    });
    socket.on('error', reject);
  });
}

function expectUnknownCa(port: number): Promise<NodeJS.ErrnoException> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: '127.0.0.1', port }, () => {
      socket.destroy();
      reject(new Error('TLS handshake unexpectedly succeeded with the public trust store'));
    });
    socket.on('error', (error) => resolve(error));
  });
}

function wsHandshake(url: string, headers: Record<string, string>): Promise<{ status: number; hello?: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { rejectUnauthorized: false, headers, handshakeTimeout: 10_000 });
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error(`WebSocket handshake timed out: ${url}`));
    }, 12_000);
    socket.on('unexpected-response', (_req, res) => {
      clearTimeout(timer);
      res.resume();
      socket.terminate();
      resolve({ status: res.statusCode ?? 0 });
    });
    socket.on('message', (data) => {
      clearTimeout(timer);
      socket.close();
      resolve({ status: 101, hello: JSON.parse(String(data)) as Record<string, unknown> });
    });
    socket.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

let app: TestApp;
let snapshot: AppSnapshot;
let origin: string;
let httpsPort: number;
let httpPort: number;
let ca: string;
let cookie: string;
let lanIp: string;
let mediaId: string;

test.describe.configure({ mode: 'serial' });

test.describe('transport and session security', () => {
  test.beforeAll(async () => {
    app = await launchTestApp();
    snapshot = await app.snapshot();
    httpPort = snapshot.server.httpPort;
    httpsPort = snapshot.server.httpsPort;
    expect(httpPort).toBeGreaterThan(0);
    expect(httpsPort).toBeGreaterThan(0);
    origin = `https://127.0.0.1:${httpsPort}`;
    expect(snapshot.server.httpsEnabled).toBe(true);

    const caResponse = await request(`${origin}/ca.crt`, { rejectUnauthorized: false });
    expect(caResponse.status).toBe(200);
    ca = caResponse.body.toString('utf8');
    expect(ca).toContain('BEGIN CERTIFICATE');

    const lan = snapshot.server.addresses.find((entry) => !entry.virtual) ?? snapshot.server.addresses[0];
    expect(lan, 'a LAN address is required for isolation checks').toBeDefined();
    lanIp = lan?.address ?? '';
    expect(lanIp).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    expect(lanIp.startsWith('127.')).toBe(false);
  });

  test.afterAll(async () => {
    await app?.close();
  });

  test('serves strict browser headers and a locally trusted certificate', async () => {
    const page = await request(`${origin}/`, { ca });
    expect(page.status).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.headers['x-content-type-options']).toBe('nosniff');
    expect(page.headers['x-frame-options']).toBe('DENY');
    expect(page.headers['referrer-policy']).toBe('no-referrer');
    expect(page.headers['cross-origin-opener-policy']).toBe('same-origin');
    expect(page.headers['cache-control']).toBe('no-store');
    expect(page.headers['strict-transport-security']).toBe('max-age=0');
    const csp = String(page.headers['content-security-policy'] ?? '');
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("connect-src 'self' ws: wss:");
    const policy = String(page.headers['permissions-policy'] ?? '');
    expect(policy).toContain('camera=(self)');
    expect(policy).toContain('display-capture=(self)');

    const api = await request(`${origin}/api/health`, { ca });
    expect(api.status).toBe(200);
    expect(api.headers['permissions-policy']).toBe('camera=(), microphone=(), display-capture=(), geolocation=()');

    const caFile = await request(`${origin}/ca.crt`, { ca });
    expect(caFile.headers['content-type']).toBe('application/x-x509-ca-cert');
    expect(String(caFile.headers['content-disposition'])).toContain('EasyPush-CA.crt');
    const caCert = new X509Certificate(caFile.body);
    expect(caCert.fingerprint256).toBe(snapshot.server.caFingerprint);
    expect(caCert.subject).toContain('EasyPush Local CA');
    expect(caCert.ca).toBe(true);

    const { cert, protocol } = await tlsHandshake(httpsPort, ca);
    expect(protocol).toMatch(/^TLSv1\.[23]$/);
    expect(cert.issuer).toContain('EasyPush Local CA');
    expect(cert.subjectAltName ?? '').toContain('127.0.0.1');
    expect(cert.subjectAltName ?? '').toContain(lanIp);
    const validityDays =
      (new Date(cert.validTo).getTime() - new Date(cert.validFrom).getTime()) / (24 * 60 * 60 * 1000);
    expect(validityDays).toBeGreaterThan(360);
    expect(validityDays).toBeLessThan(368);

    const rejected = await expectUnknownCa(httpsPort);
    expect(rejected.code ?? '').toMatch(/CERT|VERIFY|SELF_SIGNED|UNABLE_TO/);
  });

  test('issues an HttpOnly session only after an approved pairing', async () => {
    const anonymous = await request(`${origin}/api/me`, { ca });
    expect(anonymous.status).toBe(401);
    expect(json(anonymous)['error']).toMatchObject({ code: 'unauthorized' });

    await app.updateSettings({ autoApprove: true });
    const paired = await pair('e2esecurityprobe1', 'Security 探针');
    expect(paired.status).toBe(200);
    const rawCookie = Array.isArray(paired.headers['set-cookie']) ? paired.headers['set-cookie'][0] ?? '' : '';
    expect(rawCookie).toContain('ep_session=');
    expect(rawCookie).toContain('HttpOnly');
    expect(rawCookie).toContain('SameSite=Strict');
    expect(rawCookie).toContain('Secure');
    expect(rawCookie).toContain('Max-Age=2592000');
    cookie = sessionCookie(paired.headers);
    expect(cookie).toMatch(/^v1\./);

    const me = await request(`${origin}/api/me`, { ca, headers: { Cookie: `ep_session=${cookie}` } });
    expect(me.status).toBe(200);
    const body = json(me);
    expect(body['device']).toMatchObject({ name: 'Security 探针', remembered: false });
    expect(body['receiver']).toMatchObject({ secure: true });
    expect(body['limits']).toMatchObject({ maxUploadBytes: 2 * 1024 * 1024 * 1024 });

    const stale = await request(`${origin}/api/me`, { ca, headers: { Cookie: 'ep_session=v1.bogus' } });
    expect(stale.status).toBe(401);
  });

  test('rejects foreign hosts and cross-site requests', async () => {
    const badHost = await request(`${origin}/api/health`, { ca, headers: { Host: 'evil.example' } });
    expect(badHost.status).toBe(421);
    expect(json(badHost)['error']).toMatchObject({ code: 'bad-host' });

    const wrongOrigin = await request(`${origin}/api/pair/ticket`, {
      method: 'POST',
      ca,
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
      body: JSON.stringify({ ticket: 'x' }),
    });
    expect(wrongOrigin.status).toBe(403);
    expect(json(wrongOrigin)['error']).toMatchObject({ code: 'cross-origin' });

    const crossSite = await request(`${origin}/api/health`, { ca, headers: { 'Sec-Fetch-Site': 'cross-site' } });
    expect(crossSite.status).toBe(403);
    expect(json(crossSite)['error']).toMatchObject({ code: 'cross-origin' });

    const crossSiteUpload = await request(`${origin}/api/upload`, {
      method: 'POST',
      ca,
      headers: { Origin: 'https://evil.example', 'Content-Type': 'image/png' },
      body: PNG,
    });
    expect(crossSiteUpload.status).toBe(403);
  });

  test('enforces upload media type, emptiness, size and authentication', async () => {
    const unauthenticated = await request(`${origin}/api/upload`, {
      method: 'POST',
      ca,
      headers: { 'Content-Type': 'image/png', 'x-file-name': 'probe.png' },
      body: PNG,
      label: 'unauthenticated upload',
    });
    expect(unauthenticated.status).toBe(401);

    const headers = {
      Cookie: `ep_session=${cookie}`,
      'Content-Type': 'application/pdf',
      'x-file-name': 'report.pdf',
    };
    const unsupported = await request(`${origin}/api/upload`, {
      method: 'POST',
      ca,
      headers,
      body: Buffer.from('%PDF-1.4'),
      label: 'unsupported upload',
    });
    expect(unsupported.status).toBe(415);
    expect(json(unsupported)['error']).toMatchObject({ code: 'unsupported-media' });

    const empty = await request(`${origin}/api/upload`, {
      method: 'POST',
      ca,
      headers: { Cookie: `ep_session=${cookie}`, 'Content-Type': 'image/png', 'x-file-name': 'empty.png' },
      label: 'empty upload',
    });
    expect(empty.status).toBe(400);
    expect(json(empty)['error']).toMatchObject({ code: 'empty-upload' });

    const oversized = await request(`${origin}/api/upload`, {
      method: 'POST',
      ca,
      headers: {
        Cookie: `ep_session=${cookie}`,
        'Content-Type': 'image/png',
        'x-file-name': 'huge.png',
        'Content-Length': String(3 * 1024 * 1024 * 1024),
      },
      label: 'oversized upload',
    });
    expect(oversized.status).toBe(413);
    expect(json(oversized)['error']).toMatchObject({ code: 'too-large' });

    const accepted = await request(`${origin}/api/upload`, {
      method: 'POST',
      ca,
      headers: { Cookie: `ep_session=${cookie}`, 'Content-Type': 'image/png', 'x-file-name': 'security-probe.png' },
      body: PNG,
      label: 'accepted upload',
    });
    expect(accepted.status).toBe(201);
    const uploaded = json(accepted)['item'] as { id?: string; name?: string; kind?: string };
    expect(uploaded.name).toBe('security-probe.png');
    expect(uploaded.kind).toBe('image');
    mediaId = uploaded.id ?? '';
    expect(mediaId).toMatch(/^[a-zA-Z0-9_-]{8,64}$/);
  });

  test('keeps desktop and media paths loopback-only and blocks traversal', async () => {
    const lanPage = await request(`https://${lanIp}:${httpsPort}/`, { ca });
    expect(lanPage.status).toBe(200);

    const lanDesktop = await request(`https://${lanIp}:${httpsPort}/desktop`, { ca });
    expect(lanDesktop.status).toBe(403);
    expect(json(lanDesktop)['error']).toMatchObject({ code: 'loopback-only' });

    const lanMedia = await request(`https://${lanIp}:${httpsPort}/media/${mediaId}`, { ca });
    expect(lanMedia.status).toBe(403);
    expect(json(lanMedia)['error']).toMatchObject({ code: 'loopback-only' });

    const localMedia = await request(`${origin}/media/${mediaId}`, { ca });
    expect(localMedia.status).toBe(200);
    expect(localMedia.body.equals(PNG)).toBe(true);

    const range = await request(`${origin}/media/${mediaId}`, { ca, headers: { Range: 'bytes=0-7' } });
    expect(range.status).toBe(206);
    expect(range.body.equals(PNG.subarray(0, 8))).toBe(true);

    const traversal = await request(`${origin}/assets/..%2f..%2fpackage.json`, { ca });
    expect(traversal.status).toBe(403);
    expect(traversal.body.toString('utf8')).not.toContain('devDependencies');

    const desktopTraversal = await request(`${origin}/desktop/..%2f..%2fpackage.json`, { ca });
    expect(desktopTraversal.status).toBe(403);
    expect(desktopTraversal.body.toString('utf8')).not.toContain('devDependencies');

    const mediaTraversal = await request(`${origin}/media/..%2f..%2fpackage.json`, { ca });
    expect(mediaTraversal.status).toBe(404);
    expect(mediaTraversal.body.toString('utf8')).not.toContain('devDependencies');

    const httpHealth = await request(`http://127.0.0.1:${httpPort}/api/health`);
    expect(httpHealth.status).toBe(200);
    expect(httpHealth.headers['strict-transport-security']).toBeUndefined();
    expect(json(httpHealth)['secure']).toBe(false);
  });

  test('authenticates the live WebSocket and rejects foreign origins', async () => {
    const anonymous = await wsHandshake(`wss://127.0.0.1:${httpsPort}/ws`, {});
    expect(anonymous.status).toBe(401);

    const foreign = await wsHandshake(`wss://127.0.0.1:${httpsPort}/ws`, {
      Cookie: `ep_session=${cookie}`,
      Origin: 'https://evil.example',
    });
    expect(foreign.status).toBe(403);

    const authorized = await wsHandshake(`wss://127.0.0.1:${httpsPort}/ws`, {
      Cookie: `ep_session=${cookie}`,
      Origin: origin,
    });
    expect(authorized.status).toBe(101);
    expect(authorized.hello).toMatchObject({
      type: 'hello',
      protocolVersion: 1,
      deviceName: 'Security 探针',
      secure: true,
      state: 'idle',
    });
  });

  test('rate-limits repeated wrong pairing codes', async () => {
    const current = (await app.snapshot()).connect.code;
    const wrong = String((Number(current) + 1) % 1_000_000).padStart(6, '0');
    const statuses: number[] = [];
    for (let index = 0; index < 7; index += 1) {
      const attempt = await request(`${origin}/api/pair/code`, {
        method: 'POST',
        ca,
        headers: { 'Content-Type': 'application/json', Origin: origin },
        body: JSON.stringify({ code: wrong, deviceName: `Brute ${index}`, clientId: `bruteforce${String(index).padStart(4, '0')}` }),
      });
      statuses.push(attempt.status);
      if (attempt.status === 429) {
        expect(json(attempt)['error']).toMatchObject({ code: 'rate-limited' });
      }
    }
    expect(statuses.slice(0, 6)).toEqual([401, 401, 401, 401, 401, 401]);
    expect(statuses[6]).toBe(429);
    expect((await app.snapshot()).devices).toHaveLength(1);
  });
});

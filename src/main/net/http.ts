import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import https from 'node:https';
import type { Duplex } from 'node:stream';
import path from 'node:path';
import type { DeviceInfo, ServerHealth, ServerInfo, Settings } from '../../shared/types';
import { MAX_UPLOAD_BYTES, SESSION_COOKIE } from '../../shared/types';
import { isSafeRemoteUrl, kindFromNameOrMime } from '../../shared/protocol';
import { isAllowedHostHeader, isLoopbackAddress, normalizeRemoteAddress } from '../core/lan';
import type { Logger } from '../core/logger';
import { RateLimiter } from '../core/rateLimiter';
import type { CertManager } from '../core/certs';
import type { Store } from '../core/store';
import { toDeviceInfo, type PairingService } from '../services/pairing';
import type { MediaLibrary } from '../services/mediaLibrary';
import type { PresentationService } from '../services/presentation';
import { UploadError, normalizeMime, sanitizeFileName } from '../services/mediaLibrary';
import { PresentationError } from '../services/presentation';

export interface DlnaHttpHandler {
  handle(req: IncomingMessage, res: ServerResponse): boolean;
}

export interface HttpDeps {
  webDir: string;
  desktopDir: string;
  store: Store;
  logger: Logger;
  pairing: PairingService;
  media: MediaLibrary;
  presentation: PresentationService;
  certs: CertManager;
  getServerInfo(): ServerInfo;
  revokeDevice(deviceId: string): void;
  version: string;
  startedAt: number;
}

export interface Ports {
  http: number;
  https: number | null;
}

const WEB_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self' ws: wss:",
  "worker-src 'self' blob:",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ');

const DESKTOP_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: http: https:",
  "media-src 'self' blob: http: https:",
  "connect-src 'self' http: https:",
  "worker-src 'self' blob:",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.crt': 'application/x-x509-ca-cert',
  '.pem': 'application/x-pem-file',
};

export class HttpLayer {
  private httpServer: http.Server | null = null;
  private httpsServer: https.Server | null = null;
  private httpPort = 0;
  private httpsPort: number | null = null;
  private dlna: DlnaHttpHandler | null = null;
  private webDir: string;
  private desktopDir: string;
  private readonly uploadLimiter = new RateLimiter(30, 300_000);
  private readonly requestHandler = (req: IncomingMessage, res: ServerResponse) => {
    void this.handle(req, res).catch((error) => {
      this.deps.logger.error('http.unhandled', { error: String(error), url: req.url });
      if (!res.headersSent) this.sendJson(res, 500, { error: { code: 'internal', message: '服务器内部错误' } });
      else res.destroy();
    });
  };

  constructor(private readonly deps: HttpDeps) {
    this.webDir = deps.webDir;
    this.desktopDir = deps.desktopDir;
  }

  setStaticDirs(webDir: string, desktopDir: string): void {
    this.webDir = webDir;
    this.desktopDir = desktopDir;
  }

  setDlnaHandler(handler: DlnaHttpHandler): void {
    this.dlna = handler;
  }

  getPorts(): Ports {
    return { http: this.httpPort, https: this.httpsPort };
  }

  getHttpUrl(): string | null {
    return this.httpPort ? `http://127.0.0.1:${this.httpPort}` : null;
  }

  async start(preferredHttp: number, preferredHttps: number): Promise<Ports> {
    this.httpServer = http.createServer(this.requestHandler);
    this.httpServer.requestTimeout = 0;
    this.httpServer.headersTimeout = 30_000;
    this.httpServer.keepAliveTimeout = 65_000;
    this.httpPort = await this.listen(this.httpServer, preferredHttp);
    const options = this.deps.certs.httpsOptions();
    if (options) {
      try {
        this.httpsServer = https.createServer({ ...options, minVersion: 'TLSv1.2' }, this.requestHandler);
      } catch (error) {
        this.httpsServer = null;
        this.deps.logger.error('https.context_failed', { error: String(error) });
      }
      if (this.httpsServer) {
        this.httpsServer.requestTimeout = 0;
        this.httpsServer.headersTimeout = 30_000;
        this.httpsServer.keepAliveTimeout = 65_000;
        try {
          this.httpsPort = await this.listen(this.httpsServer, preferredHttps);
        } catch (error) {
          this.httpsPort = null;
          this.deps.logger.warn('https.start_failed', { error: String(error) });
        }
      }
    }
    this.deps.logger.info('http.started', { http: this.httpPort, https: this.httpsPort });
    return this.getPorts();
  }

  setHttpsContext(): void {
    if (!this.httpsServer) return;
    const options = this.deps.certs.httpsOptions();
    if (options) this.httpsServer.setSecureContext(options);
  }

  onUpgrade(handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => void): void {
    this.httpServer?.on('upgrade', handler);
    this.httpsServer?.on('upgrade', handler);
  }

  async stop(): Promise<void> {
    const closers: Promise<void>[] = [];
    for (const server of [this.httpServer, this.httpsServer]) {
      if (!server) continue;
      server.closeAllConnections();
      closers.push(
        new Promise((resolve) => {
          server.close(() => resolve());
          setTimeout(resolve, 1500).unref();
        }),
      );
    }
    await Promise.all(closers);
    this.httpServer = null;
    this.httpsServer = null;
    this.httpPort = 0;
    this.httpsPort = null;
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = Date.now();
    res.on('finish', () => {
      if (req.url?.startsWith('/api/')) {
        this.deps.logger.debug('http.request', {
          method: req.method,
          url: req.url?.split('?')[0],
          status: res.statusCode,
          ms: Date.now() - started,
        });
      }
    });

    applySecurityHeaders(res, req);
    if (!isAllowedHostHeader(req.headers.host)) {
      return this.sendJson(res, 421, { error: { code: 'bad-host', message: '无效的访问地址' } });
    }
    if (req.headers['sec-fetch-site'] === 'cross-site' && req.url?.startsWith('/api/')) {
      return this.sendJson(res, 403, { error: { code: 'cross-origin', message: '拒绝跨站请求' } });
    }

    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const pathname = decodeURIComponent(url.pathname);

    if (pathname.startsWith('/dlna/') && this.dlna?.handle(req, res)) return;

    if (req.method === 'GET' || req.method === 'HEAD') {
      if (pathname === '/api/health') return this.handleHealth(req, res);
      if (pathname === '/api/me') return this.handleMe(req, res);
      if (pathname === '/api/pair/status') return this.handlePairStatus(req, res, url);
      if (pathname === '/ca.crt' || pathname === '/EasyPush-CA.crt') return this.handleCa(req, res);
      if (pathname.startsWith('/media/')) return this.handleMedia(req, res, pathname);
      if (pathname.startsWith('/desktop')) return this.serveDesktop(req, res, pathname);
      if (pathname === '/' || pathname === '/setup' || pathname === '/index.html') return this.serveWeb(req, res, 'index.html');
      if (pathname === '/manifest.webmanifest' || pathname.startsWith('/assets/') || /^\/icon-\d+\.png$/.test(pathname) || pathname === '/favicon.svg') {
        return this.serveWeb(req, res, pathname.slice(1));
      }
    }

    if (req.method === 'POST') {
      if (pathname === '/api/pair/ticket') return this.handlePairTicket(req, res);
      if (pathname === '/api/pair/code') return this.handlePairCode(req, res);
      if (pathname === '/api/pair/resume') return this.handlePairResume(req, res);
      if (pathname === '/api/pair/signout') return this.handlePairSignout(req, res);
      if (pathname === '/api/upload') return this.handleUpload(req, res);
      if (pathname === '/api/cast/url') return this.handleCastUrl(req, res);
    }

    this.sendJson(res, 404, { error: { code: 'not-found', message: '未找到资源' } });
  }

  private async listen(server: http.Server | https.Server, preferred: number): Promise<number> {
    let lastError: unknown = null;
    for (let port = preferred; port < preferred + 10; port += 1) {
      try {
        await new Promise<void>((resolve, reject) => {
          const onError = (error: NodeJS.ErrnoException) => {
            server.off('listening', onListening);
            reject(error);
          };
          const onListening = () => {
            server.off('error', onError);
            resolve();
          };
          server.once('error', onError);
          server.once('listening', onListening);
          server.listen(port, '0.0.0.0');
        });
        return port;
      } catch (error) {
        lastError = error;
        if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
      }
    }
    throw lastError ?? new Error('no free port');
  }

  private handleHealth(req: IncomingMessage, res: ServerResponse): void {
    const settings = this.deps.store.get().settings;
    const health: ServerHealth = {
      ok: true,
      name: 'EasyPush',
      version: this.deps.version,
      protocolVersion: 1,
      deviceName: settings.deviceName,
      secure: Boolean((req.socket as { encrypted?: boolean }).encrypted),
      allowLive: settings.allowLive,
      allowDlna: settings.allowDlna,
      uptimeSec: Math.round((Date.now() - this.deps.startedAt) / 1000),
      httpPort: this.httpPort,
      httpsPort: this.httpsPort,
    };
    this.sendJson(res, 200, health);
  }

  private handleMe(req: IncomingMessage, res: ServerResponse): void {
    const device = this.authenticate(req);
    if (!device) return this.sendJson(res, 401, { error: { code: 'unauthorized', message: '请先配对' } });
    const settings = this.deps.store.get().settings;
    this.sendJson(res, 200, {
      device,
      receiver: {
        name: settings.deviceName,
        version: this.deps.version,
        secure: Boolean((req.socket as { encrypted?: boolean }).encrypted),
        allowLive: settings.allowLive,
      },
      limits: { maxUploadBytes: MAX_UPLOAD_BYTES },
    });
  }

  private async handlePairTicket(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!sameOrigin(req)) return this.sendJson(res, 403, { error: { code: 'cross-origin', message: '拒绝跨站请求' } });
    const body = await this.readJson(req, res, 16_384);
    if (!body) return;
    const outcome = await this.deps.pairing.beginTicket(this.pairInput(req, body), body['ticket']);
    if (outcome.token) this.setSessionCookie(req, res, outcome.token);
    this.sendJson(res, outcome.status, outcome.result);
  }

  private async handlePairCode(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!sameOrigin(req)) return this.sendJson(res, 403, { error: { code: 'cross-origin', message: '拒绝跨站请求' } });
    const body = await this.readJson(req, res, 16_384);
    if (!body) return;
    const outcome = await this.deps.pairing.beginCode(this.pairInput(req, body), body['code']);
    if (outcome.token) this.setSessionCookie(req, res, outcome.token);
    this.sendJson(res, outcome.status, outcome.result);
  }

  private async handlePairResume(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!sameOrigin(req)) return this.sendJson(res, 403, { error: { code: 'cross-origin', message: '拒绝跨站请求' } });
    const body = await this.readJson(req, res, 16_384);
    if (!body) return;
    const outcome = this.deps.pairing.resume(body['clientId'], body['deviceSecret'], this.remoteIp(req));
    if (outcome.token) this.setSessionCookie(req, res, outcome.token);
    this.sendJson(res, outcome.status, outcome.result);
  }

  private handlePairSignout(req: IncomingMessage, res: ServerResponse): void {
    if (!sameOrigin(req)) return this.sendJson(res, 403, { error: { code: 'cross-origin', message: '拒绝跨站请求' } });
    const device = this.authenticate(req);
    if (!device) return this.sendJson(res, 401, { error: { code: 'unauthorized', message: '请先配对' } });
    this.deps.revokeDevice(device.id);
    this.clearSessionCookie(req, res);
    this.deps.logger.info('pair.signed_out', { deviceId: device.id });
    this.sendJson(res, 200, { ok: true });
  }

  private handlePairStatus(req: IncomingMessage, res: ServerResponse, url: URL): void {
    const id = url.searchParams.get('id') ?? '';
    const outcome = this.deps.pairing.pollStatus(id, this.remoteIp(req));
    if (outcome.token) this.setSessionCookie(req, res, outcome.token);
    this.sendJson(res, 200, outcome.result);
  }

  private async handleUpload(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!sameOrigin(req)) return this.sendJson(res, 403, { error: { code: 'cross-origin', message: '拒绝跨站请求' } });
    const device = this.authenticate(req);
    if (!device) return this.sendJson(res, 401, { error: { code: 'unauthorized', message: '请先配对' } });
    const limit = this.uploadLimiter.hit(device.id);
    if (!limit.allowed) return this.sendJson(res, 429, { error: { code: 'rate-limited', message: '上传过于频繁，请稍后再试' } });
    const name = sanitizeFileName(String(req.headers['x-file-name'] ?? ''));
    const mime = normalizeMime(String(req.headers['content-type'] ?? ''), name);
    const sizeHeader = Number(req.headers['content-length']);
    const sizeHint = Number.isFinite(sizeHeader) && sizeHeader > 0 ? sizeHeader : null;
    try {
      const item = await this.deps.media.saveUpload(req, { name, mime, sizeHint, requestIp: this.remoteIp(req) });
      const append = req.headers['x-easypush-append'] === '1';
      const session = append
        ? this.deps.presentation.appendItems([item], 'upload', this.remoteIp(req))
        : this.deps.presentation.addItems([item], 'upload', this.remoteIp(req));
      this.sendJson(res, 201, {
        item,
        queued: this.deps.presentation.snapshot().presentation.mode === 'live',
        queueLength: session.items.length,
        appended: append,
      });
    } catch (error) {
      if (error instanceof UploadError) {
        return this.sendJson(res, error.status, { error: { code: error.code, message: error.message } });
      }
      throw error;
    }
  }

  private async handleCastUrl(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!sameOrigin(req)) return this.sendJson(res, 403, { error: { code: 'cross-origin', message: '拒绝跨站请求' } });
    const device = this.authenticate(req);
    if (!device) return this.sendJson(res, 401, { error: { code: 'unauthorized', message: '请先配对' } });
    const body = await this.readJson(req, res, 16_384);
    if (!body) return;
    const rawUrl = body['url'];
    if (typeof rawUrl !== 'string' || !isSafeRemoteUrl(rawUrl)) {
      return this.sendJson(res, 400, { error: { code: 'invalid-url', message: '请输入有效的 http/https 媒体地址' } });
    }
    const nameFromUrl = safeUrlName(rawUrl);
    const title = typeof body['title'] === 'string' ? body['title'].replace(/\p{Cc}/gu, '').slice(0, 120) : nameFromUrl;
    const mime = normalizeMime('', nameFromUrl || rawUrl);
    const item = this.deps.media.addRemoteItem({
      url: rawUrl,
      title: title || nameFromUrl || '网络媒体',
      mime,
      kind: kindFromNameOrMime(nameFromUrl || rawUrl, mime),
      source: 'url',
      sourceLabel: this.remoteIp(req),
      durationSec: null,
    });
    try {
      const session = this.deps.presentation.addItems([item], 'url', this.remoteIp(req));
      this.sendJson(res, 201, {
        item,
        queued: this.deps.presentation.snapshot().presentation.mode === 'live',
        queueLength: session.items.length,
        appended: false,
      });
    } catch (error) {
      if (error instanceof PresentationError) {
        return this.sendJson(res, error.code === 'busy' ? 409 : 400, { error: { code: error.code, message: error.message } });
      }
      throw error;
    }
  }

  private handleCa(req: IncomingMessage, res: ServerResponse): void {
    const pem = this.deps.certs.getCaPem();
    if (!pem) return this.sendJson(res, 404, { error: { code: 'no-ca', message: '证书尚未生成' } });
    const body = Buffer.from(pem, 'utf8');
    res.writeHead(200, {
      'Content-Type': 'application/x-x509-ca-cert',
      'Content-Length': body.length,
      'Content-Disposition': 'attachment; filename="EasyPush-CA.crt"',
      'Cache-Control': 'no-cache',
    });
    if (req.method === 'HEAD') res.end();
    else res.end(body);
  }

  private async handleMedia(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
    if (!isLoopbackAddress(req.socket.remoteAddress)) {
      return this.sendJson(res, 403, { error: { code: 'loopback-only', message: '媒体文件仅限本机访问' } });
    }
    const id = pathname.slice('/media/'.length);
    if (!/^[a-zA-Z0-9_-]{8,64}$/.test(id)) return this.sendJson(res, 404, { error: { code: 'not-found', message: '媒体不存在' } });
    const entry = this.deps.media.resolve(id);
    if (!entry) return this.sendJson(res, 404, { error: { code: 'not-found', message: '媒体不存在' } });
    await serveFile(req, res, entry.filePath, entry.mime, Number(entry.size), 'private, max-age=600');
  }

  private async serveWeb(req: IncomingMessage, res: ServerResponse, relative: string): Promise<void> {
    await this.serveStatic(req, res, this.webDir, relative, WEB_CSP, true);
  }

  private async serveDesktop(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
    if (!isLoopbackAddress(req.socket.remoteAddress)) {
      return this.sendJson(res, 403, { error: { code: 'loopback-only', message: '仅限本机访问' } });
    }
    const relative = pathname === '/desktop' || pathname === '/desktop/' ? 'index.html' : pathname.slice('/desktop/'.length);
    await this.serveStatic(req, res, this.desktopDir, relative, DESKTOP_CSP, false);
  }

  private async serveStatic(
    req: IncomingMessage,
    res: ServerResponse,
    root: string,
    relative: string,
    csp: string,
    allowFallback: boolean,
  ): Promise<void> {
    const safeRoot = path.resolve(root);
    let filePath = path.resolve(safeRoot, relative);
    if (!filePath.startsWith(safeRoot + path.sep) && filePath !== safeRoot) {
      return this.sendJson(res, 403, { error: { code: 'forbidden', message: '禁止访问' } });
    }
    let info = await stat(filePath).catch(() => null);
    if ((!info || !info.isFile()) && allowFallback) {
      filePath = path.join(safeRoot, 'index.html');
      info = await stat(filePath).catch(() => null);
    }
    if (!info?.isFile()) return this.sendJson(res, 404, { error: { code: 'not-found', message: '资源不存在' } });
    const ext = path.extname(filePath).toLowerCase();
    const mime = MIME[ext] ?? 'application/octet-stream';
    if (ext === '.html') {
      res.setHeader('Content-Security-Policy', csp);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Permissions-Policy', csp === WEB_CSP ? 'camera=(self), microphone=(self), display-capture=(self), fullscreen=(self)' : 'camera=(), microphone=(), display-capture=(), fullscreen=(self)');
    } else {
      res.setHeader('Cache-Control', relative.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'public, max-age=3600');
    }
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Length', info.size);
    if (req.method === 'HEAD') {
      res.writeHead(200);
      res.end();
      return;
    }
    res.writeHead(200);
    const stream = createReadStream(filePath);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  }

  private readJson(req: IncomingMessage, res: ServerResponse, limit: number): Promise<Record<string, unknown> | null> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value: Record<string, unknown> | null) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const type = String(req.headers['content-type'] ?? '');
      if (!type.toLowerCase().startsWith('application/json')) {
        req.resume();
        this.sendJson(res, 415, { error: { code: 'invalid-content-type', message: '需要 JSON 请求体' } });
        finish(null);
        return;
      }
      const declared = Number(req.headers['content-length']);
      if (Number.isFinite(declared) && declared > limit) {
        req.resume();
        this.sendJson(res, 413, { error: { code: 'payload-too-large', message: '请求内容过大' } });
        finish(null);
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (chunk: Buffer) => {
        if (settled) return;
        size += chunk.length;
        if (size > limit) {
          chunks.length = 0;
          req.resume();
          this.sendJson(res, 413, { error: { code: 'payload-too-large', message: '请求内容过大' } });
          finish(null);
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (settled) return;
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
          if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
            finish(parsed as Record<string, unknown>);
            return;
          }
        } catch {
          // handled below
        }
        this.sendJson(res, 400, { error: { code: 'invalid-json', message: '请求内容不是有效的 JSON 对象' } });
        finish(null);
      });
      req.on('error', () => finish(null));
    });
  }

  private pairInput(req: IncomingMessage, body: Record<string, unknown>) {
    return {
      deviceName: body['deviceName'],
      clientId: body['clientId'],
      ip: this.remoteIp(req),
      userAgent: String(req.headers['user-agent'] ?? ''),
    };
  }

  private authenticate(req: IncomingMessage): DeviceInfo | null {
    const cookies = parseCookies(req.headers.cookie);
    const device = this.deps.pairing.verifyToken(cookies[SESSION_COOKIE]);
    return device ? toDeviceInfo(device) : null;
  }

  private remoteIp(req: IncomingMessage): string {
    return normalizeRemoteAddress(req.socket.remoteAddress);
  }

  private setSessionCookie(req: IncomingMessage, res: ServerResponse, token: string): void {
    const secure = Boolean((req.socket as { encrypted?: boolean }).encrypted);
    const parts = [
      `${SESSION_COOKIE}=${token}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Strict',
      'Max-Age=2592000',
    ];
    if (secure) parts.push('Secure');
    res.setHeader('Set-Cookie', parts.join('; '));
  }

  private clearSessionCookie(req: IncomingMessage, res: ServerResponse): void {
    const parts = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
    if ((req.socket as { encrypted?: boolean }).encrypted) parts.push('Secure');
    res.setHeader('Set-Cookie', parts.join('; '));
  }

  private sendJson(res: ServerResponse, status: number, body: unknown): void {
    if (res.headersSent) return;
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': payload.length,
      'Cache-Control': 'no-store',
    });
    res.end(payload);
  }
}

export function applySecurityHeaders(res: ServerResponse, req: IncomingMessage): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), display-capture=(), geolocation=()');
  if ((req.socket as { encrypted?: boolean }).encrypted) {
    res.setHeader('Strict-Transport-Security', 'max-age=0');
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}

function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    const host = req.headers.host;
    return parsed.host.toLowerCase() === String(host ?? '').toLowerCase();
  } catch {
    return false;
  }
}

export async function serveFile(
  req: IncomingMessage,
  res: ServerResponse,
  filePath: string,
  mime: string,
  size: number,
  cacheControl: string,
): Promise<void> {
  let info = null;
  if (!size) {
    info = await stat(filePath).catch(() => null);
    if (!info || !info.isFile()) throw new Error('file not found');
    size = info.size;
  }
  const range = parseRange(req.headers.range, size);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', mime);
  res.setHeader('Cache-Control', cacheControl);
  if (range === 'invalid') {
    res.writeHead(416, { 'Content-Range': `bytes */${size}` });
    res.end();
    return;
  }
  if (!range) {
    res.writeHead(200, { 'Content-Length': size });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    const stream = createReadStream(filePath);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
    return;
  }
  const { start, end } = range;
  res.writeHead(206, {
    'Content-Range': `bytes ${start}-${end}/${size}`,
    'Content-Length': end - start + 1,
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  const stream = createReadStream(filePath, { start, end });
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

export function parseRange(header: string | undefined, size: number): { start: number; end: number } | null | 'invalid' {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return 'invalid';
  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) return 'invalid';
  if (!rawStart) {
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return 'invalid';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(rawStart);
  const end = rawEnd ? Number(rawEnd) : size - 1;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return 'invalid';
  return { start, end: Math.min(end, size - 1) };
}

function safeUrlName(raw: string): string {
  try {
    const url = new URL(raw);
    const name = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() ?? '');
    return name.slice(0, 120) || url.hostname;
  } catch {
    return '';
  }
}

export function pickSettingsForClient(settings: Settings): Pick<Settings, 'deviceName' | 'allowLive' | 'allowDlna'> {
  return { deviceName: settings.deviceName, allowLive: settings.allowLive, allowDlna: settings.allowDlna };
}

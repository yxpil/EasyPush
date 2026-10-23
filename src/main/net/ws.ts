import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import type { ServerMessage } from '../../shared/types';
import { PROTOCOL_VERSION, SESSION_COOKIE } from '../../shared/types';
import { parseClientMessage } from '../../shared/protocol';
import { isAllowedHostHeader, normalizeRemoteAddress } from '../core/lan';
import type { Logger } from '../core/logger';
import { RateLimiter } from '../core/rateLimiter';
import type { PairingService } from '../services/pairing';
import type { LiveService, LiveSocket } from '../services/live';
import type { HttpLayer } from './http';
import { parseCookies } from './http';

const MAX_PAYLOAD = 512 * 1024;
const HEARTBEAT_MS = 30_000;
const MESSAGE_LIMIT = new RateLimiter(180, 10_000);

export interface WsDeps {
  pairing: PairingService;
  live: LiveService;
  logger: Logger;
}

export class WsHub {
  private readonly server: WebSocketServer;
  private heartbeat: NodeJS.Timeout | null = null;
  private readonly alive = new WeakMap<WebSocket, boolean>();

  constructor(private readonly deps: WsDeps) {
    this.server = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD, perMessageDeflate: false, clientTracking: true });
  }

  attach(http: HttpLayer): void {
    http.onUpgrade((req, socket, head) => this.handleUpgrade(req, socket, head));
    if (!this.heartbeat) {
      this.heartbeat = setInterval(() => this.sweep(), HEARTBEAT_MS);
      this.heartbeat.unref();
    }
  }

  shutdown(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    for (const client of this.server.clients) client.terminate();
    this.server.close();
  }

  private handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    let pathname = '';
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch {
      return reject(socket, 400, 'Bad Request');
    }
    if (pathname !== '/ws') return reject(socket, 404, 'Not Found');
    if (!isAllowedHostHeader(req.headers.host)) return reject(socket, 421, 'Misdirected Request');
    if (!sameOrigin(req)) return reject(socket, 403, 'Forbidden');

    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    const device = this.deps.pairing.verifyToken(token);
    if (!device) return reject(socket, 401, 'Unauthorized');

    this.server.handleUpgrade(req, socket, head, (ws) => {
      this.accept(ws, req);
    });
  }

  private sweep(): void {
    for (const client of this.server.clients) {
      if (this.alive.get(client) === false) {
        client.terminate();
        continue;
      }
      this.alive.set(client, false);
      try {
        client.ping();
      } catch {
        client.terminate();
      }
    }
  }

  private accept(ws: WebSocket, req: IncomingMessage): void {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    const device = this.deps.pairing.verifyToken(token);
    if (!device) {
      ws.close(4401, 'unauthorized');
      return;
    }
    const ip = normalizeRemoteAddress(req.socket.remoteAddress);
    const secure = Boolean((req.socket as { encrypted?: boolean }).encrypted);
    this.alive.set(ws, true);

    const state = this.deps.live.getSession();
    const sessionId = state && state.deviceId === device.id ? state.id : null;

    const socket: LiveSocket = {
      send: (message: ServerMessage) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
      },
      close: (reason: string) => {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close(1000, reason.slice(0, 120));
        }
      },
    };

    const conn = this.deps.live.attach(device, ip, socket);
    this.deps.logger.info('ws.connected', { deviceId: device.id, ip, secure });

    socket.send({
      type: 'hello',
      protocolVersion: PROTOCOL_VERSION,
      receiverName: this.deps.pairing.settings().deviceName,
      deviceName: device.name,
      sessionId,
      state: state && state.deviceId === device.id ? state.state : 'idle',
      secure,
    });

    ws.on('pong', () => this.alive.set(ws, true));
    ws.on('message', (data) => {
      this.alive.set(ws, true);
      if (!MESSAGE_LIMIT.hit(device.id).allowed) {
        socket.send({ type: 'error', code: 'rate-limited', message: '消息过于频繁' });
        ws.close(1008, 'rate limited');
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(data));
      } catch {
        socket.send({ type: 'error', code: 'invalid-json', message: '消息格式错误' });
        return;
      }
      const result = parseClientMessage(parsed);
      if (!result.ok) {
        socket.send({ type: 'error', code: 'invalid-message', message: result.error });
        return;
      }
      this.deps.live.onMessage(conn, result.value);
    });
    ws.on('close', (code, reason) => {
      this.deps.logger.info('ws.closed', { deviceId: device.id, code, reason: reason.toString().slice(0, 80) });
      this.deps.live.onClose(conn);
    });
    ws.on('error', (error) => {
      this.deps.logger.warn('ws.error', { deviceId: device.id, error: String(error) });
    });
  }
}

function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host.toLowerCase() === String(req.headers.host ?? '').toLowerCase();
  } catch {
    return false;
  }
}

function reject(socket: Duplex, status: number, message: string): void {
  if (socket.writable) {
    socket.write(
      `HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`,
    );
  }
  socket.destroy();
}

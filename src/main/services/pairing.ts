import { createHmac, timingSafeEqual } from 'node:crypto';
import QRCode from 'qrcode';
import type {
  ConnectInfo,
  DeviceInfo,
  PairingRequest,
  PairStartResponse,
  PairStatusResponse,
  Platform,
  Settings,
} from '../../shared/types';
import { defaultDeviceName, platformFromUserAgent, sanitizeDeviceName } from '../../shared/protocol';
import {
  PAIR_CODE_TTL_MS,
  PAIR_REQUEST_TTL_MS,
  PAIR_TICKET_TTL_MS,
  SESSION_TTL_MS,
} from '../core/config';
import { randomDigits, randomId, randomToken } from '../core/ids';
import type { Logger } from '../core/logger';
import { RateLimiter } from '../core/rateLimiter';
import type { DeviceRecord, Store } from '../core/store';

interface TicketState {
  ticket: string;
  ticketExpiresAt: number;
  code: string;
  codeExpiresAt: number;
}

interface PairingRecord {
  request: PairingRequest;
  clientId: string;
  userAgent: string;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  token: string | null;
  device: DeviceRecord | null;
  deviceSecret: string | null;
  secretDelivered: boolean;
  cleanupAt: number;
}

export interface PairingEvents {
  changed(): void;
  request(request: PairingRequest): void;
  resolved(request: PairingRequest, approved: boolean): void;
}

export interface PairingInput {
  deviceName: unknown;
  clientId: unknown;
  ip: string;
  userAgent: string;
}

export interface PairOutcome {
  result: PairStartResponse;
  token: string | null;
  status: number;
}

export interface PairStatusOutcome {
  result: PairStatusResponse;
  token: string | null;
}

export class PairingService {
  private state: TicketState;
  private readonly requests = new Map<string, PairingRecord>();
  private readonly ticketAttempts = new RateLimiter(12, 60_000);
  private readonly codeAttempts = new RateLimiter(6, 300_000);
  private readonly codeGlobal = new RateLimiter(30, 600_000);
  private readonly resumeAttempts = new RateLimiter(12, 300_000);
  private sweepTimer: NodeJS.Timeout | null = null;
  private connectCache: ConnectInfo | null = null;
  private connectKey = '';

  constructor(
    private readonly store: Store,
    private readonly logger: Logger,
    private readonly events: PairingEvents,
    private readonly getUrls: () => { http: string | null; https: string | null; ca: string | null },
    private readonly clock: () => number = Date.now,
  ) {
    this.state = this.newTicket();
  }

  start(): void {
    this.pruneDevices();
    this.sweepTimer = setInterval(() => this.sweep(), 5000);
    this.sweepTimer.unref();
  }

  stop(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    for (const record of this.requests.values()) record.cleanupAt = this.clock();
    this.requests.clear();
  }

  settings(): Settings {
    return this.store.get().settings;
  }

  currentTicket(): string {
    this.ensureFresh();
    return this.state.ticket;
  }

  currentCode(): string {
    this.ensureFresh();
    return this.state.code;
  }

  getCachedConnect(): ConnectInfo | null {
    return this.connectCache;
  }

  async refreshConnect(): Promise<ConnectInfo> {
    this.ensureFresh();
    const urls = this.getUrls();
    const key = `${this.state.ticket}|${this.state.code}|${urls.http}|${urls.https}|${urls.ca}`;
    if (this.connectCache && this.connectKey === key) return this.connectCache;
    const ticketParam = encodeURIComponent(this.state.ticket);
    const qrDataUrl = urls.http ? await this.renderQr(`${urls.http}/#t=${ticketParam}`) : null;
    const qrSecureDataUrl = urls.https ? await this.renderQr(`${urls.https}/#t=${ticketParam}`) : null;
    this.connectCache = {
      ticket: this.state.ticket,
      ticketExpiresAt: this.state.ticketExpiresAt,
      code: this.state.code,
      codeExpiresAt: this.state.codeExpiresAt,
      httpUrl: urls.http,
      httpsUrl: urls.https,
      qrDataUrl,
      qrSecureDataUrl,
      caUrl: urls.ca,
      autoApprove: this.settings().autoApprove,
    };
    this.connectKey = key;
    return this.connectCache;
  }

  async beginTicket(input: PairingInput, ticket: unknown): Promise<PairOutcome> {
    const limit = this.ticketAttempts.hit(input.ip);
    if (!limit.allowed) return this.failure(429, 'rate-limited', '尝试次数过多，请稍后再试');
    this.ensureFresh();
    if (typeof ticket !== 'string' || !safeEqual(ticket, this.state.ticket)) {
      this.logger.warn('pair.ticket_invalid', { ip: input.ip });
      return this.failure(401, 'invalid-ticket', '二维码已更新，请扫描电脑上最新的二维码或使用配对码');
    }
    this.rotateTicket();
    this.events.changed();
    return this.begin(input, 'ticket');
  }

  async beginCode(input: PairingInput, code: unknown): Promise<PairOutcome> {
    const ipLimit = this.codeAttempts.hit(input.ip);
    const globalLimit = this.codeGlobal.hit('global');
    if (!ipLimit.allowed || !globalLimit.allowed) {
      return this.failure(429, 'rate-limited', '配对码尝试次数过多，请稍后再试');
    }
    this.ensureFresh();
    const normalized = typeof code === 'string' ? code.replace(/\D/g, '') : '';
    if (!normalized || !safeEqual(normalized, this.state.code)) {
      this.logger.warn('pair.code_invalid', { ip: input.ip });
      return this.failure(401, 'invalid-code', '配对码不正确，请查看电脑屏幕上显示的 6 位数字');
    }
    this.codeAttempts.reset(input.ip);
    return this.begin(input, 'code');
  }

  decide(requestId: string, approve: boolean, remember: boolean): PairingRequest | null {
    const record = this.requests.get(requestId);
    if (!record || record.status !== 'pending') return null;
    if (record.request.expiresAt < this.clock()) {
      this.markExpired(record);
      return null;
    }
    if (!approve) {
      record.status = 'denied';
      record.cleanupAt = this.clock() + 120_000;
      this.logger.info('pair.denied', { requestId, ip: record.request.ip });
      this.events.resolved(record.request, false);
      this.events.changed();
      return record.request;
    }
    const secret = this.approve(record, remember);
    this.logger.info('pair.approved', {
      requestId,
      deviceId: record.device?.id,
      remembered: remember,
      secret: secret ? 'issued' : 'none',
    });
    this.events.resolved(record.request, true);
    this.events.changed();
    return record.request;
  }

  pollStatus(requestId: string, requestIp: string): PairStatusOutcome {
    const record = this.requests.get(requestId);
    if (!record || (record.request.ip !== requestIp && record.request.ip !== 'unknown')) {
      return { result: { status: 'expired', error: { code: 'expired', message: '配对请求不存在或已过期' } }, token: null };
    }
    if (record.status === 'pending' && record.request.expiresAt < this.clock()) {
      this.markExpired(record);
    }
    const base: PairStatusResponse = {
      status: record.status,
      expiresAt: record.request.expiresAt,
    };
    if (record.status === 'approved' && record.device) {
      if (record.deviceSecret && !record.secretDelivered) {
        base.deviceSecret = record.deviceSecret;
        record.secretDelivered = true;
      }
      base.device = toDeviceInfo(record.device);
      return { result: base, token: record.token };
    }
    return { result: base, token: null };
  }

  verifyToken(token: string | undefined | null): DeviceRecord | null {
    if (!token) return null;
    const parts = token.split('.');
    if (parts.length !== 5 || parts[0] !== 'v1') return null;
    const [, deviceId, expRaw, nonce, signature] = parts;
    if (!deviceId || !expRaw || !nonce || !signature) return null;
    const exp = Number(expRaw);
    if (!Number.isFinite(exp) || exp < this.clock()) return null;
    const expected = this.sign(`v1.${deviceId}.${expRaw}.${nonce}`);
    if (!safeEqual(signature, expected)) return null;
    const device = this.store.get().devices.find((entry) => entry.id === deviceId);
    if (!device || device.blocked) return null;
    if (this.clock() - device.lastSeenAt > 60_000) {
      this.store.update((state) => {
        const target = state.devices.find((entry) => entry.id === deviceId);
        if (target) target.lastSeenAt = this.clock();
      });
    }
    return device;
  }

  newToken(deviceId: string): string {
    const exp = this.clock() + SESSION_TTL_MS;
    const nonce = randomToken(9);
    const payload = `v1.${deviceId}.${exp}.${nonce}`;
    return `${payload}.${this.sign(payload)}`;
  }

  resume(clientId: unknown, secret: unknown, ip: string): PairOutcome {
    const limit = this.resumeAttempts.hit(ip);
    if (!limit.allowed) return this.failure(429, 'rate-limited', '尝试次数过多，请稍后再试');
    if (typeof clientId !== 'string' || typeof secret !== 'string' || secret.length < 20) {
      return this.failure(400, 'invalid-request', '无效的设备凭据');
    }
    const device = this.store.get().devices.find((entry) => entry.id === clientId);
    if (!device || device.blocked || !device.credentialHash) {
      return this.failure(401, 'unauthorized', '设备凭据已失效');
    }
    const hash = this.hashCredential(secret);
    if (!safeEqual(hash, device.credentialHash)) {
      this.logger.warn('pair.resume_invalid', { ip });
      return this.failure(401, 'unauthorized', '设备凭据已失效');
    }
    const token = this.newToken(device.id);
    device.lastSeenAt = this.clock();
    device.ip = ip;
    this.store.addDevice(device);
    this.logger.info('pair.resumed', { deviceId: device.id });
    this.events.changed();
    return {
      result: { status: 'approved', device: toDeviceInfo(device), deviceSecret: null },
      token,
      status: 200,
    };
  }

  listDevices(): DeviceInfo[] {
    return [...this.store.get().devices].sort((a, b) => b.lastSeenAt - a.lastSeenAt).map(toDeviceInfo);
  }

  getDevice(deviceId: string): DeviceInfo | null {
    const device = this.store.get().devices.find((entry) => entry.id === deviceId);
    return device ? toDeviceInfo(device) : null;
  }

  revokeDevice(deviceId: string): boolean {
    const exists = this.store.get().devices.some((entry) => entry.id === deviceId);
    if (!exists) return false;
    this.store.update((state) => {
      state.devices = state.devices.filter((entry) => entry.id !== deviceId);
    });
    this.logger.info('device.revoked', { deviceId });
    this.events.changed();
    return true;
  }

  pendingRequest(): PairingRequest | null {
    for (const record of this.requests.values()) {
      if (record.status === 'pending' && record.request.expiresAt > this.clock()) return record.request;
    }
    return null;
  }

  private begin(input: PairingInput, method: 'ticket' | 'code'): PairOutcome {
    const ua = input.userAgent;
    const platform = platformFromUserAgent(ua);
    const clientId = typeof input.clientId === 'string' && /^[a-zA-Z0-9_-]{12,64}$/.test(input.clientId) ? input.clientId : null;
    const existing = clientId ? this.store.get().devices.find((entry) => entry.id === clientId) : null;
    if (existing?.blocked) return this.failure(403, 'rejected', '此设备已被禁用');
    const request: PairingRequest = {
      id: randomId(16),
      method,
      deviceName: sanitizeDeviceName(input.deviceName, ua),
      platform,
      ip: input.ip,
      createdAt: this.clock(),
      expiresAt: this.clock() + PAIR_REQUEST_TTL_MS,
    };
    const auto = this.settings().autoApprove;
    const record: PairingRecord = {
      request,
      clientId: clientId ?? randomId(16),
      userAgent: ua,
      status: auto ? 'approved' : 'pending',
      token: null,
      device: null,
      deviceSecret: null,
      secretDelivered: false,
      cleanupAt: 0,
    };
    if (auto) {
      this.approve(record, false);
      this.logger.info('pair.auto_approved', { ip: request.ip, platform });
      this.events.changed();
      return {
        result: {
          status: 'approved',
          device: record.device ? toDeviceInfo(record.device) : undefined,
          deviceSecret: record.deviceSecret,
        },
        token: record.token,
        status: 200,
      };
    }
    this.requests.set(request.id, record);
    record.cleanupAt = request.expiresAt + 120_000;
    this.logger.info('pair.requested', { requestId: request.id, ip: request.ip, platform, method });
    this.events.request(request);
    this.events.changed();
    return { result: { status: 'pending', requestId: request.id }, token: null, status: 202 };
  }

  private approve(record: PairingRecord, remember: boolean): string | null {
    const now = this.clock();
    const existing = this.store.get().devices.find((entry) => entry.id === record.clientId);
    const secret = remember ? randomToken(32) : null;
    const device: DeviceRecord = existing ?? {
      id: record.clientId,
      name: record.request.deviceName,
      platform: record.request.platform,
      userAgent: record.userAgent,
      ip: record.request.ip,
      firstSeenAt: now,
      lastSeenAt: now,
      remembered: remember,
      blocked: false,
      credentialHash: null,
    };
    device.name = record.request.deviceName;
    device.platform = record.request.platform;
    device.userAgent = record.userAgent;
    device.ip = record.request.ip;
    device.lastSeenAt = now;
    device.remembered = remember;
    if (secret) device.credentialHash = this.hashCredential(secret);
    this.store.addDevice(device);
    record.status = 'approved';
    record.device = device;
    record.token = this.newToken(device.id);
    record.deviceSecret = secret;
    record.cleanupAt = now + 120_000;
    return secret;
  }

  private markExpired(record: PairingRecord): void {
    if (record.status !== 'pending') return;
    record.status = 'expired';
    record.cleanupAt = this.clock() + 120_000;
    this.logger.info('pair.expired', { requestId: record.request.id });
    this.events.changed();
  }

  private ensureFresh(): void {
    const now = this.clock();
    let changed = false;
    if (now > this.state.ticketExpiresAt) {
      this.state.ticket = randomToken(24);
      this.state.ticketExpiresAt = now + PAIR_TICKET_TTL_MS;
      changed = true;
    }
    if (now > this.state.codeExpiresAt) {
      this.state.code = randomDigits(6);
      this.state.codeExpiresAt = now + PAIR_CODE_TTL_MS;
      changed = true;
    }
    if (changed) this.events.changed();
  }

  private rotateTicket(): void {
    const now = this.clock();
    this.state.ticket = randomToken(24);
    this.state.ticketExpiresAt = now + PAIR_TICKET_TTL_MS;
  }

  private newTicket(): TicketState {
    const now = this.clock();
    return {
      ticket: randomToken(24),
      ticketExpiresAt: now + PAIR_TICKET_TTL_MS,
      code: randomDigits(6),
      codeExpiresAt: now + PAIR_CODE_TTL_MS,
    };
  }

  private sweep(): void {
    const now = this.clock();
    for (const [id, record] of this.requests) {
      if (record.status === 'pending' && record.request.expiresAt < now) this.markExpired(record);
      if (record.cleanupAt > 0 && record.cleanupAt < now) this.requests.delete(id);
    }
    this.ticketAttempts.prune();
    this.codeAttempts.prune();
    this.codeGlobal.prune();
    this.resumeAttempts.prune();
    this.ensureFresh();
    this.pruneDevices();
  }

  private pruneDevices(): void {
    const cutoff = this.clock() - 30 * 24 * 60 * 60 * 1000;
    const state = this.store.get();
    const keep = state.devices.filter((device) => device.remembered || device.lastSeenAt > cutoff);
    if (keep.length !== state.devices.length) {
      this.store.update((next) => {
        next.devices = keep;
      });
    }
  }

  private hashCredential(secret: string): string {
    return createHmac('sha256', this.store.get().serverSecret).update(`device:${secret}`).digest('hex');
  }

  private sign(payload: string): string {
    return createHmac('sha256', this.store.get().serverSecret).update(payload).digest('base64url');
  }

  private failure(status: number, code: string, message: string): PairOutcome {
    return { result: { status: 'denied', error: { code, message } }, token: null, status };
  }

  private async renderQr(text: string): Promise<string | null> {
    try {
      return await QRCode.toDataURL(text, {
        errorCorrectionLevel: 'M',
        margin: 1,
        width: 360,
        color: { dark: '#0e1113', light: '#ffffff' },
      });
    } catch (error) {
      this.logger.warn('pair.qr_failed', { error: String(error) });
      return null;
    }
  }
}

export function toDeviceInfo(record: DeviceRecord): DeviceInfo {
  return {
    id: record.id,
    name: record.name,
    platform: record.platform as Platform,
    userAgent: record.userAgent,
    ip: record.ip,
    firstSeenAt: record.firstSeenAt,
    lastSeenAt: record.lastSeenAt,
    remembered: record.remembered,
    blocked: record.blocked,
  };
}

function safeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  return bufferA.length === bufferB.length && timingSafeEqual(bufferA, bufferB);
}

export function defaultNameForUserAgent(userAgent: string): string {
  return defaultDeviceName(userAgent);
}

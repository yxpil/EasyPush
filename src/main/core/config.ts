import os from 'node:os';
import type { LogLevel, Settings } from '../../shared/types';

export const SCHEMA_VERSION = 1;
export const DEFAULT_HTTP_PORT = 7333;
export const DEFAULT_HTTPS_PORT = 7443;
export const PORT_SEARCH_RANGE = 10;
export const MAX_HISTORY = 200;
export const MAX_DEVICES = 500;
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const PAIR_TICKET_TTL_MS = 120_000;
export const PAIR_CODE_TTL_MS = 300_000;
export const PAIR_REQUEST_TTL_MS = 60_000;
export const LIVE_APPROVAL_TTL_MS = 60_000;
export const LIVE_OFFER_TTL_MS = 25_000;
export const LIVE_DISCONNECT_GRACE_MS = 8_000;
export const UPLOAD_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export function defaultDeviceName(): string {
  const host = os.hostname().replace(/\.local$/i, '').trim();
  if (!host) return 'EasyPush';
  return host.slice(0, 40);
}

export function defaultSettings(): Settings {
  return {
    schema: SCHEMA_VERSION,
    deviceName: defaultDeviceName(),
    httpPort: DEFAULT_HTTP_PORT,
    httpsPort: DEFAULT_HTTPS_PORT,
    primaryAddress: null,
    autoApprove: false,
    allowDlna: true,
    allowLive: true,
    closeToTray: true,
    launchAtLogin: false,
    volume: 0.85,
    muted: false,
    imageSlideMs: 8000,
    logLevel: 'info',
  };
}

export function isValidLogLevel(value: unknown): value is LogLevel {
  return value === 'debug' || value === 'info' || value === 'warn' || value === 'error';
}

export function normalizeSettings(patch: Partial<Settings>, current: Settings): Settings {
  const next: Settings = { ...current };
  if (typeof patch.deviceName === 'string') {
    const name = patch.deviceName.replace(/\p{Cc}/gu, '').trim().slice(0, 40);
    if (name) next.deviceName = name;
  }
  if (Number.isInteger(patch.httpPort) && patch.httpPort! >= 1024 && patch.httpPort! <= 65535) {
    next.httpPort = patch.httpPort!;
  }
  if (Number.isInteger(patch.httpsPort) && patch.httpsPort! >= 1024 && patch.httpsPort! <= 65535) {
    next.httpsPort = patch.httpsPort!;
  }
  if (patch.primaryAddress === null || typeof patch.primaryAddress === 'string') {
    next.primaryAddress = patch.primaryAddress;
  }
  if (typeof patch.autoApprove === 'boolean') next.autoApprove = patch.autoApprove;
  if (typeof patch.allowDlna === 'boolean') next.allowDlna = patch.allowDlna;
  if (typeof patch.allowLive === 'boolean') next.allowLive = patch.allowLive;
  if (typeof patch.closeToTray === 'boolean') next.closeToTray = patch.closeToTray;
  if (typeof patch.launchAtLogin === 'boolean') next.launchAtLogin = patch.launchAtLogin;
  if (typeof patch.volume === 'number' && Number.isFinite(patch.volume)) {
    next.volume = Math.min(1, Math.max(0, patch.volume));
  }
  if (typeof patch.muted === 'boolean') next.muted = patch.muted;
  if (Number.isInteger(patch.imageSlideMs)) {
    next.imageSlideMs = Math.min(600_000, Math.max(2000, patch.imageSlideMs!));
  }
  if (isValidLogLevel(patch.logLevel)) next.logLevel = patch.logLevel;
  next.schema = SCHEMA_VERSION;
  return next;
}

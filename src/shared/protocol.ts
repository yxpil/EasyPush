import type { ClientMessage, MediaKind, Platform } from './types';

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

export const ErrorCode = {
  UNAUTHORIZED: 'unauthorized',
  BUSY: 'busy',
  DISABLED: 'live-disabled',
  NOT_APPROVED: 'not-approved',
  PROTOCOL: 'protocol',
  TOO_LARGE: 'too-large',
  RATE_LIMITED: 'rate-limited',
  INVALID_TICKET: 'invalid-ticket',
  INVALID_CODE: 'invalid-code',
  EXPIRED: 'expired',
  REJECTED: 'rejected',
  NO_SESSION: 'no-session',
  INVALID_REQUEST: 'invalid-request',
} as const;

const MAX_SDP_LENGTH = 200_000;
const MAX_CANDIDATE_LENGTH = 4_096;
const MAX_NAME_LENGTH = 48;

export function platformFromUserAgent(ua: string): Platform {
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
  if (/Android/i.test(ua)) return 'android';
  if (/Windows/i.test(ua)) return 'windows';
  if (/Macintosh|Mac OS X/i.test(ua)) return 'macos';
  if (/Linux/i.test(ua)) return 'linux';
  return 'other';
}

export function defaultDeviceName(ua: string): string {
  if (/iPad/i.test(ua)) return 'iPad';
  if (/iPhone/i.test(ua)) return 'iPhone';
  if (/Android/i.test(ua)) return 'Android 设备';
  if (/Windows/i.test(ua)) return 'Windows 电脑';
  if (/Macintosh|Mac OS X/i.test(ua)) return 'Mac';
  if (/Linux/i.test(ua)) return 'Linux 设备';
  return '局域网设备';
}

export function sanitizeDeviceName(raw: unknown, ua: string): string {
  if (typeof raw !== 'string') return defaultDeviceName(ua);
  const cleaned = raw
    .replace(/\p{Cc}/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME_LENGTH);
  return cleaned || defaultDeviceName(ua);
}

export function parseClientMessage(raw: unknown): ParseResult<ClientMessage> {
  if (typeof raw !== 'object' || raw === null) return fail('消息必须是 JSON 对象');
  const msg = raw as Record<string, unknown>;
  const type = msg['type'];
  if (typeof type !== 'string') return fail('缺少消息类型');

  if (type === 'intent') {
    const media = msg['media'];
    if (media !== 'screen' && media !== 'camera') return fail('无效的投屏类型');
    if (typeof msg['audio'] !== 'boolean') return fail('audio 必须是布尔值');
    return ok({ type, media, audio: msg['audio'] });
  }

  if (type === 'resume') {
    const sessionId = msg['sessionId'];
    if (!isId(sessionId)) return fail('无效的会话标识');
    return ok({ type, sessionId });
  }

  if (type === 'offer') {
    const sdp = msg['sdp'];
    const media = msg['media'];
    if (media !== 'screen' && media !== 'camera') return fail('无效的投屏类型');
    if (typeof msg['audio'] !== 'boolean') return fail('audio 必须是布尔值');
    if (!isSdp(sdp, 'offer')) return fail('无效的 SDP offer');
    return ok({ type, sdp: { type: 'offer', sdp: sdp.sdp }, media, audio: msg['audio'] });
  }

  if (type === 'ice') {
    const candidate = msg['candidate'];
    if (candidate === null) return ok({ type, candidate: null });
    if (typeof candidate !== 'object') return fail('无效的 ICE candidate');
    const c = candidate as Record<string, unknown>;
    if (typeof c['candidate'] !== 'string' || c['candidate'].length > MAX_CANDIDATE_LENGTH) {
      return fail('无效的 ICE candidate');
    }
    const sdpMid = c['sdpMid'];
    const sdpMLineIndex = c['sdpMLineIndex'];
    if (sdpMid !== null && typeof sdpMid !== 'string') return fail('无效的 sdpMid');
    if (sdpMLineIndex !== null && typeof sdpMLineIndex !== 'number') return fail('无效的 sdpMLineIndex');
    return ok({
      type,
      candidate: {
        candidate: c['candidate'],
        sdpMid,
        sdpMLineIndex,
        usernameFragment: typeof c['usernameFragment'] === 'string' ? c['usernameFragment'] : null,
      },
    });
  }

  if (type === 'end') {
    const reason = msg['reason'];
    if (reason !== undefined && (typeof reason !== 'string' || reason.length > 200)) return fail('无效的结束原因');
    return ok({ type, reason: typeof reason === 'string' ? reason : undefined });
  }

  if (type === 'ping') {
    const t = msg['t'];
    if (typeof t !== 'number' || !Number.isFinite(t)) return fail('无效的 ping');
    return ok({ type, t });
  }

  return fail('未知的消息类型');
}

function isSdp(value: unknown, type: 'offer' | 'answer'): value is { type: 'offer' | 'answer'; sdp: string } {
  if (typeof value !== 'object' || value === null) return false;
  const sdp = value as Record<string, unknown>;
  return sdp['type'] === type && typeof sdp['sdp'] === 'string' && sdp['sdp'].length > 0 && sdp['sdp'].length <= MAX_SDP_LENGTH;
}

export function isValidSdpAnswer(value: unknown): value is { type: 'answer'; sdp: string } {
  return isSdp(value, 'answer');
}

export function isId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{8,64}$/.test(value);
}

export function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a = 0, b = 0] = parts;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

export function isSupportedMediaMime(mime: string): boolean {
  if (!mime) return true;
  return /^(video|audio|image)\//i.test(mime) || mime === 'application/vnd.apple.mpegurl' || mime === 'application/x-mpegurl';
}

const IMAGE_EXT = /\.(jpe?g|png|gif|webp|avif|bmp|svg|heic|heif)$/i;
const VIDEO_EXT = /\.(mp4|m4v|webm|mov|ogv|mkv|avi|m3u8)$/i;
const AUDIO_EXT = /\.(mp3|m4a|aac|wav|flac|ogg|oga|opus)$/i;

export function kindFromNameOrMime(name: string, mime: string): MediaKind {
  if (/^image\//i.test(mime) || IMAGE_EXT.test(name)) return 'image';
  if (/^audio\//i.test(mime) || AUDIO_EXT.test(name)) return 'audio';
  return 'video';
}

export function isLikelyPlayableName(name: string): boolean {
  return IMAGE_EXT.test(name) || VIDEO_EXT.test(name) || AUDIO_EXT.test(name);
}

export function isPlayableExtension(name: string): boolean {
  return IMAGE_EXT.test(name) || VIDEO_EXT.test(name) || AUDIO_EXT.test(name);
}

export function isSafeRemoteUrl(raw: string): boolean {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) return false;
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function parseDurationHms(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d+):(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  if (![hours, minutes, seconds].every(Number.isFinite)) return null;
  return hours * 3600 + minutes * 60 + seconds;
}

export function formatHms(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) totalSeconds = 0;
  const whole = Math.floor(totalSeconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const seconds = whole % 60;
  const millis = Math.round((totalSeconds - whole) * 1000);
  return `${hours}:${pad(minutes)}:${pad(seconds)}.${pad(millis, 3)}`;
}

export function extensionOf(name: string): string {
  const match = /\.([a-zA-Z0-9]+)$/.exec(name);
  return match ? match[1]!.toLowerCase() : '';
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

function fail(error: string): ParseResult<never> {
  return { ok: false, error };
}

function ok<T>(value: T): ParseResult<T> {
  return { ok: true, value };
}

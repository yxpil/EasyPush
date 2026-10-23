import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import type { AppCore } from './core/appCore';
import type { LiveStats, MediaState, MediaStateReport, Settings } from '../shared/types';
import { isValidSdpAnswer } from '../shared/protocol';

export interface IpcHost {
  assertTrusted(event: IpcMainEvent | IpcMainInvokeEvent): boolean;
  windowAction(action: 'minimize' | 'toggle-maximize' | 'close'): void;
  setFullscreen(value: boolean): void;
  openPath(target: 'logs' | 'data'): Promise<void>;
  copyText(text: string): void;
  installFirewallRule(ports: number[]): Promise<{ ok: boolean; error?: string }>;
  quit(): void;
}

const SETTINGS_KEYS = [
  'deviceName',
  'httpPort',
  'httpsPort',
  'primaryAddress',
  'autoApprove',
  'allowDlna',
  'allowLive',
  'closeToTray',
  'launchAtLogin',
  'volume',
  'muted',
  'imageSlideMs',
  'logLevel',
] as const;

const MEDIA_COMMANDS = new Set([
  'play',
  'pause',
  'stop',
  'next',
  'previous',
  'seek',
  'volume',
  'mute',
  'autoplay-images',
  'play-item',
  'stop-item',
]);

const MEDIA_STATES = new Set<MediaState>(['idle', 'loading', 'playing', 'paused', 'ended', 'error']);

export function registerIpcHandlers(core: AppCore, host: IpcHost): void {
  const handle = (channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => {
    ipcMain.handle(channel, (event, ...args) => {
      if (!host.assertTrusted(event)) throw new Error('非法调用来源');
      return listener(event, ...args);
    });
  };
  const on = (channel: string, listener: (event: IpcMainEvent, ...args: unknown[]) => void) => {
    ipcMain.on(channel, (event, ...args) => {
      if (!host.assertTrusted(event)) return;
      listener(event, ...args);
    });
  };

  handle('app:snapshot', () => core.getSnapshot());
  handle('app:history', () => core.getHistory());
  handle('app:logs', () => core.getLogs());
  handle('app:refresh-connect', () => core.refreshConnect());

  handle('app:approve-pairing', (_event, requestId, remember) => {
    core.approvePairing(asString(requestId, 64), Boolean(remember));
  });
  handle('app:deny-pairing', (_event, requestId) => {
    core.denyPairing(asString(requestId, 64));
  });

  handle('app:approve-live', (_event, sessionId) => {
    core.approveLive(asString(sessionId, 64));
  });
  handle('app:deny-live', (_event, sessionId) => {
    core.denyLive(asString(sessionId, 64));
  });
  handle('app:stop-live', (_event, sessionId) => {
    core.stopLive(asString(sessionId, 64));
  });
  handle('app:live-muted', (_event, sessionId, muted) => {
    core.setLiveMuted(asString(sessionId, 64), Boolean(muted));
  });
  handle('app:live-volume', (_event, sessionId, volume) => {
    core.setLiveVolume(asString(sessionId, 64), clampNumber(Number(volume), 0, 1));
  });

  handle('app:media-command', (_event, command, value) => {
    const name = asString(command, 32);
    if (!MEDIA_COMMANDS.has(name)) throw new Error('不支持的媒体指令');
    let safeValue: string | number | boolean | undefined;
    if (typeof value === 'string') safeValue = value.slice(0, 128);
    else if (typeof value === 'number' && Number.isFinite(value)) safeValue = value;
    else if (typeof value === 'boolean') safeValue = value;
    core.mediaCommand(name as Parameters<AppCore['mediaCommand']>[0], safeValue);
  });

  handle('app:update-settings', (_event, patch) => {
    if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) throw new Error('无效的设置');
    const input = patch as Record<string, unknown>;
    const next: Partial<Settings> = {};
    for (const key of SETTINGS_KEYS) {
      if (key in input) (next as Record<string, unknown>)[key] = input[key];
    }
    return core.updateSettings(next);
  });

  handle('app:revoke-device', (_event, deviceId) => {
    core.revokeDevice(asString(deviceId, 64));
  });

  handle('app:add-local-files', (_event, paths) => {
    if (!Array.isArray(paths)) throw new Error('无效的文件列表');
    const safe = paths.filter((item): item is string => typeof item === 'string' && item.length > 0 && item.length < 4096).slice(0, 50);
    return core.addLocalFiles(safe);
  });

  handle('app:add-url', (_event, url) => {
    core.addUrl(asString(url, 2048));
  });

  handle('app:clear-uploads', () => core.clearUploads());

  handle('app:diagnostics', () => {
    const text = core.diagnostics();
    host.copyText(text);
    return text;
  });

  handle('app:open-logs', () => host.openPath('logs'));
  handle('app:open-data-dir', () => host.openPath('data'));
  handle('app:install-firewall-rule', () => {
    const ports = [core.getSnapshot().server.httpPort, core.getSnapshot().server.httpsPort].filter((port) => port > 0);
    return host.installFirewallRule(ports);
  });
  handle('app:set-fullscreen', (_event, value) => host.setFullscreen(Boolean(value)));
  handle('app:window-action', (_event, action) => {
    const value = asString(action, 32);
    if (value !== 'minimize' && value !== 'toggle-maximize' && value !== 'close') throw new Error('无效的窗口操作');
    host.windowAction(value);
  });
  handle('app:quit', () => host.quit());

  on('app:ready', () => core.reportRendererReady());

  on('app:report-live-state', (_event, raw) => {
    const report = parseLiveState(raw);
    if (report) core.reportLiveState(report);
  });

  on('app:report-live-signal', (_event, raw) => {
    if (typeof raw !== 'object' || raw === null) return;
    const payload = raw as Record<string, unknown>;
    if (typeof payload['sessionId'] !== 'string') return;
    let answer: { type: 'answer'; sdp: string } | undefined;
    if (isValidSdpAnswer(payload['answer'])) answer = payload['answer'];
    let candidate: { candidate: string; sdpMid: string | null; sdpMLineIndex: number | null } | null | undefined;
    if (payload['candidate'] === null) candidate = null;
    else if (typeof payload['candidate'] === 'object' && payload['candidate'] !== null) {
      const c = payload['candidate'] as Record<string, unknown>;
      if (typeof c['candidate'] === 'string' && c['candidate'].length <= 4096) {
        candidate = {
          candidate: c['candidate'],
          sdpMid: typeof c['sdpMid'] === 'string' ? c['sdpMid'].slice(0, 128) : null,
          sdpMLineIndex: typeof c['sdpMLineIndex'] === 'number' ? c['sdpMLineIndex'] : null,
        };
      }
    }
    if (!answer && candidate === undefined) return;
    core.reportLiveSignal({ sessionId: payload['sessionId'].slice(0, 64), answer, candidate });
  });

  on('app:report-live-gone', (_event, raw) => {
    if (typeof raw !== 'object' || raw === null) return;
    const payload = raw as Record<string, unknown>;
    if (typeof payload['sessionId'] !== 'string') return;
    core.reportLiveGone({ sessionId: payload['sessionId'].slice(0, 64), reason: asString(payload['reason'] ?? 'renderer gone', 200) });
  });

  on('app:report-media-state', (_event, raw) => {
    const report = parseMediaState(raw);
    if (report) core.reportMediaState(report);
  });

  on('app:report-media-gone', (_event, raw) => {
    if (typeof raw !== 'object' || raw === null) return;
    const payload = raw as Record<string, unknown>;
    if (typeof payload['sessionId'] !== 'string') return;
    core.reportMediaGone({ sessionId: payload['sessionId'].slice(0, 64), reason: asString(payload['reason'] ?? 'renderer gone', 200) });
  });
}

export function removeIpcHandlers(): void {
  const channels = [
    'app:snapshot',
    'app:history',
    'app:logs',
    'app:refresh-connect',
    'app:approve-pairing',
    'app:deny-pairing',
    'app:approve-live',
    'app:deny-live',
    'app:stop-live',
    'app:live-muted',
    'app:live-volume',
    'app:media-command',
    'app:update-settings',
    'app:revoke-device',
    'app:add-local-files',
    'app:add-url',
    'app:clear-uploads',
    'app:diagnostics',
    'app:open-logs',
    'app:open-data-dir',
    'app:install-firewall-rule',
    'app:set-fullscreen',
    'app:window-action',
    'app:quit',
    'app:ready',
    'app:report-live-state',
    'app:report-live-signal',
    'app:report-live-gone',
    'app:report-media-state',
    'app:report-media-gone',
  ];
  for (const channel of channels) {
    ipcMain.removeHandler(channel);
    ipcMain.removeAllListeners(channel);
  }
}

function parseLiveState(raw: unknown) {
  if (typeof raw !== 'object' || raw === null) return null;
  const report = raw as Record<string, unknown>;
  if (typeof report['sessionId'] !== 'string') return null;
  const state = report['state'];
  if (state !== 'connecting' && state !== 'live' && state !== 'failed') return null;
  const error = typeof report['error'] === 'string' ? report['error'].slice(0, 300) : null;
  return {
    sessionId: report['sessionId'].slice(0, 64),
    state,
    error,
    stats: parseStats(report['stats']),
  } as const;
}

function parseStats(raw: unknown): LiveStats | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const stats = raw as Record<string, unknown>;
  const number = (key: string, fallback = 0) => {
    const value = Number(stats[key]);
    return Number.isFinite(value) ? value : fallback;
  };
  return {
    at: number('at', Date.now()),
    width: number('width'),
    height: number('height'),
    fps: number('fps'),
    bitrateKbps: number('bitrateKbps'),
    rttMs: stats['rttMs'] === null ? null : number('rttMs'),
    jitterMs: number('jitterMs'),
    packetsLost: number('packetsLost'),
    bytesReceived: number('bytesReceived'),
    framesDecoded: number('framesDecoded'),
    codec: typeof stats['codec'] === 'string' ? stats['codec'].slice(0, 64) : 'unknown',
    audioCodec: typeof stats['audioCodec'] === 'string' ? stats['audioCodec'].slice(0, 64) : null,
    jitterBufferMs: stats['jitterBufferMs'] === null ? null : number('jitterBufferMs'),
  };
}

function parseMediaState(raw: unknown): MediaStateReport | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const report = raw as Record<string, unknown>;
  if (typeof report['sessionId'] !== 'string') return null;
  if (typeof report['state'] !== 'string' || !MEDIA_STATES.has(report['state'] as MediaState)) return null;
  const num = (key: string, fallback = 0) => {
    const value = Number(report[key]);
    return Number.isFinite(value) ? value : fallback;
  };
  return {
    sessionId: report['sessionId'].slice(0, 64),
    state: report['state'] as MediaState,
    positionSec: Math.max(0, num('positionSec')),
    durationSec: Math.max(0, num('durationSec')),
    volume: clampNumber(num('volume', 1), 0, 1),
    muted: Boolean(report['muted']),
    index: Math.max(0, Math.floor(num('index'))),
    error: typeof report['error'] === 'string' ? report['error'].slice(0, 300) : null,
    canSeek: Boolean(report['canSeek']),
    width: typeof report['width'] === 'number' && report['width'] > 0 ? report['width'] : null,
    height: typeof report['height'] === 'number' && report['height'] > 0 ? report['height'] : null,
  };
}

function asString(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) throw new Error('无效的参数');
  return value;
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

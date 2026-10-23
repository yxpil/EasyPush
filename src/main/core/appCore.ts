import os from 'node:os';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  AppSnapshot,
  ConnectInfo,
  DlnaStatus,
  FirewallStatus,
  HistoryEntry,
  LiveStateReport,
  PairingRequest,
  ServerInfo,
  Settings,
  ToastMessage,
} from '../../shared/types';
import { PROTOCOL_VERSION } from '../../shared/types';
import { clamp } from '../../shared/format';
import { isSafeRemoteUrl, kindFromNameOrMime } from '../../shared/protocol';
import { CertManager, type SecretBox } from './certs';
import { normalizeSettings } from './config';
import { detectLanInterfaces, buildAddressInfos, pickLanInterface, type LanInterface } from './lan';
import { Logger } from './logger';
import { detectNetworkProfile } from './networkProfile';
import { Store } from './store';
import { HttpLayer } from '../net/http';
import { WsHub } from '../net/ws';
import { PairingService } from '../services/pairing';
import { MediaLibrary, normalizeMime, sanitizeFileName } from '../services/mediaLibrary';
import { PresentationService, type MediaCommand } from '../services/presentation';
import { LiveService } from '../services/live';

export type DesktopChannel =
  | 'app:snapshot'
  | 'app:toast'
  | 'live:prepare'
  | 'live:offer'
  | 'live:ice'
  | 'live:stop'
  | 'live:notice'
  | 'live:command'
  | 'media:load'
  | 'media:sync'
  | 'media:command';

export interface DesktopPort {
  isReady(): boolean;
  send(channel: DesktopChannel, payload: unknown): void;
}

export interface DlnaContext {
  store: Store;
  logger: Logger;
  media: MediaLibrary;
  presentation: PresentationService;
  getInstanceId(): string;
  getAddress(): string | null;
  getHttpPort(): number;
  getFriendlyName(): string;
  onChange(): void;
}

export interface DlnaPort {
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): DlnaStatus;
  handle(req: IncomingMessage, res: ServerResponse): boolean;
}

export interface CoreOptions {
  dataDir: string;
  version: string;
  desktop: DesktopPort;
  secretBox: SecretBox;
  consoleLogs?: boolean;
  createDlna?: (ctx: DlnaContext) => DlnaPort;
  onSettingsChanged?: (settings: Settings) => void;
  onSystemNotice?: (title: string, body: string) => void;
  onLiveActiveChanged?: (active: boolean) => void;
  onServerRestarted?: (httpPort: number, httpsPort: number) => void;
  clock?: () => number;
}

interface Urls {
  httpBase: string | null;
  httpsBase: string | null;
  ca: string | null;
}

export class AppCore {
  readonly logger: Logger;
  readonly store: Store;
  readonly pairing: PairingService;
  readonly media: MediaLibrary;
  readonly presentation: PresentationService;
  readonly live: LiveService;
  readonly certs: CertManager;
  readonly http: HttpLayer;
  private readonly ws: WsHub;
  private readonly startedAt = Date.now();
  private ifaces: LanInterface[] = [];
  private primary: LanInterface | null = null;
  private urls: Urls = { httpBase: null, httpsBase: null, ca: null };
  private connect: ConnectInfo;
  private revision = 0;
  private rendererReady = false;
  private snapshotTimer: NodeJS.Timeout | null = null;
  private connectTimer: NodeJS.Timeout | null = null;
  private networkTimer: NodeJS.Timeout | null = null;
  private firewall: FirewallStatus = { networkProfile: 'unknown', warning: null };
  private dlna: DlnaPort | null = null;
  private toastSeq = 0;
  private started = false;
  private stopped = false;
  readonly logsDir: string;
  readonly certsDir: string;
  readonly dataDir: string;

  constructor(private readonly options: CoreOptions) {
    this.dataDir = options.dataDir;
    this.logsDir = `${options.dataDir}/logs`;
    this.certsDir = `${options.dataDir}/certs`;
    this.logger = new Logger(this.logsDir, 'info', { console: options.consoleLogs, retentionDays: 14 });
    this.store = new Store(`${options.dataDir}/state.json`, this.logger);
    this.media = new MediaLibrary(options.dataDir, this.logger);
    this.certs = new CertManager(this.certsDir, options.secretBox, this.logger, this.store.get().instanceId);

    this.pairing = new PairingService(
      this.store,
      this.logger,
      {
        changed: () => {
          this.queueConnectRefresh();
          this.scheduleSnapshot();
        },
        request: (request) => this.onPairingRequest(request),
        resolved: (request, approved) => {
          this.emitToast({
            kind: approved ? 'success' : 'info',
            title: approved ? '设备已配对' : '配对已拒绝',
            message: request.deviceName,
          });
        },
      },
      () => ({ http: this.urls.httpBase, https: this.urls.httpsBase, ca: this.urls.ca }),
      options.clock,
    );

    this.presentation = new PresentationService(
      this.store,
      this.logger,
      this.media,
      {
        isReady: () => this.rendererReady,
        loadMedia: (session, autoplay) => this.send('media:load', { session, autoplay }),
        syncMedia: (session) => this.send('media:sync', { session }),
        mediaCommand: (sessionId, command, value) => this.send('media:command', { sessionId, command, value }),
      },
      {
        changed: () => this.scheduleSnapshot(),
        toast: (toast) => this.emitToast(toast),
        history: (entry) => this.recordHistory(entry),
      },
    );

    this.live = new LiveService(
      this.store,
      this.logger,
      {
        isReady: () => this.rendererReady,
        prepareLive: (session) => this.send('live:prepare', session),
        deliverOffer: (sessionId, sdp) => this.send('live:offer', { sessionId, sdp }),
        deliverIce: (sessionId, candidate) => this.send('live:ice', { sessionId, candidate }),
        stopLive: (sessionId, reason) => this.send('live:stop', { sessionId, reason }),
        commandLive: (sessionId, action, value) => this.send('live:command', { sessionId, action, value }),
      },
      {
        changed: () => this.scheduleSnapshot(),
        pendingChanged: (session) => {
          this.scheduleSnapshot();
          if (session) {
            this.options.onSystemNotice?.('新的投屏请求', `${session.deviceName} 请求投屏`);
          }
        },
        toast: (toast) => this.emitToast(toast),
        history: (entry) => this.recordHistory(entry),
        liveStarted: (session) => {
          this.presentation.onLiveStarted(session);
          this.options.onLiveActiveChanged?.(true);
          this.options.onSystemNotice?.(`${session.deviceName} 开始投屏`, session.media === 'screen' ? '屏幕共享' : '摄像头');
        },
        liveEnded: () => {
          this.presentation.onLiveEnded();
          this.options.onLiveActiveChanged?.(false);
        },
      },
      options.clock,
    );

    this.http = new HttpLayer({
      webDir: '',
      desktopDir: '',
      store: this.store,
      logger: this.logger,
      pairing: this.pairing,
      media: this.media,
      presentation: this.presentation,
      certs: this.certs,
      getServerInfo: () => this.serverInfo(),
      revokeDevice: (deviceId) => this.revokeDevice(deviceId),
      version: options.version,
      startedAt: this.startedAt,
    });

    this.ws = new WsHub({ pairing: this.pairing, live: this.live, logger: this.logger });

    this.connect = {
      ticket: this.pairing.currentTicket(),
      ticketExpiresAt: Date.now() + 120_000,
      code: this.pairing.currentCode(),
      codeExpiresAt: Date.now() + 300_000,
      httpUrl: null,
      httpsUrl: null,
      qrDataUrl: null,
      qrSecureDataUrl: null,
      caUrl: null,
      autoApprove: this.store.get().settings.autoApprove,
    };
  }

  async start(paths: { webDir: string; desktopDir: string }): Promise<void> {
    this.logger.info('app.starting', { version: this.options.version, platform: process.platform });
    await this.logger.init();
    await this.store.load();
    const settings = this.store.get().settings;
    this.certs.setInstanceId(this.store.get().instanceId);
    this.logger.setLevel(settings.logLevel);
    this.http.setStaticDirs(paths.webDir, paths.desktopDir);
    await this.media.init();
    this.refreshInterfaces();
    await this.certs.init(
      this.ifaces.map((iface) => iface.address),
      os.hostname(),
    );
    const ports = await this.http.start(settings.httpPort, settings.httpsPort);
    this.media.setBaseUrl(`http://127.0.0.1:${ports.http}`);
    this.refreshUrls();
    this.ws.attach(this.http);
    this.pairing.start();
    this.live.start();
    this.connect = await this.pairing.refreshConnect();
    if (this.options.createDlna) {
      this.dlna = this.options.createDlna({
        store: this.store,
        logger: this.logger,
        media: this.media,
        presentation: this.presentation,
        getInstanceId: () => this.store.get().instanceId,
        getAddress: () => this.primary?.address ?? null,
        getHttpPort: () => this.http.getPorts().http,
        getFriendlyName: () => this.store.get().settings.deviceName,
        onChange: () => this.scheduleSnapshot(),
      });
      this.http.setDlnaHandler(this.dlna);
      if (settings.allowDlna) {
        await this.dlna.start().catch((error) => {
          this.logger.warn('dlna.start_failed', { error: String(error) });
        });
      }
    }
    void this.refreshFirewall();
    this.networkTimer = setInterval(() => void this.refreshNetwork(), 15_000);
    this.networkTimer.unref();
    this.started = true;
    this.logger.info('app.started', { http: ports.http, https: ports.https, address: this.primary?.address ?? null });
    this.scheduleSnapshot();
  }

  async shutdown(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.logger.info('app.stopping');
    if (this.networkTimer) clearInterval(this.networkTimer);
    if (this.snapshotTimer) clearTimeout(this.snapshotTimer);
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.live.shutdown();
    await this.presentation.shutdown();
    await this.dlna?.stop().catch(() => undefined);
    this.ws.shutdown();    this.pairing.stop();
    await this.http.stop();
    await this.store.close();
    await this.logger.close();
  }

  getSnapshot(): AppSnapshot {
    const state = this.store.get();
    const liveState = this.live.getSession();
    const media = this.presentation.snapshot();
    return {
      revision: this.revision,
      server: this.serverInfo(),
      settings: state.settings,
      connect: this.connect,
      devices: this.pairing.listDevices(),
      live: liveState,
      livePending: this.live.getPending(),
      media: media.media,
      presentation: media.presentation,
      pairing: this.pairing.pendingRequest(),
      history: state.history,
      uptimeSec: Math.round((Date.now() - this.startedAt) / 1000),
    };
  }

  getHistory(): HistoryEntry[] {
    return this.store.get().history;
  }

  getLogs(): string[] {
    return this.logger.entries(400).map((entry) => {
      const time = new Date(entry.at).toISOString().slice(11, 23);
      const fields = Object.keys(entry.fields).length ? ` ${JSON.stringify(entry.fields)}` : '';
      return `${time} ${entry.level.toUpperCase().padEnd(5)} ${entry.event}${fields}`;
    });
  }

  getPrimaryAddress(): string | null {
    return this.primary?.address ?? null;
  }

  get isRendererReady(): boolean {
    return this.rendererReady;
  }

  get serverStartedAt(): number {
    return this.startedAt;
  }

  get dataPaths() {
    return { dataDir: this.dataDir, uploadsDir: this.media.uploadsDir, logsDir: this.logsDir, certsDir: this.certsDir };
  }

  reportRendererReady(): void {
    if (this.rendererReady) return;
    this.rendererReady = true;
    this.logger.info('renderer.ready');
    this.presentation.rendererReady();
    this.scheduleSnapshot();
  }

  reportRendererGone(reason: string): void {
    if (!this.rendererReady) return;
    this.rendererReady = false;
    this.logger.warn('renderer.gone', { reason });
    const live = this.live.getSession();
    if (live) this.live.handleRendererGone(live.id, `接收端界面已关闭（${reason}）`);
    this.presentation.onRendererGone(reason);
    this.scheduleSnapshot();
  }

  reportLiveState(report: LiveStateReport): void {
    this.live.handleRendererState(report.sessionId, report.state, report.error, report.stats);
  }

  reportLiveSignal(payload: { sessionId: string; answer?: { type: 'answer'; sdp: string }; candidate?: { candidate: string; sdpMid: string | null; sdpMLineIndex: number | null } | null }): void {
    this.live.handleRendererSignal(payload.sessionId, payload.answer, payload.candidate);
  }

  reportLiveGone(payload: { sessionId: string; reason: string }): void {
    this.live.handleRendererGone(payload.sessionId, payload.reason);
  }

  reportMediaState(report: Parameters<PresentationService['onRendererState']>[0]): void {
    this.presentation.onRendererState(report);
  }

  reportMediaGone(payload: { sessionId: string; reason: string }): void {
    const media = this.presentation.getMedia();
    if (media && media.id === payload.sessionId) this.presentation.onRendererGone(payload.reason);
  }

  approvePairing(requestId: string, remember: boolean): void {
    const request = this.pairing.decide(requestId, true, remember);
    if (!request) this.emitToast({ kind: 'warn', title: '配对请求已失效', message: '请让对方重新扫描二维码' });
  }

  denyPairing(requestId: string): void {
    this.pairing.decide(requestId, false, false);
  }

  approveLive(sessionId: string): void {
    this.live.decide(sessionId, true);
  }

  denyLive(sessionId: string): void {
    this.live.decide(sessionId, false);
  }

  stopLive(sessionId: string): void {
    this.live.stopByUser(sessionId);
  }

  setLiveMuted(sessionId: string, muted: boolean): void {
    this.live.setMuted(sessionId, muted);
  }

  setLiveVolume(sessionId: string, volume: number): void {
    this.live.setVolume(sessionId, clamp(volume, 0, 1));
  }

  mediaCommand(command: MediaCommand | 'play-item' | 'stop-item', value?: number | boolean | string): void {
    if (command === 'play-item') {
      if (typeof value === 'string') this.presentation.playItem(value);
      return;
    }
    if (command === 'stop-item') {
      this.presentation.stop();
      return;
    }
    this.presentation.command(command, value as number | boolean | undefined);
  }

  async updateSettings(patch: Partial<Settings>): Promise<Settings> {
    const current = this.store.get().settings;
    const next = normalizeSettings(patch, current);
    const portsChanged = next.httpPort !== current.httpPort || next.httpsPort !== current.httpsPort;
    if (portsChanged) {
      if (this.live.getSession() || this.live.getPending()) {
        throw new Error('请先结束当前投屏，再修改端口');
      }
      if (this.presentation.getMedia()) {
        throw new Error('请先停止当前媒体播放，再修改端口');
      }
    }
    this.store.setSettings(next);
    if (next.logLevel !== current.logLevel) this.logger.setLevel(next.logLevel);
    if (next.allowLive === false && (this.live.getSession() || this.live.getPending())) {
      const session = this.live.getSession() ?? this.live.getPending();
      if (session) this.live.stopByUser(session.id);
    }
    if (portsChanged) await this.restartServers();
    if (next.allowDlna !== current.allowDlna && this.dlna) {
      if (next.allowDlna) await this.dlna.start().catch((error) => this.logger.warn('dlna.start_failed', { error: String(error) }));
      else await this.dlna.stop().catch(() => undefined);
    }
    if (next.deviceName !== current.deviceName) {
      this.queueConnectRefresh();
    }
    if (next.primaryAddress !== current.primaryAddress) {
      this.refreshInterfaces();
      this.refreshUrls();
      this.queueConnectRefresh();
    }
    this.options.onSettingsChanged?.(next);
    this.scheduleSnapshot();
    return next;
  }

  async refreshConnect(): Promise<ConnectInfo> {
    this.connect = await this.pairing.refreshConnect();
    this.scheduleSnapshot();
    return this.connect;
  }

  async addLocalFiles(paths: string[]): Promise<number> {
    const items = await this.media.addLocalFiles(paths);
    if (items.length === 0) return 0;
    this.presentation.addItems(items, 'local', '127.0.0.1');
    return items.length;
  }

  addUrl(rawUrl: string): void {
    const url = rawUrl.trim();
    if (!isSafeRemoteUrl(url)) throw new Error('请输入有效的 http/https 媒体地址');
    let title = '网络媒体';
    try {
      const parsed = new URL(url);
      const segment = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() ?? '');
      title = segment ? sanitizeFileName(segment) : parsed.hostname;
    } catch {
      // validated above
    }
    const mime = normalizeMime('', title);
    const item = this.media.addRemoteItem({
      url,
      title,
      mime,
      kind: kindFromNameOrMime(title, mime),
      source: 'url',
      sourceLabel: '桌面',
    });
    this.presentation.addItems([item], 'url', '127.0.0.1');
  }

  revokeDevice(deviceId: string): void {
    this.live.endForDevice(deviceId, '设备已被移除');
    if (this.pairing.revokeDevice(deviceId)) {
      this.emitToast({ kind: 'info', title: '设备已移除', message: '该设备需要重新配对' });
    }
  }

  async clearUploads(): Promise<number> {
    const media = this.presentation.getMedia();
    if (media?.items.some((item) => item.source === 'upload')) this.presentation.stop();
    const bytes = await this.media.clearUploads();
    this.scheduleSnapshot();
    return bytes;
  }

  diagnostics(): string {
    const snapshot = this.getSnapshot();
    const report = {
      app: 'EasyPush',
      version: this.options.version,
      os: `${os.type()} ${os.release()} (${process.arch})`,
      electron: process.versions.electron ?? null,
      chrome: process.versions.chrome ?? null,
      node: process.versions.node,
      uptimeSec: snapshot.uptimeSec,
      server: snapshot.server,
      settings: snapshot.settings,
      devices: snapshot.devices.map((device) => ({ id: device.id, name: device.name, platform: device.platform, ip: device.ip, remembered: device.remembered })),
      live: snapshot.live ? { id: snapshot.live.id, device: snapshot.live.deviceName, state: snapshot.live.state, media: snapshot.live.media, stats: snapshot.live.stats } : null,
      media: snapshot.media ? { id: snapshot.media.id, state: snapshot.media.state, source: snapshot.media.source, item: snapshot.media.items[snapshot.media.index]?.name ?? null } : null,
      logs: this.logger.entries(80),
    };
    return JSON.stringify(report, null, 2);
  }

  private async restartServers(): Promise<void> {
    const settings = this.store.get().settings;
    this.logger.info('http.restarting', { http: settings.httpPort, https: settings.httpsPort });
    const dlnaWasRunning = Boolean(this.dlna?.status().active);
    if (dlnaWasRunning) await this.dlna?.stop().catch(() => undefined);
    await this.http.stop();
    const ports = await this.http.start(settings.httpPort, settings.httpsPort);
    this.media.setBaseUrl(`http://127.0.0.1:${ports.http}`);
    this.refreshUrls();
    this.ws.attach(this.http);
    if (dlnaWasRunning) {
      await this.dlna?.start().catch((error) => this.logger.warn('dlna.start_failed', { error: String(error) }));
    }
    this.queueConnectRefresh();
    this.options.onServerRestarted?.(ports.http, ports.https ?? 0);
  }

  private refreshInterfaces(): void {
    this.ifaces = detectLanInterfaces();
    this.primary = pickLanInterface(this.ifaces, this.store.get().settings.primaryAddress);
  }

  private refreshUrls(): void {
    const ports = this.http.getPorts();
    if (!ports.http) {
      this.urls = { httpBase: null, httpsBase: null, ca: null };
      return;
    }
    const host = this.primary?.address ?? '127.0.0.1';
    this.urls = {
      httpBase: `http://${host}:${ports.http}`,
      httpsBase: ports.https ? `https://${host}:${ports.https}` : null,
      ca: `http://${host}:${ports.http}/ca.crt`,
    };
  }

  private async refreshNetwork(): Promise<void> {
    if (this.stopped) return;
    const before = this.ifaces.map((iface) => iface.address).sort().join(',');
    const beforePrimary = this.primary?.address ?? null;
    this.refreshInterfaces();
    const after = this.ifaces.map((iface) => iface.address).sort().join(',');
    if (before === after && beforePrimary === (this.primary?.address ?? null)) return;
    this.logger.info('network.changed', { address: this.primary?.address ?? null });
    try {
      const changed = await this.certs.ensureSans(
        this.ifaces.map((iface) => iface.address),
        os.hostname(),
      );
      if (changed) this.http.setHttpsContext();
    } catch (error) {
      this.logger.warn('certs.refresh_failed', { error: String(error) });
    }
    this.refreshUrls();
    if (beforePrimary !== (this.primary?.address ?? null) && this.store.get().settings.allowDlna && this.dlna) {
      await this.dlna.stop().catch(() => undefined);
      await this.dlna.start().catch((error) => this.logger.warn('dlna.restart_failed', { error: String(error) }));
    }
    this.queueConnectRefresh();
    this.scheduleSnapshot();
  }

  private async refreshFirewall(): Promise<void> {
    const profile = await detectNetworkProfile();
    if (this.stopped) return;
    const warning =
      profile === 'public'
        ? '当前网络为“公用网络”，Windows 防火墙可能阻止手机访问。请将网络设为专用，或在设置中安装防火墙放行规则。'
        : null;
    this.firewall = { networkProfile: profile, warning };
    if (warning) this.logger.warn('firewall.public_profile');
    this.scheduleSnapshot();
  }

  private serverInfo(): ServerInfo {
    const settings = this.store.get().settings;
    const ports = this.http.getPorts();
    const addresses = ports.http
      ? buildAddressInfos(this.ifaces, ports.http, ports.https, this.primary)
      : [];
    const primaryUrl = this.primary && ports.http ? `http://${this.primary.address}:${ports.http}` : null;
    const primaryHttpsUrl = this.primary && ports.https ? `https://${this.primary.address}:${ports.https}` : null;
    const dlnaStatus: DlnaStatus = this.dlna?.status() ?? {
      enabled: settings.allowDlna,
      active: false,
      port: 1900,
      friendlyName: settings.deviceName,
      error: null,
      location: null,
    };
    return {
      name: 'EasyPush',
      version: this.options.version,
      protocolVersion: PROTOCOL_VERSION,
      startedAt: this.startedAt,
      httpPort: ports.http,
      httpsPort: ports.https ?? 0,
      httpsEnabled: Boolean(ports.https),
      addresses,
      primaryUrl,
      primaryHttpsUrl,
      caFingerprint: this.certs.getFingerprint(),
      caUrl: this.urls.ca,
      caInstalledHint: '首次使用摄像头或屏幕共享时，需要在这台设备上安装并信任 EasyPush 本地 CA。证书仅用于当前局域网。',
      dlna: dlnaStatus,
      firewall: this.firewall,
      dataDir: this.dataDir,
      uploadsDir: this.media.uploadsDir,
      electron: process.versions.electron ?? '—',
      chrome: process.versions.chrome ?? '—',
      node: process.versions.node,
    };
  }

  private scheduleSnapshot(): void {
    if (this.stopped) return;
    if (this.snapshotTimer) return;
    this.snapshotTimer = setTimeout(() => {
      this.snapshotTimer = null;
      if (this.stopped || !this.rendererReady) return;
      this.revision += 1;
      this.send('app:snapshot', this.getSnapshot());
    }, 40);
  }

  private queueConnectRefresh(): void {
    if (this.stopped) return;
    if (this.connectTimer) return;
    this.connectTimer = setTimeout(() => {
      this.connectTimer = null;
      void this.pairing
        .refreshConnect()
        .then((connect) => {
          this.connect = connect;
          this.scheduleSnapshot();
        })
        .catch((error) => this.logger.warn('pairing.connect_refresh_failed', { error: String(error) }));
    }, 30);
  }

  private onPairingRequest(request: PairingRequest): void {
    this.logger.info('pairing.request_desktop', { device: request.deviceName, platform: request.platform });
    this.options.onSystemNotice?.('新的配对请求', `${request.deviceName} 请求连接到 ${this.store.get().settings.deviceName}`);
    this.scheduleSnapshot();
  }

  private emitToast(toast: Omit<ToastMessage, 'id'>): void {
    this.toastSeq += 1;
    const message: ToastMessage = { id: `${Date.now().toString(36)}-${this.toastSeq}`, ...toast };
    this.send('app:toast', message);
  }

  private recordHistory(entry: HistoryEntry): void {
    this.store.addHistory(entry);
    this.scheduleSnapshot();
  }

  private send(channel: DesktopChannel, payload: unknown): void {
    if (!this.rendererReady) return;
    try {
      this.options.desktop.send(channel, payload);
    } catch (error) {
      this.logger.warn('renderer.send_failed', { channel, error: String(error) });
    }
  }
}

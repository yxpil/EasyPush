import { randomUUID } from 'node:crypto';
import dgram from 'node:dgram';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { DlnaContext, DlnaPort } from '../core/appCore';
import type { DlnaStatus, MediaItem } from '../../shared/types';
import { formatHms, isPrivateIPv4, isSafeRemoteUrl, parseDurationHms } from '../../shared/protocol';
import { detectLanInterfaces, normalizeRemoteAddress } from '../core/lan';
import { RateLimiter } from '../core/rateLimiter';
import { normalizeMime, sanitizeFileName } from '../services/mediaLibrary';
import { PresentationError } from '../services/presentation';
import {
  AVT_SCPD,
  CM_SCPD,
  RCS_SCPD,
} from './scpd';
import {
  type DlnaService,
  SERVICE_PATHS,
  SERVICE_TYPES,
  SINK_PROTOCOL_INFO,
  UpnpError,
  buildAvtLastChange,
  buildDeviceDescription,
  buildDidl,
  buildRcsLastChange,
  deviceUuid,
  escapeXml,
  formatDidlDuration,
  itemFromDidl,
  parseDidl,
  parseSoapRequest,
  propertySet,
  soapEnvelope,
  soapFault,
  transportStateFor,
  type ParsedSoap,
} from './upnp';
import { kindFromNameOrMime } from '../../shared/protocol';

const SSDP_ADDRESS = '239.255.255.250';
const SSDP_PORT = 1900;
const CACHE_MAX_AGE = 1800;
const ANNOUNCE_INTERVAL_MS = CACHE_MAX_AGE * 1000 / 2;
const POLL_INTERVAL_MS = 1000;
const MAX_SOAP_BYTES = 128 * 1024;
const CALLBACK_TIMEOUT_MS = 4000;

interface Subscription {
  sid: string;
  service: DlnaService;
  callback: string;
  remoteIp: string;
  expiresAt: number;
  seq: number;
  failures: number;
}

interface SsdpTarget {
  st: string;
  usn: string;
}

interface MediaSnapshot {
  media: ReturnType<DlnaContext['presentation']['snapshot']>['media'];
  item: MediaItem | null;
  transport: string;
  actions: string;
  duration: string;
  uri: string;
  metadata: string;
  track: number;
  trackCount: number;
  volume: number;
  muted: boolean;
}

export class DlnaRenderer implements DlnaPort {
  private readonly uuid: string;
  private socket: dgram.Socket | null = null;
  private active = false;
  private error: string | null = null;
  private announceTimer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private bootId = 0;
  private subscribers = new Map<string, Subscription>();
  private lastAvtSignature = '';
  private lastRcsSignature = '';
  private readonly controlLimiter = new RateLimiter(1200, 60_000);
  private lastLoggedError = '';

  constructor(private readonly ctx: DlnaContext) {
    this.uuid = deviceUuid(ctx.getInstanceId());
  }

  async start(): Promise<void> {
    if (this.active) return;
    if (!this.ctx.store.get().settings.allowDlna) {
      this.error = 'DLNA 已在设置中关闭';
      return;
    }
    const address = this.ctx.getAddress();
    if (!address) {
      this.error = '未找到可用的局域网地址';
      return;
    }
    this.openSocket();
    await this.bind();
    this.active = true;
    this.error = null;
    this.bootId += 1;
    this.ctx.logger.info('dlna.started', { uuid: this.uuid, address, location: this.location() });
    this.scheduleAnnounce();
    this.pollTimer = setInterval(() => this.tick(), POLL_INTERVAL_MS);
    this.pollTimer.unref();
    setTimeout(() => this.announce('ssdp:alive'), 120).unref();
  }

  async stop(): Promise<void> {
    if (this.announceTimer) clearInterval(this.announceTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.announceTimer = null;
    this.pollTimer = null;
    if (this.active) this.announce('ssdp:byebye');
    this.active = false;
    this.subscribers.clear();
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      await new Promise<void>((resolve) => {
        try {
          socket.close(() => resolve());
        } catch {
          resolve();
        }
        setTimeout(resolve, 500).unref();
      });
    }
    this.ctx.logger.info('dlna.stopped');
  }

  status(): DlnaStatus {
    return {
      enabled: this.ctx.store.get().settings.allowDlna,
      active: this.active,
      port: SSDP_PORT,
      friendlyName: this.ctx.getFriendlyName(),
      error: this.error,
      location: this.active ? this.location() : null,
    };
  }

  handle(req: IncomingMessage, res: ServerResponse): boolean {
    let pathname = '/';
    try {
      pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
    } catch {
      this.respondText(res, 400, 'Bad Request');
      return true;
    }
    if (!pathname.startsWith('/dlna')) return false;
    const remote = normalizeRemoteAddress(req.socket.remoteAddress);
    if (!(remote === '::1' || isPrivateIPv4(remote))) {
      this.respondText(res, 403, 'Forbidden');
      return true;
    }
    if (!this.active) {
      this.respondText(res, 503, 'DLNA renderer is not running');
      return true;
    }
    void this.route(req, res, pathname, remote).catch((error) => {
      if (this.lastLoggedError !== String(error)) {
        this.lastLoggedError = String(error);
        this.ctx.logger.warn('dlna.request_failed', { path: pathname, error: String(error) });
      }
      if (!res.headersSent) this.respondText(res, 500, 'Internal Server Error');
      else res.destroy();
    });
    return true;
  }

  private async route(req: IncomingMessage, res: ServerResponse, pathname: string, remoteIp: string): Promise<void> {
    if (pathname === '/dlna/description.xml' || pathname === '/dlna/' || pathname === '/dlna') {
      if (req.method !== 'GET' && req.method !== 'HEAD') return this.respondText(res, 405, 'Method Not Allowed');
      const description = buildDeviceDescription({
        uuid: this.uuid,
        friendlyName: this.ctx.getFriendlyName(),
        version: '1.0',
        serverHeader: this.serverHeader(),
      });
      return this.respondXml(res, 200, description, req.method === 'HEAD');
    }

    if (pathname.startsWith('/dlna/scpd/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return this.respondText(res, 405, 'Method Not Allowed');
      const file = pathname.slice('/dlna/scpd/'.length);
      const scpd = file === 'AVTransport.xml' ? AVT_SCPD : file === 'RenderingControl.xml' ? RCS_SCPD : file === 'ConnectionManager.xml' ? CM_SCPD : null;
      if (!scpd) return this.respondText(res, 404, 'Not Found');
      return this.respondXml(res, 200, scpd, req.method === 'HEAD');
    }

    if (pathname.startsWith('/dlna/control/')) {
      if (req.method !== 'POST') return this.respondText(res, 405, 'Method Not Allowed');
      if (!this.controlLimiter.hit(remoteIp).allowed) return this.respondText(res, 429, 'Too Many Requests');
      const service = this.serviceFromPath(pathname, 'control');
      if (!service) return this.respondText(res, 404, 'Not Found');
      return this.handleControl(req, res, service, remoteIp);
    }

    if (pathname.startsWith('/dlna/event/')) {
      const service = this.serviceFromPath(pathname, 'event');
      if (!service) return this.respondText(res, 404, 'Not Found');
      if (req.method === 'SUBSCRIBE') return this.handleSubscribe(req, res, service, remoteIp);
      if (req.method === 'UNSUBSCRIBE') return this.handleUnsubscribe(req, res);
      return this.respondText(res, 405, 'Method Not Allowed');
    }

    this.respondText(res, 404, 'Not Found');
  }

  private serviceFromPath(pathname: string, kind: 'control' | 'event'): DlnaService | null {
    for (const service of Object.keys(SERVICE_TYPES) as DlnaService[]) {
      if (pathname === `/dlna/${SERVICE_PATHS[service][kind]}`) return service;
    }
    return null;
  }

  private async handleControl(req: IncomingMessage, res: ServerResponse, service: DlnaService, remoteIp: string): Promise<void> {
    const body = await this.readBody(req, MAX_SOAP_BYTES);
    if (body === null) {
      this.respondXml(res, 500, soapFault(new UpnpError(402, 'Invalid Args')));
      return;
    }
    let parsed: ParsedSoap;
    try {
      parsed = parseSoapRequest(body, header(req.headers['soapaction']));
    } catch (error) {
      this.respondXml(res, 500, soapFault(error instanceof UpnpError ? error : new UpnpError(402, 'Invalid Args')));
      return;
    }
    try {
      const args = this.dispatch(service, parsed.action, parsed.args, remoteIp);
      this.respondXml(res, 200, soapEnvelope(service, parsed.action, args));
      this.ctx.logger.debug('dlna.action', { service, action: parsed.action, ip: remoteIp });
      this.publishChanges();
    } catch (error) {
      if (error instanceof PresentationError) {
        this.respondXml(res, 500, soapFault(new UpnpError(701, error.message)));
        return;
      }
      if (error instanceof UpnpError) {
        this.respondXml(res, 500, soapFault(error));
        return;
      }
      this.ctx.logger.warn('dlna.action_failed', { service, action: parsed.action, error: String(error) });
      this.respondXml(res, 500, soapFault(new UpnpError(501, 'Action Failed')));
    }
  }

  private dispatch(service: DlnaService, action: string, args: Record<string, string>, remoteIp: string): Record<string, string | number> {
    if (service === 'ConnectionManager') return this.connectionManager(action, args);
    this.requireInstance(args);
    if (service === 'AVTransport') return this.avTransport(action, args, remoteIp);
    return this.renderingControl(action, args);
  }

  private requireInstance(args: Record<string, string>): void {
    const instance = args['InstanceID'] ?? '0';
    if (instance !== '0') throw new UpnpError(718, 'Invalid InstanceID');
  }

  private avTransport(action: string, args: Record<string, string>, remoteIp: string): Record<string, string | number> {
    const snapshot = this.mediaSnapshot();
    switch (action) {
      case 'SetAVTransportURI': {
        const uri = (args['CurrentURI'] ?? '').trim();
        if (!uri) {
          if (snapshot.media?.source === 'dlna') this.ctx.presentation.stop();
          return {};
        }
        if (!isSafeRemoteUrl(uri)) throw new UpnpError(716, 'Resource not found');
        const info = parseDidl(args['CurrentURIMetaData'], uri);
        let baseName = '';
        try {
          baseName = decodeURIComponent(new URL(uri).pathname.split('/').filter(Boolean).pop() ?? '');
        } catch {
          baseName = '';
        }
        const fallbackTitle = baseName ? sanitizeFileName(baseName) : 'DLNA 媒体';
        const fallbackMime = normalizeMime('', baseName || uri);
        const source = itemFromDidl(info, {
          url: uri,
          title: fallbackTitle,
          mime: fallbackMime,
          kind: kindFromNameOrMime(fallbackTitle, fallbackMime),
          sourceLabel: remoteIp,
        });
        const item = this.ctx.media.addRemoteItem({
          url: source.url,
          title: source.title,
          mime: source.mime,
          kind: source.kind,
          source: 'dlna',
          sourceLabel: remoteIp,
          durationSec: source.durationSec,
          size: source.size,
        });
        try {
          this.ctx.presentation.setDlnaUri(item);
        } catch (error) {
          if (error instanceof PresentationError) throw new UpnpError(701, error.message);
          throw error;
        }
        this.ctx.logger.info('dlna.set_uri', { title: item.name, mime: item.mime, ip: remoteIp });
        return {};
      }
      case 'SetNextAVTransportURI':
        throw new UpnpError(701, 'Transition not available');
      case 'GetMediaInfo': {
        const next = snapshot.media && snapshot.media.index < snapshot.media.items.length - 1 ? snapshot.media.items[snapshot.media.index + 1] ?? null : null;
        return {
          NrTracks: snapshot.trackCount,
          MediaDuration: snapshot.duration,
          CurrentURI: snapshot.uri,
          CurrentURIMetaData: snapshot.metadata,
          NextURI: next?.url ?? '',
          NextURIMetaData: next ? buildDidl(next) : '',
          PlayMedium: snapshot.item ? 'NETWORK' : 'NONE',
          RecordMedium: 'NOT_IMPLEMENTED',
          WriteStatus: 'NOT_IMPLEMENTED',
        };
      }
      case 'GetTransportInfo':
        return { CurrentTransportState: snapshot.transport, CurrentTransportStatus: 'OK', CurrentSpeed: '1' };
      case 'GetPositionInfo':
        return {
          Track: snapshot.track,
          TrackDuration: snapshot.duration,
          TrackMetaData: snapshot.metadata,
          TrackURI: snapshot.uri,
          RelTime: formatHms(this.ctx.presentation.currentPosition()),
          AbsTime: formatHms(this.ctx.presentation.currentPosition()),
          RelCount: '2147483647',
          AbsCount: '2147483647',
        };
      case 'GetDeviceCapabilities':
        return { PlayMedia: 'NETWORK', RecMedia: 'NOT_IMPLEMENTED', RecQualityModes: 'NOT_IMPLEMENTED' };
      case 'GetTransportSettings':
        return { PlayMode: 'NORMAL', RecQualityMode: 'NOT_IMPLEMENTED' };
      case 'GetCurrentTransportActions':
        return { Actions: snapshot.actions };
      case 'Stop':
        if (snapshot.media) this.ctx.presentation.stop();
        return {};
      case 'Play': {
        const speed = args['Speed'] ?? '1';
        if (speed !== '1' && speed !== '1/1') throw new UpnpError(717, 'Play speed not supported');
        if (!snapshot.media) throw new UpnpError(701, 'No media to play');
        this.ctx.presentation.dlnaPlay();
        return {};
      }
      case 'Pause':
        this.ctx.presentation.dlnaPause();
        return {};
      case 'Seek': {
        const unit = args['Unit'] ?? '';
        if (unit !== 'REL_TIME' && unit !== 'ABS_TIME') throw new UpnpError(710, 'Seek mode not supported');
        const target = parseDurationHms(args['Target']);
        if (target === null) throw new UpnpError(711, 'Invalid seek target');
        this.ctx.presentation.dlnaSeek(target);
        return {};
      }
      case 'Next':
        this.ctx.presentation.dlnaNext();
        return {};
      case 'Previous':
        this.ctx.presentation.dlnaPrevious();
        return {};
      default:
        throw new UpnpError(401, 'Invalid Action');
    }
  }

  private renderingControl(action: string, args: Record<string, string>): Record<string, string | number> {
    const channel = args['Channel'] ?? 'Master';
    if (channel !== 'Master' && action !== 'ListPresets' && action !== 'SelectPreset') {
      throw new UpnpError(402, 'Invalid Args');
    }
    const snapshot = this.mediaSnapshot();
    switch (action) {
      case 'GetVolume':
        return { CurrentVolume: Math.round(snapshot.volume * 100) };
      case 'SetVolume': {
        const raw = Number(args['DesiredVolume']);
        if (!Number.isFinite(raw)) throw new UpnpError(402, 'Invalid Args');
        this.ctx.presentation.setVolumePercent(Math.min(100, Math.max(0, raw)));
        return {};
      }
      case 'GetMute':
        return { CurrentMute: snapshot.muted ? 1 : 0 };
      case 'SetMute': {
        const raw = (args['DesiredMute'] ?? '').toLowerCase();
        const muted = raw === '1' || raw === 'true' || raw === 'yes';
        this.ctx.presentation.setMuted(muted);
        return {};
      }
      case 'ListPresets':
        return { CurrentPresetNameList: 'FactoryDefaults' };
      case 'SelectPreset':
        if ((args['PresetName'] ?? '') !== 'FactoryDefaults') throw new UpnpError(701, 'Invalid Name');
        this.ctx.presentation.setVolumePercent(85);
        this.ctx.presentation.setMuted(false);
        return {};
      default:
        throw new UpnpError(401, 'Invalid Action');
    }
  }

  private connectionManager(action: string, args: Record<string, string>): Record<string, string | number> {
    switch (action) {
      case 'GetProtocolInfo':
        return { Source: '', Sink: SINK_PROTOCOL_INFO };
      case 'GetCurrentConnectionIDs':
        return { ConnectionIDs: '0' };
      case 'GetCurrentConnectionInfo': {
        if ((args['ConnectionID'] ?? '0') !== '0') throw new UpnpError(706, 'No such connection');
        return {
          RcsID: 0,
          AVTransportID: 0,
          ProtocolInfo: '',
          PeerConnectionManager: '',
          PeerConnectionID: -1,
          Direction: 'Input',
          Status: 'OK',
        };
      }
      case 'PrepareForConnection':
        return { ConnectionID: 0, AVTransportID: 0, RcsID: 0 };
      case 'ConnectionComplete':
        return {};
      default:
        throw new UpnpError(401, 'Invalid Action');
    }
  }

  private handleSubscribe(req: IncomingMessage, res: ServerResponse, service: DlnaService, remoteIp: string): void {
    this.ctx.logger.debug('dlna.subscribe_request', {
      service,
      remoteIp,
      nt: req.headers['nt'] ?? null,
      callback: req.headers['callback'] ?? null,
      sid: req.headers['sid'] ?? null,
    });
    const sidHeader = header(req.headers['sid']);
    const reject = (reason: string, status = 412): void => {
      this.ctx.logger.warn('dlna.subscribe_rejected', { reason, status, service, remoteIp });
      this.respondText(res, status, 'Precondition Failed');
    };
    if (sidHeader) {
      const existing = this.subscribers.get(sidHeader);
      if (!existing || existing.service !== service) return reject('unknown-sid');
      existing.expiresAt = Date.now() + this.timeoutMs(req);
      this.writeSubscribeHeaders(res, existing.sid, Math.round((existing.expiresAt - Date.now()) / 1000));
      return;
    }
    const nt = header(req.headers['nt']).toLowerCase();
    if (nt !== 'upnp:event') return reject('bad-nt');
    const callbackRaw = header(req.headers['callback']);
    const callback = /<([^>]+)>/.exec(callbackRaw)?.[1]?.trim() ?? '';
    let parsed: URL;
    try {
      parsed = new URL(callback);
    } catch {
      return reject('bad-callback-url');
    }
    if (parsed.protocol !== 'http:' || !parsed.hostname || parsed.port === '1900') {
      return reject('callback-protocol');
    }
    const callbackHost = parsed.hostname.replace(/^\[|\]$/g, '');
    if (!(callbackHost === remoteIp)) return reject('callback-host', 403);
    const sid = `uuid:${randomUUID()}`;
    const sub: Subscription = {
      sid,
      service,
      callback: parsed.toString(),
      remoteIp,
      expiresAt: Date.now() + this.timeoutMs(req),
      seq: 0,
      failures: 0,
    };
    this.subscribers.set(sid, sub);
    this.ctx.logger.debug('dlna.subscribe', { service, ip: remoteIp, sid });
    this.writeSubscribeHeaders(res, sid, Math.round((sub.expiresAt - Date.now()) / 1000));
    setTimeout(() => this.notifyOne(sub), 0).unref();
  }

  private handleUnsubscribe(req: IncomingMessage, res: ServerResponse): void {
    const sid = header(req.headers['sid']);
    if (!sid || !this.subscribers.delete(sid)) return this.respondText(res, 412, 'Precondition Failed');
    res.writeHead(200);
    res.end();
  }

  private timeoutMs(req: IncomingMessage): number {
    const timeout = header(req.headers['timeout']);
    const seconds = /Second-(\d+)/i.exec(timeout)?.[1];
    const value = seconds ? Number(seconds) : 1800;
    return Math.max(120, Math.min(3600, Number.isFinite(value) ? value : 1800)) * 1000;
  }

  private writeSubscribeHeaders(res: ServerResponse, sid: string, timeoutSec: number): void {
    res.writeHead(200, {
      SID: sid,
      TIMEOUT: `Second-${timeoutSec}`,
      SERVER: this.serverHeader(),
      'Content-Length': 0,
    });
    res.end();
  }

  private tick(): void {
    if (!this.active) return;
    const now = Date.now();
    for (const [sid, sub] of this.subscribers) {
      if (sub.expiresAt < now) this.subscribers.delete(sid);
    }
    this.publishChanges();
  }

  private publishChanges(force = false): void {
    if (!this.active) return;
    const snapshot = this.mediaSnapshot();
    const avtSignature = `${snapshot.transport}|${snapshot.uri}|${snapshot.track}|${snapshot.trackCount}|${snapshot.duration}|${snapshot.actions}`;
    const rcsSignature = `${Math.round(snapshot.volume * 100)}|${snapshot.muted ? 1 : 0}`;
    const avtChanged = avtSignature !== this.lastAvtSignature;
    const rcsChanged = rcsSignature !== this.lastRcsSignature;
    this.lastAvtSignature = avtSignature;
    this.lastRcsSignature = rcsSignature;
    if (!avtChanged && !rcsChanged && !force) return;
    for (const sub of this.subscribers.values()) {
      if (sub.service === 'AVTransport' && (force || avtChanged)) this.notifyOne(sub, snapshot);
      if (sub.service === 'RenderingControl' && (force || rcsChanged)) this.notifyOne(sub, snapshot);
    }
  }

  private notifyOne(sub: Subscription, provided?: MediaSnapshot): void {
    if (!this.active || !this.subscribers.has(sub.sid)) return;
    const snapshot = provided ?? this.mediaSnapshot();
    let body: string;
    if (sub.service === 'AVTransport') {
      const event = buildAvtLastChange({
        transportState: snapshot.transport,
        actions: snapshot.actions,
        uri: snapshot.uri,
        metadata: snapshot.metadata,
        duration: snapshot.duration,
        track: snapshot.track,
        trackCount: snapshot.trackCount,
        trackUri: snapshot.uri,
      });
      body = propertySet(`<LastChange>${escapeXml(event)}</LastChange>`);
    } else if (sub.service === 'RenderingControl') {
      body = propertySet(`<LastChange>${escapeXml(buildRcsLastChange(snapshot.volume * 100, snapshot.muted))}</LastChange>`);
    } else {
      body = propertySet('');
    }
    const url = new URL(sub.callback);
    const seq = sub.seq++;
    const request = http.request(
      {
        hostname: url.hostname,
        port: url.port || 80,
        path: `${url.pathname}${url.search}`,
        method: 'NOTIFY',
        headers: {
          'Content-Type': 'text/xml; charset="utf-8"',
          'Content-Length': Buffer.byteLength(body),
          NT: 'upnp:event',
          NTS: 'upnp:propchange',
          SID: sub.sid,
          SEQ: String(seq),
        },
        timeout: CALLBACK_TIMEOUT_MS,
      },
      (response) => {
        response.resume();
        if (response.statusCode && response.statusCode >= 400) {
          sub.failures += 1;
          if (sub.failures >= 2) this.subscribers.delete(sub.sid);
        }
      },
    );
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', () => {
      sub.failures += 1;
      if (sub.failures >= 2) this.subscribers.delete(sub.sid);
    });
    request.end(body);
  }

  private mediaSnapshot(): MediaSnapshot {
    const { media } = this.ctx.presentation.snapshot();
    const item = media?.items[media.index] ?? null;
    const trackCount = media?.items.length ?? 0;
    const duration = media && media.durationSec > 0 ? formatDidlDuration(media.durationSec) : '0:00:00';
    const transport = transportStateFor(media?.state ?? 'idle', Boolean(media));
    const canNext = trackCount > 1;
    const canSeek = Boolean(media?.canSeek) && item?.kind !== 'image';
    const actions = !media
      ? ''
      : [
          media.state === 'playing' ? 'Pause' : 'Play',
          'Stop',
          canSeek ? 'Seek' : null,
          canNext ? 'Next' : null,
          canNext ? 'Previous' : null,
        ]
          .filter(Boolean)
          .join(',');
    return {
      media,
      item,
      transport,
      actions,
      duration,
      uri: item?.url ?? '',
      metadata: item ? buildDidl(item) : '',
      track: media ? media.index + 1 : 0,
      trackCount,
      volume: media?.volume ?? this.ctx.store.get().settings.volume,
      muted: media?.muted ?? this.ctx.store.get().settings.muted,
    };
  }

  private openSocket(): void {
    if (this.socket) return;
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    socket.on('message', (message, rinfo) => this.onDatagram(message, rinfo));
    socket.on('error', (error) => {
      this.ctx.logger.warn('dlna.socket_error', { error: String(error) });
      if (!this.active) this.error = `SSDP 套接字错误：${error.message}`;
    });
    this.socket = socket;
  }

  private bind(): Promise<void> {
    const socket = this.socket;
    if (!socket) return Promise.reject(new Error('socket not created'));
    return new Promise<void>((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException) => {
        socket.off('listening', onListening);
        try {
          socket.close();
        } catch {
          // already closed
        }
        this.socket = null;
        this.error = error.code === 'EADDRINUSE' ? 'SSDP 端口 1900 已被占用（可能运行着其他 DLNA 服务）' : `SSDP 启动失败：${error.message}`;
        reject(error);
      };
      const onListening = () => {
        socket.off('error', onError);
        try {
          socket.setMulticastTTL(2);
          socket.setMulticastLoopback(true);
          for (const iface of detectLanInterfaces()) {
            if (!iface.private) continue;
            try {
              socket.addMembership(SSDP_ADDRESS, iface.address);
            } catch (error) {
              this.ctx.logger.debug('dlna.membership_failed', { iface: iface.name, error: String(error) });
            }
          }
        } catch (error) {
          this.ctx.logger.debug('dlna.socket_options_failed', { error: String(error) });
        }
        resolve();
      };
      socket.once('error', onError);
      socket.once('listening', onListening);
      try {
        socket.bind({ port: SSDP_PORT, address: '0.0.0.0', exclusive: false });
      } catch (error) {
        onError(error as NodeJS.ErrnoException);
      }
    });
  }

  private onDatagram(message: Buffer, rinfo: dgram.RemoteInfo): void {
    if (!this.active) return;
    const remote = normalizeRemoteAddress(rinfo.address);
    if (!(remote === '::1' || isPrivateIPv4(remote))) return;
    const text = message.toString('utf8', 0, Math.min(message.length, 4096));
    if (!/^M-SEARCH \* HTTP\/1\.1/i.test(text)) return;
    const headers = parseSsdpHeaders(text);
    if ((headers['man'] ?? '').replace(/"/g, '').toLowerCase() !== 'ssdp:discover') return;
    const st = headers['st'] ?? '';
    const targets = this.targets();
    const matched = st === 'ssdp:all' ? targets : targets.filter((target) => target.st === st);
    if (matched.length === 0) return;
    const mx = Math.max(0, Math.min(5, Number(headers['mx'] ?? '1') || 1));
    const delay = Math.floor(Math.random() * Math.min(mx, 3) * 1000);
    const timer = setTimeout(() => {
      const location = this.locationFor(remote);
      for (const target of matched) {
        const response = [
          'HTTP/1.1 200 OK',
          `CACHE-CONTROL: max-age=${CACHE_MAX_AGE}`,
          `DATE: ${new Date().toUTCString()}`,
          'EXT:',
          `LOCATION: ${location}`,
          `SERVER: ${this.serverHeader()}`,
          `ST: ${target.st}`,
          `USN: ${target.usn}`,
          `BOOTID.UPNP.ORG: ${this.bootId}`,
          'CONFIGID.UPNP.ORG: 1',
          '',
          '',
        ].join('\r\n');
        this.sendDatagram(response, rinfo.port, rinfo.address);
      }
    }, delay);
    timer.unref();
  }

  private scheduleAnnounce(): void {
    if (this.announceTimer) clearInterval(this.announceTimer);
    this.announceTimer = setInterval(() => this.announce('ssdp:alive'), ANNOUNCE_INTERVAL_MS);
    this.announceTimer.unref();
  }

  private announce(kind: 'ssdp:alive' | 'ssdp:byebye'): void {
    const socket = this.socket;
    if (!socket) return;
    const ifaces = detectLanInterfaces().filter((iface) => iface.private);
    const interfaces = ifaces.length > 0 ? ifaces : [{ address: this.ctx.getAddress() ?? '' }];
    for (const iface of interfaces) {
      if (!iface.address) continue;
      try {
        socket.setMulticastInterface(iface.address);
      } catch {
        // interface may not support multicast
      }
      const location = `http://${iface.address}:${this.ctx.getHttpPort()}/dlna/description.xml`;
      for (const target of this.targets()) {
        const lines = [
          'NOTIFY * HTTP/1.1',
          `HOST: ${SSDP_ADDRESS}:${SSDP_PORT}`,
          `NT: ${target.st}`,
          `NTS: ${kind}`,
          `USN: ${target.usn}`,
          `SERVER: ${this.serverHeader()}`,
          `BOOTID.UPNP.ORG: ${this.bootId}`,
          'CONFIGID.UPNP.ORG: 1',
        ];
        if (kind === 'ssdp:alive') {
          lines.splice(2, 0, `CACHE-CONTROL: max-age=${CACHE_MAX_AGE}`, `LOCATION: ${location}`);
        }
        lines.push('', '');
        this.sendDatagram(lines.join('\r\n'));
      }
    }
    try {
      socket.setMulticastInterface(this.ctx.getAddress() ?? '0.0.0.0');
    } catch {
      // ignore
    }
  }

  private targets(): SsdpTarget[] {
    const uuid = `uuid:${this.uuid}`;
    return [
      { st: 'upnp:rootdevice', usn: `${uuid}::upnp:rootdevice` },
      { st: uuid, usn: uuid },
      { st: 'urn:schemas-upnp-org:device:MediaRenderer:1', usn: `${uuid}::urn:schemas-upnp-org:device:MediaRenderer:1` },
      ...(Object.values(SERVICE_TYPES).map((type) => ({ st: type, usn: `${uuid}::${type}` }))),
    ];
  }

  private sendDatagram(payload: string, port = SSDP_PORT, address = SSDP_ADDRESS): void {
    const socket = this.socket;
    if (!socket) return;
    try {
      socket.send(Buffer.from(payload, 'utf8'), port, address, () => undefined);
    } catch {
      // socket closed
    }
  }

  private location(): string {
    const address = this.ctx.getAddress() ?? '127.0.0.1';
    return `http://${address}:${this.ctx.getHttpPort()}/dlna/description.xml`;
  }

  private locationFor(peer: string): string {
    const ifaces = detectLanInterfaces().filter((iface) => iface.private);
    const match = ifaces.find((iface) => sameSubnet(iface.address, iface.netmask, peer));
    const address = match?.address ?? this.ctx.getAddress() ?? '127.0.0.1';
    return `http://${address}:${this.ctx.getHttpPort()}/dlna/description.xml`;
  }

  private serverHeader(): string {
    const platform = process.platform === 'win32' ? 'Windows/10.0' : process.platform === 'darwin' ? 'macOS/14.0' : 'Linux/6.0';
    return `${platform} UPnP/1.0 EasyPush/1.0`;
  }

  private readBody(req: IncomingMessage, limit: number): Promise<string | null> {
    return new Promise((resolve) => {
      let settled = false;
      let size = 0;
      const chunks: Buffer[] = [];
      const finish = (value: string | null) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > limit) {
          finish(null);
          req.resume();
          return;
        }
        if (!settled) chunks.push(chunk);
      });
      req.on('end', () => finish(Buffer.concat(chunks).toString('utf8')));
      req.on('error', () => finish(null));
    });
  }

  private respondXml(res: ServerResponse, status: number, xml: string, head = false): void {
    const body = Buffer.from(xml, 'utf8');
    res.writeHead(status, {
      'Content-Type': 'text/xml; charset="utf-8"',
      'Content-Length': body.length,
      'Cache-Control': 'no-cache',
      SERVER: this.serverHeader(),
    });
    if (head) res.end();
    else res.end(body);
  }

  private respondText(res: ServerResponse, status: number, text: string): void {
    if (res.headersSent) return;
    const body = Buffer.from(text, 'utf8');
    res.writeHead(status, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Length': body.length,
    });
    res.end(body);
  }
}

export function createDlnaRenderer(ctx: DlnaContext): DlnaPort {
  return new DlnaRenderer(ctx);
}

function header(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

function parseSsdpHeaders(text: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of text.split(/\r?\n/).slice(1)) {
    const index = line.indexOf(':');
    if (index <= 0) continue;
    headers[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
  }
  return headers;
}

function sameSubnet(a: string, netmask: string, b: string): boolean {
  const ipA = ipv4ToInt(a);
  const ipB = ipv4ToInt(b);
  const mask = ipv4ToInt(netmask);
  if (ipA === null || ipB === null || mask === null) return false;
  return (ipA & mask) === (ipB & mask);
}

function ipv4ToInt(value: string): number | null {
  const parts = value.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return (((parts[0] ?? 0) << 24) | ((parts[1] ?? 0) << 16) | ((parts[2] ?? 0) << 8) | (parts[3] ?? 0)) >>> 0;
}

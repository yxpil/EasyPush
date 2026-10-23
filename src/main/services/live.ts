import type {
  ClientMessage,
  DeviceInfo,
  HistoryEntry,
  IceCandidatePayload,
  LiveSession,
  LiveState,
  LiveStats,
  SdpDescription,
  ServerMessage,
  ToastMessage,
} from '../../shared/types';
import { LIVE_APPROVAL_TTL_MS, LIVE_DISCONNECT_GRACE_MS, LIVE_OFFER_TTL_MS } from '../core/config';
import { randomId } from '../core/ids';
import type { Logger } from '../core/logger';
import type { DeviceRecord, Store } from '../core/store';

export interface LiveSocket {
  send(message: ServerMessage): void;
  close(reason: string): void;
}

export interface LiveRendererPort {
  isReady(): boolean;
  prepareLive(session: LiveSession): void;
  deliverOffer(sessionId: string, sdp: SdpDescription): void;
  deliverIce(sessionId: string, candidate: IceCandidatePayload | null): void;
  stopLive(sessionId: string, reason: string): void;
  commandLive(sessionId: string, action: 'mute' | 'volume', value: number | boolean): void;
}

export interface LiveEvents {
  changed(): void;
  pendingChanged(session: LiveSession | null): void;
  toast(toast: Omit<ToastMessage, 'id'>): void;
  history(entry: HistoryEntry): void;
  liveStarted(session: LiveSession): void;
  liveEnded(): void;
}

interface Connection {
  device: DeviceRecord;
  ip: string;
  socket: LiveSocket;
  sessionId: string | null;
  connectedAt: number;
  lastMessageAt: number;
}

interface ActiveCast {
  session: LiveSession;
  connection: Connection;
  bufferedIce: IceCandidatePayload[];
  disconnectAt: number | null;
  resumeState: LiveState | null;
  bitrateSamples: number[];
  lastStatsSentAt: number;
  offerTimer: NodeJS.Timeout | null;
  connectTimer: NodeJS.Timeout | null;
}

export class LiveService {
  private connections = new Map<string, Connection>();
  private active: ActiveCast | null = null;
  private pending: ActiveCast | null = null;
  private pendingTimer: NodeJS.Timeout | null = null;
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly store: Store,
    private readonly logger: Logger,
    private readonly renderer: LiveRendererPort,
    private readonly events: LiveEvents,
    private readonly clock: () => number = Date.now,
  ) {}

  start(): void {
    this.sweepTimer = setInterval(() => this.tick(), 1000);
    this.sweepTimer.unref();
  }

  stop(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    this.clearTimers();
    this.pending = null;
    this.active = null;
    this.connections.clear();
  }

  attach(device: DeviceRecord, ip: string, socket: LiveSocket): Connection {
    const existing = this.connections.get(device.id);
    if (existing) {
      existing.socket.close('replaced');
    }
    const conn: Connection = {
      device,
      ip,
      socket,
      sessionId: null,
      connectedAt: this.clock(),
      lastMessageAt: this.clock(),
    };
    this.connections.set(device.id, conn);
    this.logger.debug('live.attached', { deviceId: device.id, ip });
    return conn;
  }

  onMessage(conn: Connection, message: ClientMessage): void {
    conn.lastMessageAt = this.clock();
    if (message.type === 'ping') {
      conn.socket.send({ type: 'pong', t: message.t });
      return;
    }
    if (message.type === 'intent') {
      this.handleIntent(conn, message.media, message.audio);
      return;
    }
    if (message.type === 'resume') {
      this.handleResume(conn, message.sessionId);
      return;
    }
    if (message.type === 'offer') {
      this.handleOffer(conn, message.sdp, message.media, message.audio);
      return;
    }
    if (message.type === 'ice') {
      this.handleClientIce(conn, message.candidate);
      return;
    }
    if (message.type === 'end') {
      this.handleClientEnd(conn, message.reason ?? 'ended by sender');
    }
  }

  onClose(conn: Connection): void {
    if (this.connections.get(conn.device.id) === conn) this.connections.delete(conn.device.id);
    if (this.pending?.connection === conn) {
      this.cancelPending('disconnected');
      return;
    }
    const active = this.active;
    if (active?.connection !== conn) return;
    if (active.session.state === 'awaiting-offer' || active.session.state === 'awaiting-approval') {
      this.endActive('disconnected', false);
      return;
    }
    active.resumeState = active.session.state;
    active.session.state = 'disconnected';
    active.disconnectAt = this.clock();
    active.connection.sessionId = null;
    this.events.changed();
    this.logger.info('live.control_disconnected', { sessionId: active.session.id });
  }

  decide(sessionId: string, approve: boolean): void {
    const pending = this.pending;
    if (!pending || pending.session.id !== sessionId) return;
    this.clearPendingTimer();
    if (!approve) {
      pending.session.state = 'rejected';
      pending.session.endedAt = this.clock();
      pending.session.endReason = 'denied';
      pending.connection.socket.send({ type: 'error', code: 'rejected', message: '接收端拒绝了此次投屏' });
      pending.connection.socket.send({ type: 'state', state: 'rejected', reason: 'denied', sessionId: pending.session.id });
      pending.connection.sessionId = null;
      this.pending = null;
      this.events.pendingChanged(null);
      this.events.changed();
      this.logger.info('live.denied', { sessionId });
      return;
    }
    const takeover = pending.session.state === 'awaiting-takeover';
    const oldId = this.active?.session.id ?? null;
    if (takeover && this.active) {
      this.endActive('takeover', true, true);
    }
    pending.session.state = 'awaiting-offer';
    pending.session.approvedAt = this.clock();
    pending.session.takeoverFrom = takeover ? oldId : null;
    pending.connection.sessionId = pending.session.id;
    this.active = pending;
    this.pending = null;
    this.events.pendingChanged(null);
    this.events.liveStarted(pending.session);
    if (!this.renderer.isReady()) {
      this.endActive('renderer-unavailable');
      return;
    }
    this.renderer.prepareLive(pending.session);
    pending.connection.socket.send({ type: 'state', state: 'awaiting-offer', sessionId: pending.session.id });
    pending.connection.socket.send({ type: 'ready', sessionId: pending.session.id });
    this.startOfferTimer(pending);
    this.events.changed();
    this.logger.info('live.approved', { sessionId: pending.session.id, takeover });
  }

  handleRendererState(sessionId: string, state: 'connecting' | 'live' | 'failed', error: string | null, stats: LiveStats | null): void {
    const active = this.active;
    if (!active || active.session.id !== sessionId) return;
    if (state === 'failed') {
      this.endActive(error ?? '连接失败');
      return;
    }
    if (state === 'live') {
      if (active.session.state === 'disconnected') {
        if (stats) this.updateStats(active, stats);
        this.events.changed();
        return;
      }
      if (active.session.state !== 'live') {
        active.session.state = 'live';
        active.session.liveAt = this.clock();
        active.session.approvedAt = active.session.approvedAt ?? this.clock();
        active.connection.socket.send({ type: 'state', state: 'live', sessionId: active.session.id });
        this.logger.info('live.started', { sessionId, device: active.session.deviceName });
        this.events.toast({
          kind: 'success',
          title: '投屏已开始',
          message: `${active.session.deviceName} · ${active.session.media === 'screen' ? '屏幕' : '摄像头'}`,
        });
      }
    } else if (active.session.state === 'awaiting-offer' || active.session.state === 'disconnected') {
      active.session.state = 'connecting';
    }
    if (stats) this.updateStats(active, stats);
    this.events.changed();
  }

  handleRendererSignal(sessionId: string, answer?: SdpDescription, candidate?: IceCandidatePayload | null): void {
    const active = this.active;
    if (!active || active.session.id !== sessionId) return;
    if (answer) {
      active.session.state = active.session.state === 'live' ? 'live' : 'connecting';
      this.clearConnectTimer(active);
      active.connection.socket.send({ type: 'answer', sdp: answer });
      this.startConnectTimer(active);
      this.events.changed();
      return;
    }
    if (candidate !== undefined) {
      active.connection.socket.send({ type: 'ice', candidate });
    }
  }

  handleRendererGone(sessionId: string, reason: string): void {
    const active = this.active;
    if (!active || active.session.id !== sessionId) return;
    this.endActive(reason);
  }

  stopByUser(sessionId: string): void {
    if (this.pending?.session.id === sessionId) {
      this.cancelPending('cancelled');
      return;
    }
    if (this.active?.session.id === sessionId) this.endActive('stopped by receiver');
  }

  setMuted(sessionId: string, muted: boolean): void {
    if (this.active?.session.id === sessionId) {
      this.renderer.commandLive(sessionId, 'mute', muted);
      this.active.connection.socket.send({ type: 'notice', message: muted ? '接收端已静音' : '接收端已取消静音' });
    }
  }

  setVolume(sessionId: string, volume: number): void {
    if (this.active?.session.id === sessionId) {
      this.renderer.commandLive(sessionId, 'volume', volume);
    }
  }

  endForDevice(deviceId: string, reason: string): void {
    if (this.pending?.session.deviceId === deviceId) this.cancelPending(reason);
    if (this.active?.session.deviceId === deviceId) this.endActive(reason);
  }

  shutdown(): void {
    if (this.active) {
      const active = this.active;
      this.endActive('shutdown', true);
      active.connection.socket.close('shutdown');
    }
    if (this.pending) this.cancelPending('shutdown');
    this.stop();
  }

  getSession(): LiveSession | null {
    return this.active?.session ?? null;
  }

  getPending(): LiveSession | null {
    return this.pending?.session ?? null;
  }

  tick(): void {
    const now = this.clock();
    const pending = this.pending;
    if (pending && now - pending.session.createdAt > LIVE_APPROVAL_TTL_MS) {
      this.cancelPending('approval timeout');
      return;
    }
    const active = this.active;
    if (!active) return;
    if (active.disconnectAt && now - active.disconnectAt > LIVE_DISCONNECT_GRACE_MS) {
      this.endActive('control connection lost');
      return;
    }
    if (active.session.state === 'awaiting-offer' && active.session.approvedAt && now - active.session.approvedAt > LIVE_OFFER_TTL_MS) {
      this.endActive('sender did not start media');
      return;
    }
    if (active.session.state === 'connecting' && active.session.offerAt && now - active.session.offerAt > LIVE_OFFER_TTL_MS) {
      this.endActive('connection timeout');
    }
  }

  private handleIntent(conn: Connection, media: 'screen' | 'camera', audio: boolean): void {
    if (!this.store.get().settings.allowLive) {
      conn.socket.send({ type: 'error', code: 'live-disabled', message: '接收端已关闭投屏功能' });
      return;
    }
    if (this.pending) {
      conn.socket.send({ type: 'error', code: 'busy', message: '接收端正在处理另一个投屏请求' });
      return;
    }
    const active = this.active;
    const sameDevice = Boolean(active) && active!.session.deviceId === conn.device.id;
    const takeover = Boolean(active) && !sameDevice;
    const session = this.newSession(conn, media, audio, takeover ? 'awaiting-takeover' : 'awaiting-approval');
    if (takeover && active) session.takeoverFrom = active.session.id;
    const pending: ActiveCast = {
      session,
      connection: conn,
      bufferedIce: [],
      disconnectAt: null,
      resumeState: null,
      bitrateSamples: [],
      lastStatsSentAt: 0,
      offerTimer: null,
      connectTimer: null,
    };
    conn.sessionId = session.id;
    this.pending = pending;
    conn.socket.send({ type: 'state', state: session.state, sessionId: session.id });

    if (sameDevice) {
      this.logger.info('live.replace_same_device', { deviceId: conn.device.id });
      this.endActive('replaced by sender', false, true, false);
      this.promotePending(pending, true);
      return;
    }

    if (this.store.get().settings.autoApprove && !takeover) {
      this.logger.info('live.auto_approved', { deviceId: conn.device.id });
      this.promotePending(pending, false);
      return;
    }

    this.logger.info('live.approval_needed', { deviceId: conn.device.id, takeover });
    this.events.pendingChanged(session);
    this.pendingTimer = setTimeout(() => this.cancelPending('approval timeout'), LIVE_APPROVAL_TTL_MS);
    this.pendingTimer.unref();
    this.events.changed();
  }

  private promotePending(pending: ActiveCast, takeover: boolean): void {
    this.clearPendingTimer();
    pending.session.state = 'awaiting-offer';
    pending.session.approvedAt = this.clock();
    pending.connection.sessionId = pending.session.id;
    this.active = pending;
    this.pending = null;
    this.events.pendingChanged(null);
    this.events.liveStarted(pending.session);
    if (!this.renderer.isReady()) {
      this.endActive('renderer-unavailable');
      return;
    }
    this.renderer.prepareLive(pending.session);
    pending.connection.socket.send({ type: 'state', state: 'awaiting-offer', sessionId: pending.session.id });
    pending.connection.socket.send({ type: 'ready', sessionId: pending.session.id });
    this.startOfferTimer(pending);
    this.events.changed();
    this.logger.info('live.promoted', { sessionId: pending.session.id, takeover });
  }

  private handleOffer(conn: Connection, sdp: SdpDescription, media: 'screen' | 'camera', audio: boolean): void {
    const active = this.active;
    if (!active || active.connection !== conn) {
      conn.socket.send({ type: 'error', code: 'no-session', message: '投屏会话不存在或已结束' });
      return;
    }
    if (active.session.state !== 'awaiting-offer' && active.session.state !== 'connecting') {
      conn.socket.send({ type: 'error', code: 'protocol', message: '当前状态不能发送 SDP' });
      return;
    }
    active.session.offerAt = this.clock();
    active.session.media = media;
    active.session.audio = audio;
    active.session.state = 'connecting';
    this.clearOfferTimer(active);
    this.renderer.deliverOffer(active.session.id, sdp);
    for (const candidate of active.bufferedIce) {
      this.renderer.deliverIce(active.session.id, candidate);
    }
    active.bufferedIce = [];
    this.startConnectTimer(active);
    this.events.changed();
  }

  private handleClientIce(conn: Connection, candidate: IceCandidatePayload | null): void {
    const active = this.active;
    if (!active || active.connection !== conn) return;
    if (active.session.state === 'awaiting-offer') {
      if (candidate && active.bufferedIce.length < 64) active.bufferedIce.push(candidate);
      return;
    }
    this.renderer.deliverIce(active.session.id, candidate);
  }

  private handleClientEnd(conn: Connection, reason: string): void {
    const active = this.active;
    if (active && active.connection === conn) {
      this.endActive(reason);
      return;
    }
    if (this.pending?.connection === conn) this.cancelPending(reason);
  }

  private handleResume(conn: Connection, sessionId: string): void {
    const active = this.active;
    if (!active || active.session.id !== sessionId || active.session.deviceId !== conn.device.id) {
      conn.socket.send({ type: 'error', code: 'no-session', message: '会话已结束，请重新开始投屏' });
      return;
    }
    if (!['live', 'connecting', 'disconnected'].includes(active.session.state)) {
      conn.socket.send({ type: 'error', code: 'no-session', message: '会话已结束，请重新开始投屏' });
      return;
    }
    if (active.connection !== conn) {
      active.connection.socket.close('replaced');
      active.connection = conn;
    }
    conn.sessionId = sessionId;
    const restored = active.resumeState ?? (active.session.state === 'disconnected' ? 'live' : active.session.state);
    active.session.state = restored;
    active.resumeState = null;
    active.disconnectAt = null;
    conn.socket.send({ type: 'state', state: restored, sessionId });
    if (active.session.stats) conn.socket.send({ type: 'stats', stats: active.session.stats });
    this.events.changed();
    this.logger.info('live.resumed', { sessionId });
  }

  private updateStats(active: ActiveCast, stats: LiveStats): void {
    const session = active.session;
    if (!session.firstFrameMs && stats.framesDecoded > 0 && session.offerAt) {
      session.firstFrameMs = Math.max(0, stats.at - session.offerAt);
    }
    session.stats = stats;
    if (stats.bitrateKbps > 0) active.bitrateSamples.push(stats.bitrateKbps);
    if (active.bitrateSamples.length > 120) active.bitrateSamples.shift();
    if (stats.at - active.lastStatsSentAt > 1800) {
      active.lastStatsSentAt = stats.at;
      active.connection.socket.send({ type: 'stats', stats });
    }
  }

  private endActive(reason: string, notify = true, keepStageLive = false, closeSocket = true): void {
    const active = this.active;
    if (!active) return;
    this.clearTimers(active);
    const session = active.session;
    session.state = 'ended';
    session.endedAt = this.clock();
    session.endReason = reason;
    if (notify) {
      active.connection.socket.send({ type: 'ended', reason });
    }
    if (closeSocket) active.connection.socket.close(reason);
    if (active.connection.sessionId === session.id) active.connection.sessionId = null;
    this.renderer.stopLive(session.id, reason);
    if (!keepStageLive) this.events.liveEnded();
    this.events.history(toHistory(session, active.bitrateSamples));
    this.logger.info('live.ended', { sessionId: session.id, reason });
    if (this.active === active) this.active = null;
    this.events.changed();
    if (reason !== 'stopped by receiver' && reason !== 'replaced by sender' && reason !== 'shutdown' && reason !== 'takeover') {
      this.events.toast({
        kind: reason === 'connection timeout' || reason === 'control connection lost' ? 'warn' : 'info',
        title: '投屏已结束',
        message: `${session.deviceName} · ${reason}`,
      });
    }
  }

  private cancelPending(reason: string): void {
    const pending = this.pending;
    if (!pending) return;
    this.clearPendingTimer();
    this.clearTimers(pending);
    pending.session.state = 'rejected';
    pending.session.endedAt = this.clock();
    pending.session.endReason = reason;
    pending.connection.socket.send({ type: 'error', code: 'rejected', message: reason });
    pending.connection.socket.send({ type: 'state', state: 'rejected', reason, sessionId: pending.session.id });
    if (pending.connection.sessionId === pending.session.id) pending.connection.sessionId = null;
    this.pending = null;
    this.events.pendingChanged(null);
    this.events.changed();
    this.logger.info('live.pending_cancelled', { reason });
  }

  private newSession(conn: Connection, media: 'screen' | 'camera', audio: boolean, state: LiveState): LiveSession {
    return {
      id: randomId(12),
      deviceId: conn.device.id,
      deviceName: conn.device.name,
      platform: conn.device.platform,
      ip: conn.ip,
      state,
      media,
      audio,
      createdAt: this.clock(),
      approvedAt: null,
      offerAt: null,
      liveAt: null,
      endedAt: null,
      firstFrameMs: null,
      stats: null,
      endReason: null,
      takeoverFrom: null,
    };
  }

  private startOfferTimer(active: ActiveCast): void {
    this.clearOfferTimer(active);
    active.offerTimer = setTimeout(() => {
      if (this.active === active && active.session.state === 'awaiting-offer') {
        this.endActive('sender did not start media');
      }
    }, LIVE_OFFER_TTL_MS);
    active.offerTimer.unref();
  }

  private startConnectTimer(active: ActiveCast): void {
    this.clearConnectTimer(active);
    active.connectTimer = setTimeout(() => {
      if (this.active === active && active.session.state === 'connecting') {
        this.endActive('connection timeout');
      }
    }, LIVE_OFFER_TTL_MS);
    active.connectTimer.unref();
  }

  private clearTimers(active?: ActiveCast): void {
    if (active) {
      this.clearOfferTimer(active);
      this.clearConnectTimer(active);
    } else {
      this.clearPendingTimer();
    }
  }

  private clearOfferTimer(active: ActiveCast): void {
    if (active.offerTimer) clearTimeout(active.offerTimer);
    active.offerTimer = null;
  }

  private clearConnectTimer(active: ActiveCast): void {
    if (active.connectTimer) clearTimeout(active.connectTimer);
    active.connectTimer = null;
  }

  private clearPendingTimer(): void {
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    this.pendingTimer = null;
  }
}

function toHistory(session: LiveSession, samples: number[]): HistoryEntry {
  const endedAt = session.endedAt ?? Date.now();
  const avg = samples.length > 0 ? samples.reduce((sum, value) => sum + value, 0) / samples.length : null;
  return {
    id: session.id,
    kind: 'live',
    protocol: 'webrtc',
    title: session.media === 'screen' ? '屏幕投屏' : session.media === 'camera' ? '摄像头投屏' : '实时投屏',
    deviceName: session.deviceName,
    platform: session.platform,
    sourceIp: session.ip,
    startedAt: session.approvedAt ?? session.createdAt,
    endedAt,
    durationSec: Math.max(0, Math.round((endedAt - (session.approvedAt ?? session.createdAt)) / 1000)),
    width: session.stats?.width ?? null,
    height: session.stats?.height ?? null,
    codec: session.stats?.codec ?? null,
    avgBitrateKbps: avg === null ? null : Math.round(avg),
    endReason: session.endReason ?? 'ended',
  };
}

export function deviceDisplay(device: DeviceInfo | DeviceRecord): string {
  return `${device.name} (${device.platform})`;
}

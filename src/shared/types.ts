export const PROTOCOL_VERSION = 1;
export const APP_NAME = 'EasyPush';
export const SESSION_COOKIE = 'ep_session';
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_LIVE_SESSIONS = 1;

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type Platform = 'ios' | 'android' | 'windows' | 'macos' | 'linux' | 'other';
export type LiveState =
  | 'idle'
  | 'awaiting-approval'
  | 'awaiting-takeover'
  | 'awaiting-offer'
  | 'connecting'
  | 'live'
  | 'disconnected'
  | 'ended'
  | 'rejected'
  | 'failed';
export type LiveMedia = 'screen' | 'camera' | 'unknown';
export type MediaKind = 'image' | 'video' | 'audio';
export type MediaSource = 'upload' | 'local' | 'url' | 'dlna';
export type MediaState = 'idle' | 'loading' | 'playing' | 'paused' | 'ended' | 'error';

export interface Settings {
  schema: number;
  deviceName: string;
  httpPort: number;
  httpsPort: number;
  primaryAddress: string | null;
  autoApprove: boolean;
  allowDlna: boolean;
  allowLive: boolean;
  closeToTray: boolean;
  launchAtLogin: boolean;
  volume: number;
  muted: boolean;
  imageSlideMs: number;
  logLevel: LogLevel;
}

export interface DeviceInfo {
  id: string;
  name: string;
  platform: Platform;
  userAgent: string;
  ip: string;
  firstSeenAt: number;
  lastSeenAt: number;
  remembered: boolean;
  blocked: boolean;
}

export interface PairingRequest {
  id: string;
  method: 'ticket' | 'code';
  deviceName: string;
  platform: Platform;
  ip: string;
  createdAt: number;
  expiresAt: number;
}

export interface LiveStats {
  at: number;
  width: number;
  height: number;
  fps: number;
  bitrateKbps: number;
  rttMs: number | null;
  jitterMs: number;
  packetsLost: number;
  bytesReceived: number;
  framesDecoded: number;
  codec: string;
  audioCodec: string | null;
  jitterBufferMs: number | null;
}

export interface LiveSession {
  id: string;
  deviceId: string;
  deviceName: string;
  platform: Platform;
  ip: string;
  state: LiveState;
  media: LiveMedia;
  audio: boolean;
  createdAt: number;
  approvedAt: number | null;
  offerAt: number | null;
  liveAt: number | null;
  endedAt: number | null;
  firstFrameMs: number | null;
  stats: LiveStats | null;
  endReason: string | null;
  takeoverFrom: string | null;
}

export interface MediaItem {
  id: string;
  kind: MediaKind;
  name: string;
  mime: string;
  size: number | null;
  url: string;
  source: MediaSource;
  sourceLabel: string;
  addedAt: number;
  durationSec: number | null;
}

export interface MediaSession {
  id: string;
  source: MediaSource;
  items: MediaItem[];
  index: number;
  state: MediaState;
  positionSec: number;
  durationSec: number;
  volume: number;
  muted: boolean;
  autoplayImages: boolean;
  error: string | null;
  startedAt: number;
  updatedAt: number;
  sourceIp: string | null;
  width: number | null;
  height: number | null;
  canSeek: boolean;
}

export interface Presentation {
  mode: 'idle' | 'live' | 'media';
  liveSessionId: string | null;
  mediaSessionId: string | null;
}

export interface AddressInfo {
  address: string;
  iface: string;
  url: string;
  httpsUrl: string | null;
  primary: boolean;
  virtual: boolean;
}

export interface DlnaStatus {
  enabled: boolean;
  active: boolean;
  port: number;
  friendlyName: string;
  error: string | null;
  location: string | null;
}

export interface FirewallStatus {
  networkProfile: 'private' | 'public' | 'domain' | 'unknown';
  warning: string | null;
}

export interface ServerInfo {
  name: string;
  version: string;
  protocolVersion: number;
  startedAt: number;
  httpPort: number;
  httpsPort: number;
  httpsEnabled: boolean;
  addresses: AddressInfo[];
  primaryUrl: string | null;
  primaryHttpsUrl: string | null;
  caFingerprint: string | null;
  caUrl: string | null;
  caInstalledHint: string;
  dlna: DlnaStatus;
  firewall: FirewallStatus;
  dataDir: string;
  uploadsDir: string;
  electron: string;
  chrome: string;
  node: string;
}

export interface ConnectInfo {
  ticket: string;
  ticketExpiresAt: number;
  code: string;
  codeExpiresAt: number;
  httpUrl: string | null;
  httpsUrl: string | null;
  qrDataUrl: string | null;
  qrSecureDataUrl: string | null;
  caUrl: string | null;
  autoApprove: boolean;
}

export interface HistoryEntry {
  id: string;
  kind: 'live' | 'media';
  protocol: 'webrtc' | 'dlna' | 'upload' | 'url' | 'local';
  title: string;
  deviceName: string | null;
  platform: Platform | null;
  sourceIp: string | null;
  startedAt: number;
  endedAt: number;
  durationSec: number;
  width: number | null;
  height: number | null;
  codec: string | null;
  avgBitrateKbps: number | null;
  endReason: string;
}

export interface AppSnapshot {
  revision: number;
  server: ServerInfo;
  settings: Settings;
  connect: ConnectInfo;
  devices: DeviceInfo[];
  live: LiveSession | null;
  livePending: LiveSession | null;
  media: MediaSession | null;
  presentation: Presentation;
  pairing: PairingRequest | null;
  history: HistoryEntry[];
  uptimeSec: number;
}

export interface ToastMessage {
  id: string;
  kind: 'info' | 'success' | 'warn' | 'error';
  title: string;
  message?: string;
}

export interface MediaStateReport {
  sessionId: string;
  state: MediaState;
  positionSec: number;
  durationSec: number;
  volume: number;
  muted: boolean;
  index: number;
  error: string | null;
  canSeek: boolean;
  width: number | null;
  height: number | null;
}

export interface LiveStateReport {
  sessionId: string;
  state: 'connecting' | 'live' | 'failed';
  error: string | null;
  stats: LiveStats | null;
}

export interface SdpDescription {
  type: 'offer' | 'answer';
  sdp: string;
}

export interface IceCandidatePayload {
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
  usernameFragment?: string | null;
}

export type ClientMessage =
  | { type: 'intent'; media: Exclude<LiveMedia, 'unknown'>; audio: boolean }
  | { type: 'resume'; sessionId: string }
  | { type: 'offer'; sdp: SdpDescription; media: Exclude<LiveMedia, 'unknown'>; audio: boolean }
  | { type: 'ice'; candidate: IceCandidatePayload | null }
  | { type: 'end'; reason?: string }
  | { type: 'ping'; t: number };

export type ServerMessage =
  | {
      type: 'hello';
      protocolVersion: number;
      receiverName: string;
      deviceName: string;
      sessionId: string | null;
      state: LiveState;
      secure: boolean;
    }
  | { type: 'state'; state: LiveState; reason?: string; sessionId?: string }
  | { type: 'ready'; sessionId?: string }
  | { type: 'answer'; sdp: SdpDescription }
  | { type: 'ice'; candidate: IceCandidatePayload | null }
  | { type: 'stats'; stats: LiveStats }
  | { type: 'notice'; message: string }
  | { type: 'error'; code: string; message: string }
  | { type: 'pong'; t: number }
  | { type: 'ended'; reason: string };

export interface DeviceRegistration {
  deviceName: string;
  platform?: Platform;
}

export interface PairStartResponse {
  status: 'pending' | 'approved' | 'denied' | 'expired';
  requestId?: string;
  device?: DeviceInfo;
  deviceSecret?: string | null;
  error?: { code: string; message: string };
}

export interface PairStatusResponse extends PairStartResponse {
  expiresAt?: number;
}

export interface ServerHealth {
  ok: true;
  name: string;
  version: string;
  protocolVersion: number;
  deviceName: string;
  secure: boolean;
  allowLive: boolean;
  allowDlna: boolean;
  uptimeSec: number;
  httpPort: number;
  httpsPort: number | null;
}

export interface ReceiverSummary {
  name: string;
  version: string;
  secure: boolean;
  allowLive: boolean;
}

export interface MeResponse {
  device: DeviceInfo;
  receiver: ReceiverSummary;
  limits: { maxUploadBytes: number };
}

export interface UploadResponse {
  item: MediaItem;
  queued: boolean;
  queueLength: number;
  appended: boolean;
}

export interface DesktopApi {
  getSnapshot(): Promise<AppSnapshot>;
  getHistory(): Promise<HistoryEntry[]>;
  getLogs(): Promise<string[]>;
  reportReady(): void;
  onSnapshot(cb: (snapshot: AppSnapshot) => void): () => void;
  onToast(cb: (toast: ToastMessage) => void): () => void;
  onLivePrepare(cb: (session: LiveSession) => void): () => void;
  onLiveOffer(cb: (payload: { sessionId: string; sdp: SdpDescription }) => void): () => void;
  onLiveIce(cb: (payload: { sessionId: string; candidate: IceCandidatePayload | null }) => void): () => void;
  onLiveStop(cb: (payload: { sessionId: string; reason: string }) => void): () => void;
  onLiveNotice(cb: (payload: { sessionId: string; message: string }) => void): () => void;
  onLiveCommand(cb: (payload: { sessionId: string; action: 'mute' | 'volume'; value: number | boolean }) => void): () => void;
  onMediaLoad(cb: (payload: { session: MediaSession; autoplay: boolean }) => void): () => void;
  onMediaSync(cb: (payload: { session: MediaSession }) => void): () => void;
  onMediaCommand(
    cb: (payload: {
      sessionId: string;
      command:
        | 'play'
        | 'pause'
        | 'seek'
        | 'stop'
        | 'next'
        | 'previous'
        | 'volume'
        | 'mute'
        | 'autoplay-images';
      value?: number | boolean;
    }) => void,
  ): () => void;
  approvePairing(requestId: string, remember: boolean): Promise<void>;
  denyPairing(requestId: string): Promise<void>;
  approveLive(sessionId: string): Promise<void>;
  denyLive(sessionId: string): Promise<void>;
  stopLive(sessionId: string): Promise<void>;
  setLiveMuted(sessionId: string, muted: boolean): Promise<void>;
  setLiveVolume(sessionId: string, volume: number): Promise<void>;
  mediaCommand(
    command:
      | 'play'
      | 'pause'
      | 'stop'
      | 'next'
      | 'previous'
      | 'seek'
      | 'volume'
      | 'mute'
      | 'autoplay-images'
      | 'play-item'
      | 'stop-item',
    value?: number | boolean | string,
  ): Promise<void>;
  updateSettings(patch: Partial<Settings>): Promise<Settings>;
  revokeDevice(deviceId: string): Promise<void>;
  refreshConnect(): Promise<ConnectInfo>;
  addLocalFiles(paths: string[]): Promise<number>;
  addUrl(url: string): Promise<void>;
  reportLiveState(report: LiveStateReport): void;
  reportLiveSignal(payload: { sessionId: string; answer?: SdpDescription; candidate?: IceCandidatePayload | null }): void;
  reportLiveGone(payload: { sessionId: string; reason: string }): void;
  reportMediaState(report: MediaStateReport): void;
  reportMediaGone(payload: { sessionId: string; reason: string }): void;
  pathForFile(file: File): string;
  openLogs(): void;
  openDataDir(): void;
  clearUploads(): Promise<void>;
  copyDiagnostics(): Promise<string>;
  installFirewallRule(): Promise<{ ok: boolean; error?: string }>;
  setFullscreen(value: boolean): Promise<void>;
  windowAction(action: 'minimize' | 'toggle-maximize' | 'close'): void;
  quit(): void;
}

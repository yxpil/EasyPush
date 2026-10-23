import type {
  HistoryEntry,
  LiveSession,
  MediaItem,
  MediaSession,
  MediaSource,
  MediaStateReport,
  Presentation,
  ToastMessage,
} from '../../shared/types';
import { clamp } from '../../shared/format';
import { randomId } from '../core/ids';
import type { Logger } from '../core/logger';
import type { Store } from '../core/store';
import type { MediaLibrary } from './mediaLibrary';

export type MediaCommand =
  | 'play'
  | 'pause'
  | 'seek'
  | 'stop'
  | 'next'
  | 'previous'
  | 'volume'
  | 'mute'
  | 'autoplay-images';

export interface RendererPort {
  isReady(): boolean;
  loadMedia(session: MediaSession, autoplay: boolean): void;
  syncMedia(session: MediaSession): void;
  mediaCommand(sessionId: string, command: MediaCommand, value?: number | boolean): void;
}

export interface PresentationEvents {
  changed(): void;
  toast(toast: Omit<ToastMessage, 'id'>): void;
  history(entry: HistoryEntry): void;
}

export class PresentationError extends Error {
  constructor(
    readonly code: 'busy' | 'no-media' | 'invalid',
    message: string,
  ) {
    super(message);
  }
}

export class PresentationService {
  private media: MediaSession | null = null;
  private presentation: Presentation = { mode: 'idle', liveSessionId: null, mediaSessionId: null };
  private liveActive = false;
  private liveQueueSessionId: string | null = null;
  private mediaPresented = false;
  private dlnaStarted = false;
  private pendingAutoplay = false;
  private positionAnchor = { at: 0, position: 0 };

  constructor(
    private readonly store: Store,
    private readonly logger: Logger,
    private readonly library: MediaLibrary,
    private readonly renderer: RendererPort,
    private readonly events: PresentationEvents,
  ) {}

  addItems(items: MediaItem[], source: Extract<MediaSource, 'upload' | 'local' | 'url'>, sourceIp: string | null): MediaSession {
    if (items.length === 0) throw new PresentationError('invalid', '没有可播放的媒体');
    if (this.liveActive) {
      if (this.media && this.liveQueueSessionId === this.media.id) {
        this.media.items.push(...items);
        this.media.updatedAt = Date.now();
        this.renderer.syncMedia(this.media);
        this.events.changed();
        this.events.toast({
          kind: 'info',
          title: '已加入待播放列表',
          message: `${items.length} 个文件已排队，直播结束后可播放`,
        });
        return this.media;
      }
      this.finalizeMedia('replaced');
      const session = this.createSession(items, source, sourceIp);
      this.media = session;
      this.liveQueueSessionId = session.id;
      this.mediaPresented = false;
      this.events.changed();
      this.events.toast({
        kind: 'info',
        title: '已加入待播放列表',
        message: '直播结束后可播放这些媒体',
      });
      return session;
    }
    this.finalizeMedia('replaced');
    const session = this.createSession(items, source, sourceIp);
    this.media = session;
    this.setPresentationMedia();
    this.sendLoad(true);
    this.events.changed();
    return session;
  }

  appendItems(items: MediaItem[], source: Extract<MediaSource, 'upload' | 'local' | 'url'>, sourceIp: string | null): MediaSession {
    if (items.length === 0) throw new PresentationError('invalid', '没有可播放的媒体');
    if (this.liveActive || !this.media || this.presentation.mode !== 'media') {
      return this.addItems(items, source, sourceIp);
    }
    const media = this.media;
    media.items.push(...items);
    media.updatedAt = Date.now();
    this.renderer.syncMedia(media);
    this.events.changed();
    this.events.toast({
      kind: 'info',
      title: '已加入播放队列',
      message: `${items.length} 个文件将在当前内容后播放`,
    });
    return media;
  }

  setDlnaUri(item: MediaItem): MediaSession {
    if (this.liveActive) throw new PresentationError('busy', '正在直播，暂不能接收 DLNA 推送');
    this.finalizeMedia('replaced');
    const session = this.createSession([item], 'dlna', item.sourceLabel);
    this.media = session;
    this.dlnaStarted = false;
    this.setPresentationMedia();
    this.sendLoad(false);
    this.events.changed();
    this.logger.info('presentation.dlna_uri', { title: item.name });
    return session;
  }

  playItem(itemId: string): void {
    if (!this.media) throw new PresentationError('no-media', '没有媒体');
    const index = this.media.items.findIndex((item) => item.id === itemId);
    if (index < 0) throw new PresentationError('invalid', '媒体不存在');
    this.media.index = index;
    this.media.positionSec = 0;
    this.media.state = 'loading';
    this.media.error = null;
    this.media.durationSec = this.media.items[index]?.durationSec ?? 0;
    this.dlnaStarted = true;
    this.setPresentationMedia();
    this.sendLoad(true);
    this.events.changed();
  }

  command(command: MediaCommand, value?: number | boolean): void {
    const media = this.media;
    if (!media) return;
    if (command === 'stop') {
      this.stop();
      return;
    }
    if (command === 'volume') {
      const volume = clamp(typeof value === 'number' ? value : media.volume, 0, 1);
      media.volume = volume;
      this.store.setSettings({ volume });
      this.renderer.mediaCommand(media.id, 'volume', volume);
      this.events.changed();
      return;
    }
    if (command === 'mute') {
      media.muted = Boolean(value);
      this.store.setSettings({ muted: media.muted });
      this.renderer.mediaCommand(media.id, 'mute', media.muted);
      this.events.changed();
      return;
    }
    if (command === 'autoplay-images') {
      media.autoplayImages = Boolean(value);
      this.renderer.mediaCommand(media.id, 'autoplay-images', media.autoplayImages);
      this.events.changed();
      return;
    }
    if (command === 'play') {
      if (media.state === 'ended') {
        media.positionSec = 0;
        this.renderer.mediaCommand(media.id, 'seek', 0);
      }
      media.state = 'playing';
      this.dlnaStarted = true;
      this.positionAnchor = { at: Date.now(), position: media.positionSec };
      this.renderer.mediaCommand(media.id, 'play');
      this.events.changed();
      return;
    }
    if (command === 'pause') {
      if (media.state !== 'playing') return;
      media.state = 'paused';
      media.positionSec = this.currentPosition();
      this.positionAnchor = { at: Date.now(), position: media.positionSec };
      this.renderer.mediaCommand(media.id, 'pause');
      this.events.changed();
      return;
    }
    if (command === 'next' || command === 'previous') {
      this.step(command === 'next' ? 1 : -1);
      return;
    }
    if (command === 'seek') {
      const target = clamp(typeof value === 'number' ? value : 0, 0, media.durationSec || Number.MAX_SAFE_INTEGER);
      media.positionSec = target;
      media.state = media.state === 'ended' ? 'paused' : media.state;
      this.positionAnchor = { at: Date.now(), position: target };
      this.renderer.mediaCommand(media.id, 'seek', target);
      this.events.changed();
    }
  }

  stop(): void {
    const media = this.media;
    if (!media) return;
    this.renderer.mediaCommand(media.id, 'stop');
    this.finalizeMedia('stopped');
    this.media = null;
    this.mediaPresented = false;
    this.dlnaStarted = false;
    this.presentation = this.liveActive
      ? { mode: 'live', liveSessionId: this.presentation.liveSessionId, mediaSessionId: null }
      : { mode: 'idle', liveSessionId: null, mediaSessionId: null };
    this.events.changed();
  }

  onRendererState(report: MediaStateReport): void {
    const media = this.media;
    if (!media || report.sessionId !== media.id) return;
    media.state = report.state;
    media.positionSec = Number.isFinite(report.positionSec) ? Math.max(0, report.positionSec) : media.positionSec;
    media.durationSec = Number.isFinite(report.durationSec) && report.durationSec > 0 ? report.durationSec : media.durationSec;
    media.volume = clamp(report.volume, 0, 1);
    media.muted = report.muted;
    media.index = clamp(report.index, 0, media.items.length - 1);
    media.error = report.error;
    media.width = report.width;
    media.height = report.height;
    media.canSeek = report.canSeek;
    media.updatedAt = Date.now();
    this.positionAnchor = { at: Date.now(), position: media.positionSec };

    if (report.state === 'ended') {
      if (media.index < media.items.length - 1) {
        this.step(1, true);
        return;
      }
    }
    if (report.state === 'error' && report.error) {
      this.events.toast({ kind: 'error', title: '媒体播放失败', message: report.error });
    }
    this.events.changed();
  }

  onRendererGone(reason: string): void {
    if (!this.media) return;
    if (this.mediaPresented) this.finalizeMedia(reason);
    this.media = null;
    this.mediaPresented = false;
    this.dlnaStarted = false;
    this.presentation = { mode: 'idle', liveSessionId: null, mediaSessionId: null };
    this.events.changed();
  }

  rendererReady(): void {
    if (!this.media || this.presentation.mode !== 'media') return;
    const autoplay = this.media.state === 'playing' || this.media.state === 'loading';
    this.sendLoad(autoplay || this.pendingAutoplay);
  }

  onLiveStarted(session: LiveSession): void {
    if (this.media && this.media.state !== 'paused' && this.media.state !== 'ended') {
      this.media.state = 'paused';
      this.media.positionSec = this.currentPosition();
      this.positionAnchor = { at: Date.now(), position: this.media.positionSec };
      this.renderer.mediaCommand(this.media.id, 'pause');
      this.events.changed();
    }
    this.liveActive = true;
    this.liveQueueSessionId = null;
    this.presentation = { mode: 'live', liveSessionId: session.id, mediaSessionId: null };
    this.events.changed();
  }

  onLiveEnded(): void {
    this.liveActive = false;
    this.liveQueueSessionId = null;
    if (this.media) {
      this.presentation = { mode: 'media', liveSessionId: null, mediaSessionId: this.media.id };
      this.sendLoad(false);
    } else {
      this.presentation = { mode: 'idle', liveSessionId: null, mediaSessionId: null };
    }
    this.events.changed();
  }

  interruptLiveForMedia(): boolean {
    if (!this.liveActive) return false;
    this.liveActive = false;
    return true;
  }

  setLiveActive(sessionId: string | null): void {
    this.liveActive = Boolean(sessionId);
    this.liveQueueSessionId = null;
    if (sessionId) {
      this.presentation = { mode: 'live', liveSessionId: sessionId, mediaSessionId: null };
    }
    this.events.changed();
  }

  currentPosition(): number {
    const media = this.media;
    if (!media) return 0;
    if (media.state !== 'playing') return media.positionSec;
    const elapsed = (Date.now() - this.positionAnchor.at) / 1000;
    const value = this.positionAnchor.position + Math.max(0, elapsed);
    if (media.durationSec > 0) return Math.min(media.durationSec, value);
    return value;
  }

  transportState(): string {
    const media = this.media;
    if (!media) return 'NO_MEDIA_PRESENT';
    if (media.source === 'dlna' && !this.dlnaStarted && media.state !== 'playing') return 'STOPPED';
    if (media.state === 'loading') return 'TRANSITIONING';
    if (media.state === 'playing') return 'PLAYING';
    if (media.state === 'paused') return 'PAUSED_PLAYBACK';
    if (media.state === 'error') return 'STOPPED';
    if (media.state === 'ended') return 'STOPPED';
    if (media.state === 'idle') return 'NO_MEDIA_PRESENT';
    return 'STOPPED';
  }

  dlnaPlay(): void {
    if (!this.media) throw new PresentationError('no-media', '没有媒体');
    this.dlnaStarted = true;
    this.command('play');
  }

  dlnaPause(): void {
    if (!this.media || !this.dlnaStarted) throw new PresentationError('no-media', '没有正在播放的媒体');
    this.command('pause');
  }

  dlnaSeek(seconds: number): void {
    if (!this.media) throw new PresentationError('no-media', '没有媒体');
    if (this.media.items[this.media.index]?.kind === 'image') throw new PresentationError('invalid', '图片不支持定位');
    this.command('seek', seconds);
  }

  dlnaNext(): void {
    if (!this.media || this.media.items.length < 2) throw new PresentationError('invalid', '没有下一项');
    this.command('next');
  }

  dlnaPrevious(): void {
    if (!this.media || this.media.items.length < 2) throw new PresentationError('invalid', '没有上一项');
    this.command('previous');
  }

  setVolumePercent(percent: number): void {
    const volume = clamp(percent / 100, 0, 1);
    this.store.setSettings({ volume });
    if (this.media) {
      this.media.volume = volume;
      this.renderer.mediaCommand(this.media.id, 'volume', volume);
    }
    this.events.changed();
  }

  setMuted(muted: boolean): void {
    this.store.setSettings({ muted });
    if (this.media) {
      this.media.muted = muted;
      this.renderer.mediaCommand(this.media.id, 'mute', muted);
    }
    this.events.changed();
  }

  snapshot(): { media: MediaSession | null; presentation: Presentation } {
    return { media: this.media, presentation: this.presentation };
  }

  currentItem(): MediaItem | null {
    return this.media?.items[this.media.index] ?? null;
  }

  isLiveActive(): boolean {
    return this.liveActive;
  }

  getMedia(): MediaSession | null {
    return this.media;
  }

  isDlnaStarted(): boolean {
    return this.dlnaStarted;
  }

  async shutdown(): Promise<void> {
    if (this.media) {
      this.renderer.mediaCommand(this.media.id, 'stop');
      this.finalizeMedia('shutdown');
      this.media = null;
    }
  }

  private createSession(
    items: MediaItem[],
    source: MediaSource,
    sourceIp: string | null,
  ): MediaSession {
    const settings = this.store.get().settings;
    const now = Date.now();
    return {
      id: randomId(12),
      source,
      items,
      index: 0,
      state: 'loading',
      positionSec: 0,
      durationSec: items[0]?.durationSec ?? 0,
      volume: settings.volume,
      muted: settings.muted,
      autoplayImages: false,
      error: null,
      startedAt: now,
      updatedAt: now,
      sourceIp,
      width: null,
      height: null,
      canSeek: false,
    };
  }

  private setPresentationMedia(): void {
    if (!this.media) return;
    this.presentation = { mode: 'media', liveSessionId: null, mediaSessionId: this.media.id };
  }

  private sendLoad(autoplay: boolean): void {
    if (!this.media) return;
    if (!this.renderer.isReady()) {
      this.pendingAutoplay = autoplay;
      this.mediaPresented = false;
      return;
    }
    this.pendingAutoplay = false;
    this.mediaPresented = true;
    this.positionAnchor = { at: Date.now(), position: this.media.positionSec };
    this.renderer.loadMedia(this.media, autoplay);
  }

  private step(direction: 1 | -1, auto = false): void {
    const media = this.media;
    if (!media || media.items.length < 2) return;
    const wasPlaying = media.state === 'playing' || media.state === 'loading';
    const nextIndex = (media.index + direction + media.items.length) % media.items.length;
    media.index = nextIndex;
    media.positionSec = 0;
    media.durationSec = media.items[nextIndex]?.durationSec ?? 0;
    media.state = 'loading';
    media.error = null;
    media.width = null;
    media.height = null;
    media.updatedAt = Date.now();
    this.sendLoad(auto ? true : wasPlaying);
    this.events.changed();
  }

  private finalizeMedia(reason: string): void {
    const media = this.media;
    if (!media || !this.mediaPresented) return;
    const item = media.items[media.index];
    const endedAt = Date.now();
    this.events.history({
      id: media.id,
      kind: 'media',
      protocol: media.source === 'dlna' ? 'dlna' : media.source,
      title: item?.name ?? '媒体',
      deviceName: null,
      platform: null,
      sourceIp: media.sourceIp,
      startedAt: media.startedAt,
      endedAt,
      durationSec: Math.max(0, Math.round((endedAt - media.startedAt) / 1000)),
      width: media.width,
      height: media.height,
      codec: null,
      avgBitrateKbps: null,
      endReason: reason,
    });
    this.logger.info('presentation.media_ended', { reason, title: item?.name });
  }
}

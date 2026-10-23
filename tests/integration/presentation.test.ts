import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PresentationError, PresentationService, type MediaCommand, type PresentationEvents, type RendererPort } from '../../src/main/services/presentation';
import type { MediaLibrary } from '../../src/main/services/mediaLibrary';
import { Logger } from '../../src/main/core/logger';
import { Store } from '../../src/main/core/store';
import type { HistoryEntry, LiveSession, MediaItem, MediaSession, ToastMessage } from '../../src/shared/types';

const dirs: string[] = [];
const stores: Store[] = [];

class FakeRenderer implements RendererPort {
  ready = true;
  loads: Array<{ id: string; autoplay: boolean }> = [];
  syncs: Array<{ id: string; count: number }> = [];
  commands: Array<{ id: string; command: MediaCommand; value: number | boolean | undefined }> = [];
  isReady(): boolean {
    return this.ready;
  }
  loadMedia(session: MediaSession, autoplay: boolean): void {
    this.loads.push({ id: session.id, autoplay });
  }
  syncMedia(session: MediaSession): void {
    this.syncs.push({ id: session.id, count: session.items.length });
  }
  mediaCommand(id: string, command: MediaCommand, value?: number | boolean): void {
    this.commands.push({ id, command, value });
  }
}

interface Fixture {
  service: PresentationService;
  store: Store;
  renderer: FakeRenderer;
  history: HistoryEntry[];
  toasts: Array<Omit<ToastMessage, 'id'>>;
  changes: () => number;
}

async function setup(): Promise<Fixture> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'easypush-present-'));
  dirs.push(dir);
  const logger = new Logger(path.join(dir, 'logs'), 'error', { console: false });
  const store = new Store(path.join(dir, 'state.json'), logger);
  await store.load();
  stores.push(store);
  const renderer = new FakeRenderer();
  const history: HistoryEntry[] = [];
  const toasts: Array<Omit<ToastMessage, 'id'>> = [];
  let changed = 0;
  const events: PresentationEvents = {
    changed: () => {
      changed += 1;
    },
    toast: (toast) => {
      toasts.push(toast);
    },
    history: (entry) => {
      history.push(entry);
    },
  };
  const service = new PresentationService(store, logger, {} as MediaLibrary, renderer, events);
  return { service, store, renderer, history, toasts, changes: () => changed };
}

let sequence = 0;
function item(kind: MediaItem['kind'] = 'image', overrides: Partial<MediaItem> = {}): MediaItem {
  sequence += 1;
  return {
    id: `item-${sequence}`,
    kind,
    name: `${kind}-${sequence}`,
    mime: kind === 'image' ? 'image/png' : kind === 'audio' ? 'audio/wav' : 'video/mp4',
    size: 1000,
    url: `http://127.0.0.1:7333/media/item-${sequence}`,
    source: 'upload',
    sourceLabel: '10.0.0.9',
    addedAt: Date.now(),
    durationSec: kind === 'image' ? null : 100,
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('PresentationService', () => {
  it('loads, appends and replaces media sessions', async () => {
    const { service, renderer, history, toasts } = await setup();
    const first = service.addItems([item(), item()], 'upload', '10.0.0.9');
    expect(renderer.loads).toEqual([{ id: first.id, autoplay: true }]);
    expect(service.snapshot().presentation).toEqual({ mode: 'media', liveSessionId: null, mediaSessionId: first.id });
    expect(history).toHaveLength(0);

    const queued = service.appendItems([item()], 'upload', '10.0.0.9');
    expect(queued.id).toBe(first.id);
    expect(queued.items).toHaveLength(3);
    expect(renderer.syncs.at(-1)).toEqual({ id: first.id, count: 3 });
    expect(renderer.loads).toHaveLength(1);
    expect(toasts.at(-1)?.title).toBe('已加入播放队列');

    service.addItems([item()], 'url', '1.1.1.1');
    expect(renderer.loads).toHaveLength(2);
    expect(renderer.loads[1]?.autoplay).toBe(true);
    expect(history[0]).toMatchObject({ endReason: 'replaced', protocol: 'upload' });
  });

  it('applies playback commands and persists volume', async () => {
    const { service, store, renderer } = await setup();
    service.addItems([item('video', { durationSec: 90 }), item('video', { durationSec: 90 })], 'upload', null);

    service.command('play');
    expect(service.getMedia()?.state).toBe('playing');
    expect(renderer.commands.at(-1)).toMatchObject({ command: 'play' });
    service.command('pause');
    expect(service.getMedia()?.state).toBe('paused');

    service.command('seek', 10_000);
    expect(service.getMedia()?.positionSec).toBe(90);
    expect(renderer.commands.at(-1)).toMatchObject({ command: 'seek', value: 90 });

    service.command('next');
    expect(service.getMedia()?.index).toBe(1);
    service.command('next');
    expect(service.getMedia()?.index).toBe(0);
    service.command('previous');
    expect(service.getMedia()?.index).toBe(1);

    service.command('volume', 0.3);
    expect(store.get().settings.volume).toBe(0.3);
    expect(renderer.commands.at(-1)).toMatchObject({ command: 'volume', value: 0.3 });
    service.command('mute', true);
    expect(store.get().settings.muted).toBe(true);
    service.command('autoplay-images', true);
    expect(service.getMedia()?.autoplayImages).toBe(true);
  });

  it('advances on ended and reports errors', async () => {
    const { service, renderer, toasts } = await setup();
    const media = service.addItems([item('video'), item('video')], 'upload', null);
    service.command('play');
    service.onRendererState({
      sessionId: media.id,
      state: 'ended',
      positionSec: 10,
      durationSec: 10,
      volume: 1,
      muted: false,
      index: 0,
      error: null,
      canSeek: true,
      width: 1280,
      height: 720,
    });
    expect(service.getMedia()?.index).toBe(1);
    expect(renderer.loads).toHaveLength(2);
    expect(renderer.loads[1]?.autoplay).toBe(true);

    service.onRendererState({
      sessionId: media.id,
      state: 'error',
      positionSec: 0,
      durationSec: 0,
      volume: 1,
      muted: false,
      index: 1,
      error: '不支持此编码',
      canSeek: false,
      width: null,
      height: null,
    });
    expect(service.getMedia()?.error).toBe('不支持此编码');
    expect(toasts.at(-1)).toMatchObject({ kind: 'error', title: '媒体播放失败' });
  });

  it('queues loads until the renderer is ready', async () => {
    const { service, renderer } = await setup();
    renderer.ready = false;
    const media = service.addItems([item()], 'upload', null);
    expect(renderer.loads).toHaveLength(0);
    renderer.ready = true;
    service.rendererReady();
    expect(renderer.loads).toEqual([{ id: media.id, autoplay: true }]);

    service.command('play');
    service.command('pause');
    service.rendererReady();
    expect(renderer.loads.at(-1)?.autoplay).toBe(false);
  });

  it('keeps live sessions exclusive and queues media for after the live', async () => {
    const { service, renderer, toasts, history } = await setup();
    const before = service.addItems([item()], 'upload', null);
    service.onLiveStarted({ id: 'live-1' } as LiveSession);
    expect(service.snapshot().presentation.mode).toBe('live');
    expect(renderer.commands.at(-1)).toMatchObject({ id: before.id, command: 'pause' });

    const queued = service.addItems([item()], 'upload', null);
    expect(renderer.loads).toHaveLength(1);
    expect(service.getMedia()?.id).toBe(queued.id);
    expect(service.snapshot().presentation).toEqual({ mode: 'live', liveSessionId: 'live-1', mediaSessionId: null });
    expect(toasts.at(-1)?.title).toBe('已加入待播放列表');
    expect(history).toHaveLength(1);

    const appended = service.appendItems([item()], 'upload', null);
    expect(appended.id).toBe(queued.id);
    expect(appended.items).toHaveLength(2);
    expect(renderer.syncs.at(-1)).toEqual({ id: queued.id, count: 2 });

    service.onLiveEnded();
    expect(service.snapshot().presentation.mode).toBe('media');
    expect(renderer.loads.at(-1)).toEqual({ id: queued.id, autoplay: false });
  });

  it('replaces stale pre-live media on the first cast of a live', async () => {
    const { service, renderer } = await setup();
    const stale = service.addItems([item()], 'upload', null);
    service.onLiveStarted({ id: 'live-2' } as LiveSession);
    const fresh = service.addItems([item()], 'upload', null);
    expect(fresh.id).not.toBe(stale.id);
    expect(service.getMedia()?.items).toHaveLength(1);
    expect(renderer.loads).toHaveLength(1);
    expect(service.isLiveActive()).toBe(true);
  });

  it('drives DLNA playback and transport state', async () => {
    const { service, renderer, store } = await setup();
    const media = service.setDlnaUri(item('image', { source: 'dlna' }));
    expect(media.source).toBe('dlna');
    expect(service.snapshot().presentation.mode).toBe('media');
    expect(renderer.loads.at(-1)).toEqual({ id: media.id, autoplay: false });
    expect(service.transportState()).toBe('STOPPED');

    service.command('play');
    expect(service.transportState()).toBe('PLAYING');
    expect(renderer.commands.at(-1)).toMatchObject({ command: 'play' });
    service.command('seek', 5);
    service.command('volume', 0.4);
    expect(store.get().settings.volume).toBe(0.4);
    service.command('mute', true);
    expect(store.get().settings.muted).toBe(true);

    service.command('stop');
    expect(service.getMedia()).toBeNull();
    expect(service.snapshot().presentation.mode).toBe('idle');
  });

  it('refuses DLNA while live and recovers when the renderer disappears', async () => {
    const { service, renderer, history } = await setup();
    service.setLiveActive('live-3');
    expect(() => service.setDlnaUri(item())).toThrowError(PresentationError);
    expect(() => service.addItems([], 'upload', null)).toThrowError(PresentationError);
    service.setLiveActive(null);

    const media = service.addItems([item()], 'upload', null);
    expect(renderer.loads).toHaveLength(1);
    service.onRendererGone('界面已关闭');
    expect(service.getMedia()).toBeNull();
    expect(service.snapshot().presentation.mode).toBe('idle');
    expect(history.at(-1)).toMatchObject({ endReason: '界面已关闭', title: media.items[0]?.name });
  });
});

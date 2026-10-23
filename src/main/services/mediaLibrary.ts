import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rm, stat, statfs, unlink } from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';
import type { Readable } from 'node:stream';
import type { MediaItem, MediaKind, MediaSource } from '../../shared/types';
import { MAX_UPLOAD_BYTES } from '../../shared/types';
import {
  isPlayableExtension,
  isSupportedMediaMime,
  kindFromNameOrMime,
} from '../../shared/protocol';
import { UPLOAD_RETENTION_MS } from '../core/config';
import { randomId } from '../core/ids';
import type { Logger } from '../core/logger';

export class UploadError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'UploadError';
  }
}

interface RegistryEntry {
  item: MediaItem;
  filePath: string;
}

const EXT_MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  heic: 'image/heic',
  heif: 'image/heif',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  ogv: 'video/ogg',
  mkv: 'video/x-matroska',
  m3u8: 'application/vnd.apple.mpegurl',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/opus',
};

export class MediaLibrary {
  private readonly registry = new Map<string, RegistryEntry>();
  private baseUrl = '';
  readonly uploadsDir: string;

  constructor(
    dataDir: string,
    private readonly logger: Logger,
    private readonly maxUploadBytes = MAX_UPLOAD_BYTES,
  ) {
    this.uploadsDir = path.join(dataDir, 'uploads');
  }

  async init(): Promise<void> {
    await mkdir(this.uploadsDir, { recursive: true });
    await this.prune();
  }

  setBaseUrl(baseUrl: string): void {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    for (const entry of this.registry.values()) {
      if (entry.item.source === 'upload' || entry.item.source === 'local') {
        entry.item.url = `${this.baseUrl}/media/${entry.item.id}`;
      }
    }
  }

  async saveUpload(
    stream: Readable,
    options: { name: string; mime: string; sizeHint: number | null; requestIp: string },
  ): Promise<MediaItem> {
    const name = sanitizeFileName(options.name);
    const mime = normalizeMime(options.mime, name);
    if (!isSupportedMediaMime(mime)) {
      throw new UploadError(415, 'unsupported-media', '只支持图片、音频和视频文件');
    }
    if (options.sizeHint !== null && options.sizeHint > this.maxUploadBytes) {
      throw new UploadError(413, 'too-large', '文件超过 2 GB 限制');
    }
    await this.assertDiskSpace(options.sizeHint);
    const id = randomId(12);
    const ext = extensionFor(name, mime);
    const filePath = path.join(this.uploadsDir, `${id}.${ext}`);
    const tempPath = `${filePath}.part`;
    let bytes = 0;
    const out = createWriteStream(tempPath, { flags: 'wx', mode: 0o600 });
    try {
      for await (const chunk of stream) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        bytes += buffer.length;
        if (bytes > this.maxUploadBytes) {
          throw new UploadError(413, 'too-large', '文件超过 2 GB 限制');
        }
        if (!out.write(buffer)) await once(out, 'drain');
      }
      out.end();
      await once(out, 'finish');
      if (bytes === 0) throw new UploadError(400, 'empty-upload', '文件为空');
      const { rename } = await import('node:fs/promises');
      await rename(tempPath, filePath);
    } catch (error) {
      out.destroy();
      await new Promise<void>((resolve) => {
        if (out.closed) return resolve();
        const done = () => resolve();
        out.once('close', done);
        out.once('error', done);
        setTimeout(resolve, 1000).unref();
      });
      await unlink(tempPath).catch(() => undefined);
      await unlink(filePath).catch(() => undefined);
      if (error instanceof UploadError) throw error;
      this.logger.error('media.upload_failed', { error: String(error), ip: options.requestIp });
      throw new UploadError(500, 'upload-failed', '保存文件失败');
    }

    const kind = kindFromNameOrMime(name, mime);
    const item: MediaItem = {
      id,
      kind,
      name,
      mime,
      size: bytes,
      url: `${this.baseUrl}/media/${id}`,
      source: 'upload',
      sourceLabel: options.requestIp,
      addedAt: Date.now(),
      durationSec: null,
    };
    this.registry.set(id, { item, filePath });
    this.logger.info('media.uploaded', { id, bytes, kind, ip: options.requestIp });
    return item;
  }

  async addLocalFiles(paths: string[]): Promise<MediaItem[]> {
    const items: MediaItem[] = [];
    for (const rawPath of paths.slice(0, 30)) {
      try {
        const filePath = path.resolve(rawPath);
        const info = await stat(filePath);
        if (!info.isFile() || !isPlayableExtension(filePath)) continue;
        const name = path.basename(filePath);
        const mime = normalizeMime('', name);
        const id = randomId(12);
        const item: MediaItem = {
          id,
          kind: kindFromNameOrMime(name, mime),
          name,
          mime,
          size: info.size,
          url: `${this.baseUrl}/media/${id}`,
          source: 'local',
          sourceLabel: '本机文件',
          addedAt: Date.now(),
          durationSec: null,
        };
        this.registry.set(id, { item, filePath });
        items.push(item);
      } catch (error) {
        this.logger.warn('media.local_file_failed', { path: rawPath, error: String(error) });
      }
    }
    return items;
  }

  addRemoteItem(options: {
    url: string;
    title: string;
    mime: string;
    kind: MediaKind;
    source: Extract<MediaSource, 'url' | 'dlna'>;
    sourceLabel: string;
    durationSec?: number | null;
    size?: number | null;
  }): MediaItem {
    return {
      id: randomId(12),
      kind: options.kind,
      name: options.title,
      mime: options.mime,
      size: options.size ?? null,
      url: options.url,
      source: options.source,
      sourceLabel: options.sourceLabel,
      addedAt: Date.now(),
      durationSec: options.durationSec ?? null,
    };
  }

  resolve(id: string): { filePath: string; mime: string; name: string; size: number } | null {
    const entry = this.registry.get(id);
    if (!entry) return null;
    return {
      filePath: entry.filePath,
      mime: entry.item.mime,
      name: entry.item.name,
      size: entry.item.size ?? 0,
    };
  }

  getItem(id: string): MediaItem | null {
    return this.registry.get(id)?.item ?? null;
  }

  async clearUploads(): Promise<number> {
    let bytes = 0;
    for (const [id, entry] of this.registry) {
      if (entry.item.source !== 'upload') continue;
      bytes += entry.item.size ?? 0;
      this.registry.delete(id);
    }
    const files = await readdir(this.uploadsDir).catch(() => [] as string[]);
    for (const file of files) {
      const full = path.join(this.uploadsDir, file);
      const info = await stat(full).catch(() => null);
      if (info?.isFile()) bytes += info.size;
      await rm(full, { force: true, recursive: true }).catch(() => undefined);
    }
    return bytes;
  }

  async prune(): Promise<void> {
    const cutoff = Date.now() - UPLOAD_RETENTION_MS;
    const files = await readdir(this.uploadsDir).catch(() => [] as string[]);
    let removed = 0;
    for (const file of files) {
      const full = path.join(this.uploadsDir, file);
      const info = await stat(full).catch(() => null);
      if (info?.isFile() && info.mtimeMs < cutoff) {
        await rm(full, { force: true }).catch(() => undefined);
        removed += 1;
      }
    }
    if (removed > 0) this.logger.info('media.pruned', { removed });
  }

  async uploadUsage(): Promise<{ bytes: number; files: number }> {
    const files = await readdir(this.uploadsDir).catch(() => [] as string[]);
    let bytes = 0;
    let count = 0;
    for (const file of files) {
      const info = await stat(path.join(this.uploadsDir, file)).catch(() => null);
      if (info?.isFile()) {
        bytes += info.size;
        count += 1;
      }
    }
    return { bytes, files: count };
  }

  private async assertDiskSpace(sizeHint: number | null): Promise<void> {
    try {
      const stats = await statfs(this.uploadsDir);
      const free = Number(stats.bavail) * Number(stats.bsize);
      const needed = Math.max(sizeHint ?? 0, 1 * 1024 * 1024) + 256 * 1024 * 1024;
      if (free < needed) throw new UploadError(507, 'no-space', '磁盘剩余空间不足');
    } catch (error) {
      if (error instanceof UploadError) throw error;
    }
  }
}

export function sanitizeFileName(raw: string): string {
  const decoded = decodeURIComponentSafe(raw);
  const base = path.basename(decoded).replace(/[<>:"/\\|?*\p{Cc}]/gu, '_').trim();
  const name = base.slice(0, 120);
  return name || `媒体-${Date.now()}`;
}

export function normalizeMime(mime: string, name: string): string {
  const normalized = mime.split(';')[0]?.trim().toLowerCase() ?? '';
  if (normalized && normalized !== 'application/octet-stream') return normalized;
  const ext = /\.([a-zA-Z0-9]+)$/.exec(name)?.[1]?.toLowerCase() ?? '';
  return EXT_MIME[ext] ?? 'application/octet-stream';
}

export function extensionFor(name: string, mime: string): string {
  const ext = /\.([a-zA-Z0-9]+)$/.exec(name)?.[1]?.toLowerCase();
  if (ext && ext.length <= 8) return ext;
  const match = Object.entries(EXT_MIME).find(([, value]) => value === mime);
  return match?.[0] ?? 'bin';
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

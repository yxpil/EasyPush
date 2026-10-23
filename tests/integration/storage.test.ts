import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Logger } from '../../src/main/core/logger';
import { Store, type DeviceRecord } from '../../src/main/core/store';
import { MediaLibrary, UploadError } from '../../src/main/services/mediaLibrary';

const dirs: string[] = [];
const stores: Store[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('MediaLibrary uploads', () => {
  it('saves supported media with sanitized names and resolves files', async () => {
    const dir = await tempDir('easypush-media-');
    const logger = new Logger(path.join(dir, 'logs'), 'error', { console: false });
    const library = new MediaLibrary(dir, logger, 1024);
    await library.init();
    library.setBaseUrl('http://127.0.0.1:7333');
    const bytes = Buffer.from('fake-png-bytes');
    const item = await library.saveUpload(Readable.from(bytes), {
      name: '相册/照片.PNG',
      mime: 'image/png',
      sizeHint: bytes.length,
      requestIp: '10.0.0.9',
    });
    expect(item).toMatchObject({ name: '照片.PNG', kind: 'image', mime: 'image/png', size: bytes.length, source: 'upload' });
    expect(item.url).toBe(`http://127.0.0.1:7333/media/${item.id}`);
    const resolved = library.resolve(item.id);
    expect(resolved?.filePath.endsWith(`${item.id}.png`)).toBe(true);
    expect((await readFile(resolved!.filePath)).equals(bytes)).toBe(true);

    library.setBaseUrl('http://10.0.0.5:7333/');
    expect(library.resolve(item.id)?.filePath).toBe(resolved?.filePath);
  });

  it('rejects oversized, unsupported, empty and over-budget uploads', async () => {
    const dir = await tempDir('easypush-media-');
    const logger = new Logger(path.join(dir, 'logs'), 'error', { console: false });
    const library = new MediaLibrary(dir, logger, 8);
    await library.init();
    const uploadDir = library.uploadsDir;

    await expect(
      library.saveUpload(Readable.from(Buffer.from('x')), { name: 'a.png', mime: 'image/png', sizeHint: 9000, requestIp: 'ip' }),
    ).rejects.toMatchObject({ status: 413, code: 'too-large' });
    await expect(
      library.saveUpload(Readable.from(Buffer.from('x')), { name: 'a.txt', mime: 'text/plain', sizeHint: 1, requestIp: 'ip' }),
    ).rejects.toMatchObject({ status: 415, code: 'unsupported-media' });
    await expect(
      library.saveUpload(Readable.from(Buffer.alloc(0)), { name: 'a.png', mime: 'image/png', sizeHint: 0, requestIp: 'ip' }),
    ).rejects.toMatchObject({ status: 400, code: 'empty-upload' });
    await expect(
      library.saveUpload(Readable.from(Buffer.alloc(9)), { name: 'b.png', mime: 'image/png', sizeHint: null, requestIp: 'ip' }),
    ).rejects.toBeInstanceOf(UploadError);
    expect(await readdir(uploadDir)).toEqual([]);
  });

  it('registers local files and skips unsupported extensions', async () => {
    const dir = await tempDir('easypush-media-');
    const logger = new Logger(path.join(dir, 'logs'), 'error', { console: false });
    const library = new MediaLibrary(dir, logger, 1024);
    await library.init();
    library.setBaseUrl('http://127.0.0.1:7333');
    const png = path.join(dir, 'local.png');
    const txt = path.join(dir, 'notes.txt');
    await writeFile(png, 'x');
    await writeFile(txt, 'x');
    const items = await library.addLocalFiles([png, txt, path.join(dir, 'missing.mp4')]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ name: 'local.png', kind: 'image', source: 'local' });
    expect(library.resolve(items[0]!.id)?.filePath).toBe(png);

    const remote = library.addRemoteItem({ url: 'https://example.com/a.mp4', title: '远程', mime: 'video/mp4', kind: 'video', source: 'url', sourceLabel: 'ip' });
    library.setBaseUrl('http://10.0.0.5:7333');
    expect(remote.url).toBe('https://example.com/a.mp4');
  });
});

describe('Store persistence', () => {
  const device = (id: string): DeviceRecord => ({
    id,
    name: '手机',
    platform: 'android',
    userAgent: 'ua',
    ip: '10.0.0.9',
    firstSeenAt: 1,
    lastSeenAt: 2,
    remembered: true,
    blocked: false,
    credentialHash: 'hash',
  });

  it('persists settings, devices and history atomically', async () => {
    const dir = await tempDir('easypush-store-');
    const logger = new Logger(path.join(dir, 'logs'), 'error', { console: false });
    const file = path.join(dir, 'state.json');
    const first = new Store(file, logger);
    await first.load();
    first.setSettings({ deviceName: '书房电脑', volume: 0.42, imageSlideMs: 5000 });
    first.addDevice(device('device-1'));
    first.addHistory({
      id: 'h1',
      kind: 'media',
      protocol: 'upload',
      title: '照片',
      deviceName: null,
      platform: null,
      sourceIp: '10.0.0.9',
      startedAt: 1,
      endedAt: 2,
      durationSec: 1,
      width: 10,
      height: 10,
      codec: null,
      avgBitrateKbps: null,
      endReason: 'stopped',
    });
    await first.flush();

    const second = new Store(file, logger);
    stores.push(second);
    await second.load();
    expect(second.get().settings).toMatchObject({ deviceName: '书房电脑', volume: 0.42, imageSlideMs: 5000 });
    expect(second.get().devices).toHaveLength(1);
    expect(second.get().history[0]).toMatchObject({ id: 'h1', title: '照片' });
    expect(second.get().bootCount).toBe(2);
    expect(second.get().serverSecret.length).toBeGreaterThan(20);
  });

  it('quarantines a corrupt state file instead of crashing', async () => {
    const dir = await tempDir('easypush-store-');
    const logger = new Logger(path.join(dir, 'logs'), 'error', { console: false });
    const file = path.join(dir, 'state.json');
    await writeFile(file, '{ definitely not json');
    const store = new Store(file, logger);
    stores.push(store);
    await store.load();
    expect(store.get().devices).toEqual([]);
    expect(store.get().history).toEqual([]);
    const files = await readdir(dir);
    expect(files.some((name) => name.startsWith('state.json.corrupt-'))).toBe(true);
  });
});

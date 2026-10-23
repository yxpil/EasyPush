import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, chromium, expect, test, type Browser, type BrowserContext, type ElectronApplication, type Page } from '@playwright/test';
import type { AppSnapshot } from '../../src/shared/types';

const repoRoot = path.resolve(__dirname, '..', '..');

interface DesktopBridge {
  getSnapshot(): Promise<AppSnapshot>;
  updateSettings(patch: Record<string, unknown>): Promise<unknown>;
}

let app: ElectronApplication;
let desktop: Page;
let browser: Browser;
let phoneContext: BrowserContext;
let phone: Page;
let dataDir: string;
let httpsPort: number;
let origin: string;

async function snapshot(): Promise<AppSnapshot> {
  return desktop.evaluate(() => (window as unknown as { easypush: DesktopBridge }).easypush.getSnapshot());
}

test.describe.configure({ mode: 'serial' });

test.describe('LAN casting end to end', () => {
  test.beforeAll(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'easypush-e2e-'));
    app = await electron.launch({
      args: [repoRoot],
      env: {
        ...process.env,
        EASY_PUSH_DATA_DIR: dataDir,
        EASY_PUSH_USER_DATA: dataDir,
      },
    });
    desktop = await app.firstWindow();
    await desktop.waitForSelector('#root');
    await desktop.waitForFunction(() => Boolean((window as unknown as { easypush?: unknown }).easypush));

    const initial = await snapshot();
    httpsPort = initial.server.httpsPort;
    expect(httpsPort).toBeGreaterThan(0);
    expect(initial.server.httpsEnabled).toBe(true);
    origin = `https://127.0.0.1:${httpsPort}`;
    expect(initial.pairing).toBeNull();
    expect(initial.connect.code).toMatch(/^\d{6}$/);

    await desktop.evaluate(() => (window as unknown as { easypush: DesktopBridge }).easypush.updateSettings({ allowLive: true }));

    browser = await chromium.launch({
      args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--auto-select-desktop-capture-source=Entire screen',
        '--autoplay-policy=no-user-gesture-required',
      ],
    });
    phoneContext = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 412, height: 915 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
      userAgent:
        'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
    });
    await phoneContext.grantPermissions(['camera', 'microphone'], { origin });
    phone = await phoneContext.newPage();
  });

  test.afterAll(async () => {
    await browser?.close().catch(() => undefined);
    await app?.close().catch(() => undefined);
    if (dataDir) await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
  });

  test('pairs a phone through the desktop approval overlay', async () => {
    await phone.goto(`${origin}/`);
    await expect(phone.locator('#screen-pair')).toBeVisible();
    await expect(phone.locator('#pair-code')).toBeVisible();
    await expect(phone.locator('#pair-name')).toHaveValue(/./);

    const { connect } = await snapshot();
    await phone.fill('#pair-code', connect.code);
    await phone.fill('#pair-name', 'E2E 测试手机');
    await expect(phone.locator('#pair-submit')).toBeEnabled();
    await phone.click('#pair-submit');

    await expect(phone.locator('#pair-pending')).toBeVisible();
    await expect(desktop.locator('#pair-approval-title')).toBeVisible();
    await expect(desktop.locator('.approval-device strong')).toHaveText('E2E 测试手机');

    await desktop.getByRole('button', { name: '允许并记住' }).click();

    await expect(phone.locator('#screen-app')).toBeVisible({ timeout: 20_000 });
    await expect(phone.locator('#top-receiver')).toHaveText(/.+/);
    await expect(phone.locator('#secure-note')).toBeHidden();

    const paired = await snapshot();
    expect(paired.devices).toHaveLength(1);
    expect(paired.devices[0]?.name).toBe('E2E 测试手机');
    expect(paired.devices[0]?.remembered).toBe(true);
  });

  test('uploads a photo and decodes it on the desktop stage', async () => {
    const png = await phone.screenshot();
    expect(png.byteLength).toBeGreaterThan(1000);
    await phone.setInputFiles('#file-input', { name: 'e2e-capture.png', mimeType: 'image/png', buffer: png });

    await expect(phone.locator('.upload-row.is-ok')).toBeVisible({ timeout: 20_000 });
    await expect(phone.locator('.upload-state .ic')).toBeVisible();

    const image = desktop.locator('img.media-image');
    await expect(image).toBeVisible({ timeout: 20_000 });
    await expect.poll(async () => image.evaluate((node) => (node as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);

    const media = await snapshot();
    expect(media.media?.source).toBe('upload');
    expect(media.media?.state).toBe('playing');
    expect(media.media?.items[0]?.name).toBe('e2e-capture.png');
    expect(media.media?.items[0]?.kind).toBe('image');
  });

  test('streams a fake camera over WebRTC with desktop approval', async () => {
    await phone.click('#btn-camera');
    await expect(phone.locator('#cam-start')).toBeVisible();
    await phone.click('#cam-start');

    await expect(desktop.locator('#live-approval-title')).toBeVisible({ timeout: 20_000 });
    await expect(desktop.locator('.approval-device strong')).toHaveText('E2E 测试手机');
    await desktop.getByRole('button', { name: /^(允许投屏|结束原投屏并接管)$/ }).click();

    await expect(phone.locator('#live-panel')).toBeVisible();
    await expect(phone.locator('#live-cover')).toBeHidden({ timeout: 30_000 });
    await expect(phone.locator('#live-metrics')).toBeVisible();

    const video = desktop.locator('video.live-video');
    await expect(video).toHaveClass(/is-playing/, { timeout: 30_000 });
    await expect.poll(async () => video.evaluate((node) => (node as HTMLVideoElement).videoWidth)).toBeGreaterThan(0);
    expect(await video.evaluate((node) => (node as HTMLVideoElement).paused)).toBe(false);

    const live = await snapshot();
    expect(live.live?.state).toBe('live');
    expect(live.live?.media).toBe('camera');
    expect(live.live?.deviceName).toBe('E2E 测试手机');
    expect(live.media?.state).toBe('paused');

    await expect.poll(async () => phone.locator('#m-res').textContent()).toMatch(/\d+\s*×\s*\d+/);

    await phone.click('#live-stop');
    await expect(phone.locator('#live-panel')).toBeHidden();
    await expect.poll(async () => (await snapshot()).live).toBeNull();
  });

  test('rejects a wrong pairing code without creating a device', async () => {
    const anon = await browser.newContext({ ignoreHTTPSErrors: true });
    try {
      const page = await anon.newPage();
      await page.goto(`${origin}/`);
      await expect(page.locator('#screen-pair')).toBeVisible();
      await page.fill('#pair-code', '000000');
      await page.fill('#pair-name', 'Intruder');
      await page.click('#pair-submit');
      await expect(page.locator('#pair-inline-error')).toBeVisible();
      await expect(page.locator('#screen-pair')).toBeVisible();
      const after = await snapshot();
      expect(after.devices).toHaveLength(1);
      expect(after.pairing).toBeNull();
    } finally {
      await anon.close();
    }
  });

  test('shares a desktop browser screen through getDisplayMedia', async () => {
    const desktopContext = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 1280, height: 800 },
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    });
    try {
      const page = await desktopContext.newPage();
      await page.goto(`${origin}/`);
      await expect(page.locator('#screen-pair')).toBeVisible();
      const { connect } = await snapshot();
      await page.fill('#pair-code', connect.code);
      await page.fill('#pair-name', 'E2E 桌面浏览器');
      await page.click('#pair-submit');

      await expect(desktop.locator('#pair-approval-title')).toBeVisible({ timeout: 20_000 });
      await expect(desktop.locator('.approval-device strong')).toHaveText('E2E 桌面浏览器');
      await desktop.getByRole('button', { name: '允许并记住' }).click();
      await expect(page.locator('#screen-app')).toBeVisible({ timeout: 20_000 });
      await expect(page.locator('#screen-hint')).toHaveText('共享当前屏幕或标签页');
      expect((await snapshot()).devices.map((device) => device.name)).toContain('E2E 桌面浏览器');

      await page.click('#btn-screen');
      await expect(desktop.locator('#live-approval-title')).toBeVisible({ timeout: 20_000 });
      await expect(desktop.locator('.approval-device strong')).toHaveText('E2E 桌面浏览器');
      await expect(desktop.locator('.approval-facts')).toContainText('共享屏幕');
      await desktop.getByRole('button', { name: /^(允许投屏|结束原投屏并接管)$/ }).click();

      await expect(page.locator('#live-cover')).toBeHidden({ timeout: 30_000 });
      await expect(page.locator('#live-kicker')).toHaveText('屏幕共享');
      const video = desktop.locator('video.live-video');
      await expect(video).toHaveClass(/is-playing/, { timeout: 30_000 });
      await expect.poll(async () => video.evaluate((node) => (node as HTMLVideoElement).videoWidth)).toBeGreaterThan(0);

      const live = await snapshot();
      expect(live.live?.media).toBe('screen');
      expect(live.live?.state).toBe('live');
      expect(live.live?.deviceName).toBe('E2E 桌面浏览器');

      await page.click('#live-stop');
      await expect.poll(async () => (await snapshot()).live).toBeNull();
    } finally {
      await desktopContext.close();
    }
  });
});

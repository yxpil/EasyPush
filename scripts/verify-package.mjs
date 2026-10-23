import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { _electron as electron, chromium } from 'playwright';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { version } = require(path.join(repoRoot, 'package.json'));
const exe = path.join(repoRoot, 'release', 'win-unpacked', 'EasyPush.exe');

await stat(exe).catch(() => {
  throw new Error(`Packaged executable not found: ${exe}\nRun "npm run dist:dir" first.`);
});

const root = await mkdtemp(path.join(os.tmpdir(), 'easypush-pkg-'));
const profileDir = path.join(root, 'profile');
let app;
let browser;

try {
  app = await electron.launch({
    executablePath: exe,
    args: [`--user-data-dir=${profileDir}`],
    env: { ...process.env },
    timeout: 90_000,
  });
  const desktop = await app.firstWindow();
  await desktop.waitForSelector('#root', { timeout: 60_000 });
  await desktop.waitForFunction(() => Boolean(window.easypush), null, { timeout: 60_000 });

  const snapshot = () => desktop.evaluate(() => window.easypush.getSnapshot());
  const initial = await snapshot();
  assert.equal(initial.server.version, version, 'packaged version mismatch');
  assert.equal(initial.server.httpsEnabled, true, 'HTTPS listener not available');
  assert.match(initial.connect.code, /^\d{6}$/, 'pairing code missing');
  assert.equal(initial.server.dataDir, profileDir, 'packaged app did not honor --user-data-dir');
  console.log(`PASS packaged startup: v${initial.server.version}, http:${initial.server.httpPort}, https:${initial.server.httpsPort}`);

  await desktop.evaluate(() => window.easypush.updateSettings({ autoApprove: true }));

  browser = await chromium.launch({
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  });
  const origin = `https://127.0.0.1:${initial.server.httpsPort}`;
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 412, height: 915 } });
  const phone = await context.newPage();
  await phone.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
  await phone.waitForSelector('#screen-pair', { timeout: 30_000 });

  const { connect } = await snapshot();
  await phone.fill('#pair-code', connect.code);
  await phone.fill('#pair-name', '打包冒烟测试');
  await phone.click('#pair-submit');
  await phone.waitForSelector('#screen-app', { timeout: 30_000 });
  console.log('PASS packaged pairing over HTTPS');

  const png = await phone.screenshot();
  await phone.setInputFiles('#file-input', { name: 'packaged-smoke.png', mimeType: 'image/png', buffer: png });
  await phone.waitForSelector('.upload-row.is-ok', { timeout: 30_000 });
  const image = desktop.locator('img.media-image');
  await image.waitFor({ state: 'visible', timeout: 30_000 });
  await desktop.waitForFunction(
    () => {
      const node = document.querySelector('img.media-image');
      return node instanceof HTMLImageElement && node.naturalWidth > 0;
    },
    null,
    { timeout: 30_000 },
  );
  const media = await snapshot();
  assert.equal(media.media?.source, 'upload');
  assert.equal(media.media?.items[0]?.name, 'packaged-smoke.png');
  console.log('PASS packaged upload decode on desktop stage');

  console.log('PACKAGE VERIFY OK');
} finally {
  await browser?.close().catch(() => undefined);
  await app?.close().catch(() => undefined);
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
}

import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AppSnapshot } from '../../src/shared/types';

const repoRoot = path.resolve(__dirname, '..', '..');

export interface DesktopBridge {
  getSnapshot(): Promise<AppSnapshot>;
  updateSettings(patch: Record<string, unknown>): Promise<unknown>;
}

export interface TestApp {
  app: ElectronApplication;
  desktop: Page;
  dataDir: string;
  snapshot(): Promise<AppSnapshot>;
  updateSettings(patch: Record<string, unknown>): Promise<void>;
  close(): Promise<void>;
}

export async function launchTestApp(): Promise<TestApp> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'easypush-e2e-'));
  const app = await electron.launch({
    args: [repoRoot],
    env: {
      ...process.env,
      EASY_PUSH_DATA_DIR: dataDir,
      EASY_PUSH_USER_DATA: dataDir,
    },
  });
  const desktop = await app.firstWindow();
  await desktop.waitForSelector('#root');
  await desktop.waitForFunction(() => Boolean((window as unknown as { easypush?: unknown }).easypush));

  const snapshot = (): Promise<AppSnapshot> =>
    desktop.evaluate(() => (window as unknown as { easypush: DesktopBridge }).easypush.getSnapshot());

  const updateSettings = async (patch: Record<string, unknown>): Promise<void> => {
    await desktop.evaluate(
      (value) => (window as unknown as { easypush: DesktopBridge }).easypush.updateSettings(value),
      patch,
    );
  };

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await app.close().catch(() => undefined);
    await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
  };

  return { app, desktop, dataDir, snapshot, updateSettings, close };
}

export function listen(server: Server, host = '127.0.0.1'): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, host, () => {
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : 0);
    });
  });
}

export function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

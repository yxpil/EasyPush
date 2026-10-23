import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { DeviceInfo, HistoryEntry, Settings } from '../../shared/types';
import { defaultSettings, normalizeSettings, SCHEMA_VERSION } from './config';
import { randomId, randomToken } from './ids';
import type { Logger } from './logger';

export interface DeviceRecord extends DeviceInfo {
  credentialHash: string | null;
}

export interface PersistedState {
  schema: number;
  instanceId: string;
  serverSecret: string;
  bootCount: number;
  settings: Settings;
  devices: DeviceRecord[];
  history: HistoryEntry[];
}

export class Store {
  private state: PersistedState;
  private writeTimer: NodeJS.Timeout | null = null;
  private chain: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(
    private readonly file: string,
    private readonly logger: Logger,
  ) {
    this.state = emptyState();
  }

  async load(): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    try {
      const raw = await readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw) as Partial<PersistedState>;
      this.state = migrate(parsed);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        this.logger.error('store.load_failed', { error: String(error) });
        await rename(this.file, `${this.file}.corrupt-${Date.now()}`).catch(() => undefined);
        this.state = emptyState();
        await this.flush();
      }
    }
    this.state.bootCount += 1;
    this.markDirty();
  }

  get(): PersistedState {
    return this.state;
  }

  update(mutator: (state: PersistedState) => void): PersistedState {
    mutator(this.state);
    this.markDirty();
    return this.state;
  }

  setSettings(patch: Partial<Settings>): Settings {
    this.state.settings = normalizeSettings(patch, this.state.settings);
    this.markDirty();
    return this.state.settings;
  }

  addDevice(device: DeviceRecord): void {
    const existing = this.state.devices.findIndex((entry) => entry.id === device.id);
    if (existing >= 0) this.state.devices[existing] = device;
    else this.state.devices.push(device);
    if (this.state.devices.length > 500) {
      this.state.devices.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
      this.state.devices.splice(500);
    }
    this.markDirty();
  }

  addHistory(entry: HistoryEntry): void {
    this.state.history.unshift(entry);
    if (this.state.history.length > 200) this.state.history.length = 200;
    this.markDirty();
  }

  markDirty(): void {
    if (this.closed) return;
    if (this.writeTimer) clearTimeout(this.writeTimer);
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      void this.flush();
    }, 120);
  }

  async flush(): Promise<void> {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    const snapshot = JSON.stringify(this.state, null, 2);
    const temp = `${this.file}.tmp`;
    this.chain = this.chain
      .then(async () => {
        await mkdir(path.dirname(this.file), { recursive: true });
        await writeFile(temp, snapshot, { encoding: 'utf8', mode: 0o600 });
        await rename(temp, this.file);
      })
      .catch((error) => {
        this.logger.error('store.write_failed', { error: String(error) });
      });
    await this.chain;
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.flush();
  }
}

export function emptyState(): PersistedState {
  return {
    schema: SCHEMA_VERSION,
    instanceId: randomId(16),
    serverSecret: randomToken(32),
    bootCount: 0,
    settings: defaultSettings(),
    devices: [],
    history: [],
  };
}

function migrate(parsed: Partial<PersistedState>): PersistedState {
  const base = emptyState();
  const settings = normalizeSettings((parsed.settings ?? {}) as Partial<Settings>, base.settings);
  return {
    schema: SCHEMA_VERSION,
    instanceId: typeof parsed.instanceId === 'string' ? parsed.instanceId : base.instanceId,
    serverSecret: typeof parsed.serverSecret === 'string' && parsed.serverSecret.length >= 32 ? parsed.serverSecret : base.serverSecret,
    bootCount: Number.isInteger(parsed.bootCount) ? parsed.bootCount! : 0,
    settings,
    devices: Array.isArray(parsed.devices) ? parsed.devices.filter(isDeviceRecord).slice(0, 500) : [],
    history: Array.isArray(parsed.history) ? parsed.history.filter(isHistoryEntry).slice(0, 200) : [],
  };
}

function isDeviceRecord(value: unknown): value is DeviceRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record['id'] === 'string' && typeof record['name'] === 'string' && typeof record['platform'] === 'string';
}

function isHistoryEntry(value: unknown): value is HistoryEntry {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record['id'] === 'string' && typeof record['startedAt'] === 'number' && typeof record['kind'] === 'string';
}

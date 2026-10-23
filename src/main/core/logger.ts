import { appendFile, mkdir, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { LogLevel } from '../../shared/types';

export interface LogEntry {
  at: number;
  level: LogLevel;
  event: string;
  fields: Record<string, unknown>;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const REDACTED_KEYS = /token|secret|cookie|authorization|ticket|credential|password/i;

export class Logger {
  private buffer: LogEntry[] = [];
  private level: LogLevel;
  private writeChain: Promise<void> = Promise.resolve();
  private currentDay = '';
  private closed = false;

  constructor(
    private readonly dir: string,
    level: LogLevel,
    private readonly options: { console?: boolean; maxBuffer?: number; retentionDays?: number } = {},
  ) {
    this.level = level;
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  debug(event: string, fields: Record<string, unknown> = {}): void {
    this.write('debug', event, fields);
  }

  info(event: string, fields: Record<string, unknown> = {}): void {
    this.write('info', event, fields);
  }

  warn(event: string, fields: Record<string, unknown> = {}): void {
    this.write('warn', event, fields);
  }

  error(event: string, fields: Record<string, unknown> = {}): void {
    this.write('error', event, fields);
  }

  entries(limit = 200): LogEntry[] {
    return this.buffer.slice(-limit);
  }

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await this.prune();
  }

  async prune(): Promise<void> {
    const keep = this.options.retentionDays ?? 14;
    try {
      const files = await readdir(this.dir);
      const cutoff = Date.now() - keep * 24 * 60 * 60 * 1000;
      for (const file of files) {
        const match = /^easypush-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(file);
        if (!match) continue;
        const day = Date.parse(`${match[1]}T00:00:00`);
        if (Number.isFinite(day) && day < cutoff) {
          await unlink(path.join(this.dir, file)).catch(() => undefined);
        }
      }
    } catch {
      // best effort
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.writeChain.catch(() => undefined);
  }

  private write(level: LogLevel, event: string, fields: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level] || this.closed) return;
    const entry: LogEntry = { at: Date.now(), level, event, fields: redact(fields) };
    this.buffer.push(entry);
    const max = this.options.maxBuffer ?? 500;
    if (this.buffer.length > max) this.buffer.splice(0, this.buffer.length - max);

    if (this.options.console) {
      const line = `[${new Date(entry.at).toISOString()}] ${level.toUpperCase()} ${event}${Object.keys(entry.fields).length ? ' ' + safeJson(entry.fields) : ''}`;
      if (level === 'error') console.error(line);
      else if (level === 'warn') console.warn(line);
      else console.log(line);
    }

    const day = localDay(entry.at);
    if (day !== this.currentDay) {
      this.currentDay = day;
    }
    const file = path.join(this.dir, `easypush-${day}.jsonl`);
    const line = safeJson(entry) + '\n';
    this.writeChain = this.writeChain
      .then(() => appendFile(file, line, 'utf8'))
      .catch(() => undefined);
  }
}

function redact(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (REDACTED_KEYS.test(key)) {
      out[key] = '[redacted]';
    } else if (typeof value === 'string' && value.length > 512) {
      out[key] = value.slice(0, 512) + '…';
    } else {
      out[key] = value;
    }
  }
  return out;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '{"error":"unserializable"}';
  }
}

function localDay(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

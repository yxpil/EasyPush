import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HTTP_PORT,
  DEFAULT_HTTPS_PORT,
  SCHEMA_VERSION,
  defaultSettings,
  normalizeSettings,
} from '../../src/main/core/config';

describe('defaultSettings', () => {
  it('provides production defaults', () => {
    const settings = defaultSettings();
    expect(settings.schema).toBe(SCHEMA_VERSION);
    expect(settings.httpPort).toBe(DEFAULT_HTTP_PORT);
    expect(settings.httpsPort).toBe(DEFAULT_HTTPS_PORT);
    expect(settings.allowLive).toBe(true);
    expect(settings.allowDlna).toBe(true);
    expect(settings.volume).toBeGreaterThan(0);
    expect(settings.volume).toBeLessThanOrEqual(1);
    expect(settings.imageSlideMs).toBe(8000);
    expect(settings.logLevel).toBe('info');
    expect(settings.deviceName.length).toBeGreaterThan(0);
    expect(settings.deviceName.length).toBeLessThanOrEqual(40);
  });
});

describe('normalizeSettings', () => {
  const base = defaultSettings();

  it('sanitizes device names', () => {
    expect(normalizeSettings({ deviceName: '  客厅\u0000 电脑  ' }, base).deviceName).toBe('客厅 电脑');
    expect(normalizeSettings({ deviceName: 'x'.repeat(60) }, base).deviceName).toHaveLength(40);
    expect(normalizeSettings({ deviceName: '   ' }, base).deviceName).toBe(base.deviceName);
    expect(normalizeSettings({ deviceName: 42 as unknown as string }, base).deviceName).toBe(base.deviceName);
  });

  it('keeps ports inside the unprivileged range', () => {
    expect(normalizeSettings({ httpPort: 8000 }, base).httpPort).toBe(8000);
    expect(normalizeSettings({ httpPort: 80 }, base).httpPort).toBe(base.httpPort);
    expect(normalizeSettings({ httpPort: 70000 }, base).httpPort).toBe(base.httpPort);
    expect(normalizeSettings({ httpPort: 7333.5 }, base).httpPort).toBe(base.httpPort);
    expect(normalizeSettings({ httpsPort: 9443 }, base).httpsPort).toBe(9443);
    expect(normalizeSettings({ httpsPort: 1023 }, base).httpsPort).toBe(base.httpsPort);
  });

  it('clamps numeric ranges', () => {
    expect(normalizeSettings({ volume: -1 }, base).volume).toBe(0);
    expect(normalizeSettings({ volume: 2 }, base).volume).toBe(1);
    expect(normalizeSettings({ volume: Number.NaN }, base).volume).toBe(base.volume);
    expect(normalizeSettings({ imageSlideMs: 1000 }, base).imageSlideMs).toBe(2000);
    expect(normalizeSettings({ imageSlideMs: 800_000 }, base).imageSlideMs).toBe(600_000);
    expect(normalizeSettings({ imageSlideMs: 12_345 }, base).imageSlideMs).toBe(12_345);
  });

  it('accepts only typed booleans and known log levels', () => {
    expect(normalizeSettings({ allowDlna: false, allowLive: false, autoApprove: true }, base)).toMatchObject({
      allowDlna: false,
      allowLive: false,
      autoApprove: true,
    });
    expect(normalizeSettings({ autoApprove: 'yes' as unknown as boolean }, base).autoApprove).toBe(base.autoApprove);
    expect(normalizeSettings({ logLevel: 'debug' }, base).logLevel).toBe('debug');
    expect(normalizeSettings({ logLevel: 'trace' as unknown as 'info' }, base).logLevel).toBe(base.logLevel);
  });

  it('handles primaryAddress and forces the schema version', () => {
    expect(normalizeSettings({ primaryAddress: '10.0.0.2' }, base).primaryAddress).toBe('10.0.0.2');
    expect(normalizeSettings({ primaryAddress: null }, base).primaryAddress).toBeNull();
    expect(normalizeSettings({ primaryAddress: 7 as unknown as string }, base).primaryAddress).toBe(base.primaryAddress);
    expect(normalizeSettings({ schema: 99 } as never, base).schema).toBe(SCHEMA_VERSION);
  });

  it('does not mutate the current settings', () => {
    const current = defaultSettings();
    const snapshot = JSON.stringify(current);
    normalizeSettings({ deviceName: '新名字', volume: 0.1 }, current);
    expect(JSON.stringify(current)).toBe(snapshot);
  });
});

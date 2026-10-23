import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SESSION_TTL_MS } from '../../src/main/core/config';
import { Logger } from '../../src/main/core/logger';
import { Store } from '../../src/main/core/store';
import { PairingService, type PairingEvents, type PairingInput } from '../../src/main/services/pairing';
import type { PairingRequest } from '../../src/shared/types';

const dirs: string[] = [];
const services: PairingService[] = [];
const stores: Store[] = [];

async function setup(clockStart = 1_700_000_000_000) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'easypush-pair-'));
  dirs.push(dir);
  const logger = new Logger(path.join(dir, 'logs'), 'error', { console: false });
  const store = new Store(path.join(dir, 'state.json'), logger);
  await store.load();
  stores.push(store);
  let now = clockStart;
  const requestLog: PairingRequest[] = [];
  const resolvedLog: Array<{ id: string; approved: boolean }> = [];
  const events: PairingEvents = {
    changes: 0,
    changed() {
      this.changes += 1;
    },
    request(request) {
      requestLog.push(request);
    },
    resolved(request, approved) {
      resolvedLog.push({ id: request.id, approved });
    },
  } as PairingEvents & { changes: number };
  const service = new PairingService(
    store,
    logger,
    events,
    () => ({ http: 'http://10.0.0.5:7333', https: 'https://10.0.0.5:7443', ca: 'http://10.0.0.5:7333/ca.crt' }),
    () => now,
  );
  services.push(service);
  const input = (overrides: Partial<PairingInput> = {}): PairingInput => ({
    deviceName: '测试手机',
    clientId: 'abcdefghijklmnop',
    ip: '10.0.0.9',
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8)',
    ...overrides,
  });
  return {
    store,
    events,
    requestLog,
    resolvedLog,
    service,
    input,
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
  };
}

afterEach(async () => {
  for (const service of services.splice(0)) service.stop();
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('PairingService', () => {
  it('rejects wrong codes and returns a pending request for the right one', async () => {
    const { service, input, requestLog } = await setup();
    const bad = await service.beginCode(input(), '000000');
    expect(bad.status).toBe(401);
    expect(bad.result.error?.code).toBe('invalid-code');

    const code = service.currentCode();
    const outcome = await service.beginCode(input(), code);
    expect(outcome.status).toBe(202);
    expect(outcome.result.status).toBe('pending');
    expect(outcome.result.requestId).toBeTruthy();
    expect(requestLog).toHaveLength(1);
    expect(requestLog[0]).toMatchObject({ method: 'code', platform: 'android', ip: '10.0.0.9' });

    const pending = service.pollStatus(outcome.result.requestId!, '10.0.0.9');
    expect(pending.result.status).toBe('pending');
    expect(pending.token).toBeNull();
  });

  it('issues a session and remembered secret only after approval', async () => {
    const { service, input } = await setup();
    const outcome = await service.beginCode(input(), service.currentCode());
    const requestId = outcome.result.requestId!;
    const approved = service.decide(requestId, true, true);
    expect(approved?.id).toBe(requestId);

    const poll = service.pollStatus(requestId, '10.0.0.9');
    expect(poll.result.status).toBe('approved');
    expect(poll.token).toBeTruthy();
    expect(poll.result.deviceSecret).toBeTruthy();
    expect(poll.result.device?.name).toBe('测试手机');
    expect(service.verifyToken(poll.token)?.id).toBe('abcdefghijklmnop');

    const second = service.pollStatus(requestId, '10.0.0.9');
    expect(second.result.deviceSecret).toBeUndefined();

    const resumed = service.resume('abcdefghijklmnop', poll.result.deviceSecret, '10.0.0.9');
    expect(resumed.status).toBe(200);
    expect(service.verifyToken(resumed.token)?.id).toBe('abcdefghijklmnop');
    expect(service.resume('abcdefghijklmnop', 'wrong-secret-value-that-is-long', '10.0.0.9').status).toBe(401);
  });

  it('does not leak a request to a different IP', async () => {
    const { service, input } = await setup();
    const outcome = await service.beginCode(input(), service.currentCode());
    const other = service.pollStatus(outcome.result.requestId!, '10.0.0.10');
    expect(other.result.status).toBe('expired');
    expect(other.token).toBeNull();
  });

  it('supports denial and ticket pairing', async () => {
    const { service, input, resolvedLog } = await setup();
    const ticket = service.currentTicket();
    const outcome = await service.beginTicket(input({ deviceName: '二维码设备' }), ticket);
    expect(outcome.status).toBe(202);
    const requestId = outcome.result.requestId!;
    expect(service.decide(requestId, false, false)?.id).toBe(requestId);
    expect(service.pollStatus(requestId, '10.0.0.9').result.status).toBe('denied');
    expect(resolvedLog.at(-1)?.approved).toBe(false);
    expect(service.verifyToken('v1.dead.0.nonce.sig')).toBeNull();
  });

  it('auto-approves when the setting is enabled', async () => {
    const { service, store, input } = await setup();
    store.setSettings({ autoApprove: true });
    const outcome = await service.beginCode(input(), service.currentCode());
    expect(outcome.status).toBe(200);
    expect(outcome.result.status).toBe('approved');
    expect(service.verifyToken(outcome.token)?.id).toBe('abcdefghijklmnop');
  });

  it('rate-limits repeated code attempts per address', async () => {
    const { service, input } = await setup();
    const actual = service.currentCode();
    const wrong = actual === '000000' ? '111111' : '000000';
    for (let i = 0; i < 6; i += 1) {
      const attempt = await service.beginCode(input({ ip: '10.0.0.11' }), wrong);
      expect(attempt.status).toBe(401);
    }
    const blocked = await service.beginCode(input({ ip: '10.0.0.11' }), wrong);
    expect(blocked.status).toBe(429);
    expect(blocked.result.error?.code).toBe('rate-limited');
    const otherIp = await service.beginCode(input({ ip: '10.0.0.12' }), actual);
    expect(otherIp.status).toBe(202);
  });

  it('expires sessions and revokes devices', async () => {
    const { service, input, advance } = await setup();
    const outcome = await service.beginCode(input(), service.currentCode());
    service.decide(outcome.result.requestId!, true, false);
    const poll = service.pollStatus(outcome.result.requestId!, '10.0.0.9');
    const token = poll.token!;
    expect(service.verifyToken(token)).not.toBeNull();

    advance(SESSION_TTL_MS + 1);
    expect(service.verifyToken(token)).toBeNull();
    expect(service.revokeDevice('abcdefghijklmnop')).toBe(true);
    expect(service.revokeDevice('abcdefghijklmnop')).toBe(false);
  });
});

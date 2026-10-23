import { createPrivateKey, X509Certificate } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { domainToASCII } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { CertManager, type SecretBox } from '../../src/main/core/certs';
import { Logger } from '../../src/main/core/logger';

const dirs: string[] = [];

async function makeManager(hostname: string, ips: string[] = ['10.0.0.5', '127.0.0.1']) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'easypush-cert-'));
  dirs.push(root);
  const logger = new Logger(path.join(root, 'logs'), 'error', { console: false });
  const box: SecretBox = {
    available: false,
    encrypt: (plain) => Buffer.from(plain, 'utf8').toString('base64'),
    decrypt: (cipher) => {
      try {
        return Buffer.from(cipher, 'base64').toString('utf8');
      } catch {
        return null;
      }
    },
  };
  const manager = new CertManager(root, box, logger, 'test-instance');
  await manager.init(ips, hostname);
  return { manager, root };
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('CertManager', () => {
  it('issues a CA-signed leaf with IP and IDNA SANs', async () => {
    const { manager } = await makeManager('月华阁');
    const caPem = manager.getCaPem();
    const options = manager.httpsOptions();
    expect(caPem).toContain('BEGIN CERTIFICATE');
    expect(options?.cert).toContain('BEGIN CERTIFICATE');
    expect(options?.key).toContain('PRIVATE KEY');

    const leaf = new X509Certificate(options!.cert);
    const ca = new X509Certificate(caPem!);
    const punycode = domainToASCII('月华阁');
    expect(punycode).toMatch(/^xn--/);
    expect(leaf.checkIP('10.0.0.5')).toBe('10.0.0.5');
    expect(leaf.checkIP('127.0.0.1')).toBe('127.0.0.1');
    expect(leaf.checkHost(punycode)).toBe(punycode);
    expect(leaf.checkPrivateKey(createPrivateKey(options!.key))).toBe(true);
    expect(leaf.checkIssued(ca)).toBe(true);
    expect(ca.ca).toBe(true);
    expect(leaf.subjectAltName).toContain('IP Address:10.0.0.5');
    expect(leaf.subjectAltName).toContain(`DNS:${punycode}`);
    expect(manager.getSans()).toEqual(expect.arrayContaining(['10.0.0.5', '127.0.0.1', punycode]));
    expect(manager.getFingerprint()).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  });

  it('reloads the same material and leaves an unchanged SAN set alone', async () => {
    const first = await makeManager('office-pc');
    const firstCert = first.manager.httpsOptions()!.cert;
    const firstCa = first.manager.getCaPem();
    const firstFingerprint = first.manager.getFingerprint();

    const logger = new Logger(path.join(first.root, 'logs'), 'error', { console: false });
    const box: SecretBox = {
      available: false,
      encrypt: (plain) => Buffer.from(plain, 'utf8').toString('base64'),
      decrypt: (cipher) => Buffer.from(cipher, 'base64').toString('utf8'),
    };
    const reloaded = new CertManager(first.root, box, logger, 'test-instance');
    await reloaded.init(['10.0.0.5', '127.0.0.1'], 'office-pc');
    expect(reloaded.getCaPem()).toBe(firstCa);
    expect(reloaded.getFingerprint()).toBe(firstFingerprint);
    expect(reloaded.httpsOptions()!.cert).toBe(firstCert);
    expect(await reloaded.ensureSans(['10.0.0.5', '127.0.0.1'], 'office-pc')).toBe(false);

    expect(await reloaded.ensureSans(['10.0.0.6', '127.0.0.1'], 'office-pc')).toBe(true);
    const renewed = new X509Certificate(reloaded.httpsOptions()!.cert);
    expect(renewed.checkIP('10.0.0.6')).toBe('10.0.0.6');
    expect(reloaded.getCaPem()).toBe(firstCa);
    expect(reloaded.httpsOptions()!.cert).not.toBe(firstCert);
  });

  it('regenerates a leaf whose private key does not match the certificate', async () => {
    const { manager, root } = await makeManager('repair-host');
    const ca = manager.getCaPem();
    const fingerprint = manager.getFingerprint();
    const pem = await readFile(path.join(root, 'server.pem'), 'utf8');
    const keyPath = path.join(root, 'server-key.json');
    const storedKey = JSON.parse(await readFile(keyPath, 'utf8')) as { v: number; mode: string; data: string };
    await writeFile(path.join(root, 'server.pem'), pem.replace(/[A-Za-z0-9+/=]{40}/, 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'));
    expect(storedKey.mode).toBe('plain');

    const logger = new Logger(path.join(root, 'logs'), 'error', { console: false });
    const box: SecretBox = {
      available: false,
      encrypt: (plain) => Buffer.from(plain, 'utf8').toString('base64'),
      decrypt: (cipher) => Buffer.from(cipher, 'base64').toString('utf8'),
    };
    const repaired = new CertManager(root, box, logger, 'test-instance');
    await repaired.init(['10.0.0.5', '127.0.0.1'], 'repair-host');
    expect(repaired.getCaPem()).toBe(ca);
    expect(repaired.getFingerprint()).toBe(fingerprint);
    const regenerated = new X509Certificate(repaired.httpsOptions()!.cert);
    expect(regenerated.checkPrivateKey(createPrivateKey(repaired.httpsOptions()!.key))).toBe(true);
  });
});

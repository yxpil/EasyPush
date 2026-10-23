import { createHash, createPrivateKey, X509Certificate } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { domainToASCII } from 'node:url';
import forge from 'node-forge';
import type { Logger } from './logger';

export interface SecretBox {
  available: boolean;
  encrypt(plain: string): string;
  decrypt(cipher: string): string | null;
}

interface StoredSecret {
  v: 1;
  mode: 'safe' | 'plain';
  data: string;
}

interface CertMeta {
  v: 1;
  sans: string[];
  caCreatedAt: number;
  caExpiresAt: number;
  leafCreatedAt: number;
  leafExpiresAt: number;
  caFingerprint: string;
}

const DAY = 24 * 60 * 60 * 1000;
const CA_DAYS = 3650;
const LEAF_DAYS = 365;
const RENEW_BEFORE_DAYS = 30;

export class CertManager {
  private caPem: string | null = null;
  private caKeyPem: string | null = null;
  private leafPem: string | null = null;
  private leafKeyPem: string | null = null;
  private meta: CertMeta | null = null;
  private readonly caPath: string;
  private readonly caKeyPath: string;
  private readonly leafPath: string;
  private readonly leafKeyPath: string;
  private readonly metaPath: string;

  constructor(
    private readonly dir: string,
    private readonly box: SecretBox,
    private readonly logger: Logger,
    private instanceId: string,
  ) {
    this.caPath = path.join(dir, 'local-ca.pem');
    this.caKeyPath = path.join(dir, 'local-ca-key.json');
    this.leafPath = path.join(dir, 'server.pem');
    this.leafKeyPath = path.join(dir, 'server-key.json');
    this.metaPath = path.join(dir, 'meta.json');
  }

  setInstanceId(instanceId: string): void {
    this.instanceId = instanceId;
  }

  async init(ips: string[], hostname: string): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await this.loadExisting();
    const sans = buildSans(ips, hostname);
    const now = Date.now();
    const needsCa = !this.caPem || !this.caKeyPem || !this.meta || this.meta.caExpiresAt - now < 90 * DAY;
    if (needsCa) {
      await this.generateAll(sans);
      return;
    }
    const leafExpired = !this.leafPem || !this.leafKeyPem || !this.meta || this.meta.leafExpiresAt - now < RENEW_BEFORE_DAYS * DAY;
    const sansChanged = !sameSans(this.meta?.sans ?? [], sans);
    if (leafExpired || sansChanged) {
      await this.generateLeaf(sans);
    }
  }

  async ensureSans(ips: string[], hostname: string): Promise<boolean> {
    const sans = buildSans(ips, hostname);
    if (!this.meta || !this.caPem || !this.caKeyPem) {
      await this.init(ips, hostname);
      return true;
    }
    if (sameSans(this.meta.sans, sans)) return false;
    await this.generateLeaf(sans);
    return true;
  }

  httpsOptions(): { key: string; cert: string } | null {
    if (!this.leafPem || !this.leafKeyPem) return null;
    return { key: this.leafKeyPem, cert: this.leafPem };
  }

  getCaPem(): string | null {
    return this.caPem;
  }

  getFingerprint(): string | null {
    return this.meta?.caFingerprint ?? null;
  }

  getSans(): string[] {
    return this.meta?.sans ?? [];
  }

  private async loadExisting(): Promise<void> {
    try {
      const [caPem, caKeyStored, leafPem, leafKeyStored, metaRaw] = await Promise.all([
        readFile(this.caPath, 'utf8'),
        readFile(this.caKeyPath, 'utf8'),
        readFile(this.leafPath, 'utf8'),
        readFile(this.leafKeyPath, 'utf8'),
        readFile(this.metaPath, 'utf8'),
      ]);
      const caKey = decryptSecret(caKeyStored, this.box);
      const leafKey = decryptSecret(leafKeyStored, this.box);
      const meta = JSON.parse(metaRaw) as CertMeta;
      if (!caKey || !leafKey || !meta.caFingerprint) throw new Error('unreadable key material');
      if (!isValidKeyPair(caPem, caKey)) throw new Error('invalid CA certificate material');
      this.caPem = caPem;
      this.caKeyPem = caKey;
      this.meta = meta;
      if (isValidKeyPair(leafPem, leafKey)) {
        this.leafPem = leafPem;
        this.leafKeyPem = leafKey;
      } else {
        this.logger.warn('certs.leaf_invalid', { note: 'regenerating leaf certificate' });
      }
      this.logger.info('certs.loaded', { sans: meta.sans, caFingerprint: meta.caFingerprint });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') this.logger.warn('certs.load_failed', { error: String(error) });
      this.caPem = null;
      this.caKeyPem = null;
      this.leafPem = null;
      this.leafKeyPem = null;
      this.meta = null;
    }
  }

  private async generateAll(sans: string[]): Promise<void> {
    this.logger.info('certs.generate_ca');
    const caKeys = await generateKeyPair();
    const caCert = forge.pki.createCertificate();
    caCert.publicKey = caKeys.publicKey;
    caCert.serialNumber = randomSerial();
    const now = Date.now();
    caCert.validity.notBefore = new Date(now - DAY);
    caCert.validity.notAfter = new Date(now + CA_DAYS * DAY);
    const caAttrs = [
      { name: 'commonName', value: `EasyPush Local CA ${this.instanceId.slice(0, 8)}` },
      { name: 'organizationName', value: 'EasyPush' },
      { name: 'organizationalUnitName', value: 'Local Network' },
    ];
    caCert.setSubject(caAttrs);
    caCert.setIssuer(caAttrs);
    caCert.setExtensions([
      { name: 'basicConstraints', cA: true, critical: true },
      { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
      { name: 'subjectKeyIdentifier' },
    ]);
    caCert.sign(caKeys.privateKey, forge.md.sha256.create());

    this.caPem = forge.pki.certificateToPem(caCert);
    this.caKeyPem = forge.pki.privateKeyToPem(caKeys.privateKey);
    if (!isValidKeyPair(this.caPem, this.caKeyPem)) throw new Error('generated CA certificate is invalid');
    const fingerprint = fingerprintOf(caCert);
    this.meta = {
      v: 1,
      sans,
      caCreatedAt: now,
      caExpiresAt: caCert.validity.notAfter.getTime(),
      leafCreatedAt: 0,
      leafExpiresAt: 0,
      caFingerprint: fingerprint,
    };
    await this.generateLeaf(sans, caCert, caKeys.privateKey);
  }

  private async generateLeaf(sans: string[], caCertArg?: forge.pki.Certificate, caKeyArg?: forge.pki.PrivateKey): Promise<void> {
    if (!caCertArg || !caKeyArg) {
      if (!this.caPem || !this.caKeyPem) throw new Error('CA is not initialized');
      caCertArg = forge.pki.certificateFromPem(this.caPem);
      caKeyArg = forge.pki.privateKeyFromPem(this.caKeyPem);
    }
    this.logger.info('certs.generate_leaf', { sans });
    const keys = await generateKeyPair();
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = randomSerial();
    const now = Date.now();
    cert.validity.notBefore = new Date(now - DAY);
    cert.validity.notAfter = new Date(now + LEAF_DAYS * DAY);
    cert.setSubject([
      { name: 'commonName', value: primaryName(sans) },
      { name: 'organizationName', value: 'EasyPush' },
    ]);
    cert.setIssuer(caCertArg.subject.attributes);
    cert.setExtensions([
      { name: 'basicConstraints', cA: false, critical: true },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
      { name: 'extKeyUsage', serverAuth: true },
      {
        name: 'subjectAltName',
        altNames: sans.map((san) => (isIpv4OrIpv6(san) ? { type: 7, ip: san } : { type: 2, value: san })),
      },
      { name: 'subjectKeyIdentifier' },
      { name: 'authorityKeyIdentifier' },
    ]);
    cert.sign(caKeyArg, forge.md.sha256.create());

    this.leafPem = forge.pki.certificateToPem(cert);
    this.leafKeyPem = forge.pki.privateKeyToPem(keys.privateKey);
    if (!isValidKeyPair(this.leafPem, this.leafKeyPem)) throw new Error('generated server certificate is invalid');
    this.meta = {
      v: 1,
      sans,
      caCreatedAt: this.meta?.caCreatedAt ?? now,
      caExpiresAt: this.meta?.caExpiresAt ?? now + CA_DAYS * DAY,
      leafCreatedAt: now,
      leafExpiresAt: cert.validity.notAfter.getTime(),
      caFingerprint: this.meta?.caFingerprint ?? fingerprintOf(caCertArg),
    };
    await this.persist();
  }

  private async persist(): Promise<void> {
    if (!this.caPem || !this.caKeyPem || !this.leafPem || !this.leafKeyPem || !this.meta) return;
    await writeFile(this.caPath, this.caPem, { encoding: 'utf8', mode: 0o600 });
    await writeFile(this.leafPath, this.leafPem, { encoding: 'utf8', mode: 0o600 });
    await writeFile(this.caKeyPath, encryptSecret(this.caKeyPem, this.box), { encoding: 'utf8', mode: 0o600 });
    await writeFile(this.leafKeyPath, encryptSecret(this.leafKeyPem, this.box), { encoding: 'utf8', mode: 0o600 });
    await writeFile(this.metaPath, JSON.stringify(this.meta, null, 2), { encoding: 'utf8', mode: 0o600 });
  }
}

function generateKeyPair(): Promise<forge.pki.rsa.KeyPair> {
  return new Promise((resolve, reject) => {
    forge.pki.rsa.generateKeyPair({ bits: 2048, e: 0x10001 }, (error, keypair) => {
      if (error) reject(error);
      else resolve(keypair);
    });
  });
}

function buildSans(ips: string[], hostname: string): string[] {
  const set = new Set<string>(['localhost', '127.0.0.1']);
  for (const ip of ips) if (ip) set.add(ip);
  const host = normalizeHostname(hostname);
  if (host) {
    set.add(host);
    set.add(`${host}.local`);
  }
  return [...set].sort();
}

// node-forge corrupts ASN.1 when a DNS SAN contains non-ASCII text, so every
// name must reach the certificate in its IDNA (punycode) form.
function normalizeHostname(value: string): string | null {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed || /^\d{1,3}(\.\d{1,3}){3}$/.test(trimmed) || trimmed.includes(':')) return null;
  const ascii = domainToASCII(trimmed);
  if (!ascii) return null;
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(ascii) ? ascii : null;
}

function isValidKeyPair(certPem: string, keyPem: string): boolean {
  try {
    return new X509Certificate(certPem).checkPrivateKey(createPrivateKey(keyPem));
  } catch {
    return false;
  }
}

function sameSans(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((value, index) => value === sortedB[index]);
}

function primaryName(sans: string[]): string {
  return sans.find((san) => /^\d{1,3}(\.\d{1,3}){3}$/.test(san) && !san.startsWith('127.')) ?? 'EasyPush';
}

function isIpv4OrIpv6(value: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(value) || value.includes(':');
}

function randomSerial(): string {
  const bytes = forge.random.getBytesSync(16);
  return forge.util.bytesToHex(bytes);
}

function fingerprintOf(cert: forge.pki.Certificate): string {
  const der = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
  const digest = createHash('sha256').update(Buffer.from(der, 'binary')).digest('hex').toUpperCase();
  return digest.match(/.{2}/g)?.join(':') ?? digest;
}

function encryptSecret(plain: string, box: SecretBox): string {
  const stored: StoredSecret = box.available
    ? { v: 1, mode: 'safe', data: box.encrypt(plain) }
    : { v: 1, mode: 'plain', data: Buffer.from(plain, 'utf8').toString('base64') };
  return JSON.stringify(stored);
}

function decryptSecret(raw: string, box: SecretBox): string | null {
  try {
    const stored = JSON.parse(raw) as StoredSecret;
    if (stored.v !== 1) return null;
    if (stored.mode === 'safe') return box.decrypt(stored.data);
    return Buffer.from(stored.data, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

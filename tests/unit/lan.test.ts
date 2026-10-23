import os from 'node:os';
import { domainToASCII } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  isAllowedHostHeader,
  isLoopbackAddress,
  normalizeRemoteAddress,
} from '../../src/main/core/lan';

describe('remote address normalization', () => {
  it('unwraps IPv4-mapped IPv6 addresses', () => {
    expect(normalizeRemoteAddress('::ffff:192.168.1.5')).toBe('192.168.1.5');
    expect(normalizeRemoteAddress('::1')).toBe('::1');
    expect(normalizeRemoteAddress(undefined)).toBe('unknown');
  });

  it('detects loopback peers', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('127.5.6.7')).toBe(true);
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('192.168.1.5')).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
  });
});

describe('Host header allowlist', () => {
  const local = os.hostname().toLowerCase();

  it('accepts loopback, hostname and private addresses', () => {
    for (const host of [
      'localhost:7333',
      '127.0.0.1:7443',
      '192.168.1.5:7333',
      '10.0.0.2',
      '172.16.0.3:7333',
      '[::1]:7333',
      local,
      `${local}.local`,
    ]) {
      expect(isAllowedHostHeader(host), host).toBe(true);
    }
    expect(isAllowedHostHeader('easypush.lan:7333', ['easypush.lan'])).toBe(true);
    expect(isAllowedHostHeader(`${domainToASCII(local)}:7333`)).toBe(true);
    expect(isAllowedHostHeader(`${domainToASCII(local)}.local`)).toBe(true);
    expect(isAllowedHostHeader('xn--xkrx27b0k8a.local', ['月华阁'])).toBe(true);
  });

  it('rejects public, foreign and malformed hosts', () => {
    for (const host of ['evil.example', 'evil.example:7333', '8.8.8.8', '203.0.113.9:7333', '', 'bad host', 'http://evil.example', undefined]) {
      expect(isAllowedHostHeader(host), String(host)).toBe(false);
    }
    expect(isAllowedHostHeader('easypush.lan', ['other.lan'])).toBe(false);
  });
});

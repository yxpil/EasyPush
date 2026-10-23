import { describe, expect, it } from 'vitest';
import {
  defaultDeviceName,
  formatHms,
  isId,
  isPrivateIPv4,
  isSafeRemoteUrl,
  isSupportedMediaMime,
  isValidSdpAnswer,
  kindFromNameOrMime,
  parseClientMessage,
  parseDurationHms,
  platformFromUserAgent,
  sanitizeDeviceName,
} from '../../src/shared/protocol';

describe('parseClientMessage', () => {
  it('accepts a camera intent', () => {
    expect(parseClientMessage({ type: 'intent', media: 'camera', audio: true })).toEqual({
      ok: true,
      value: { type: 'intent', media: 'camera', audio: true },
    });
  });

  it('accepts an offer with a valid SDP', () => {
    const result = parseClientMessage({
      type: 'offer',
      media: 'screen',
      audio: false,
      sdp: { type: 'offer', sdp: 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n' },
    });
    expect(result.ok).toBe(true);
  });

  it('rejects malformed messages', () => {
    expect(parseClientMessage(null).ok).toBe(false);
    expect(parseClientMessage({ type: 'intent', media: 'tab', audio: true }).ok).toBe(false);
    expect(parseClientMessage({ type: 'intent', media: 'camera', audio: 'yes' }).ok).toBe(false);
    expect(parseClientMessage({ type: 'offer', media: 'camera', audio: true, sdp: { type: 'answer', sdp: 'v=0' } }).ok).toBe(false);
    expect(parseClientMessage({ type: 'offer', media: 'camera', audio: true, sdp: { type: 'offer', sdp: '' } }).ok).toBe(false);
    expect(parseClientMessage({ type: 'ping', t: 'now' }).ok).toBe(false);
    expect(parseClientMessage({ type: 'unknown' }).ok).toBe(false);
  });

  it('accepts a null ICE candidate and rejects oversized candidates', () => {
    expect(parseClientMessage({ type: 'ice', candidate: null }).ok).toBe(true);
    expect(parseClientMessage({ type: 'ice', candidate: { candidate: 'c'.repeat(5000), sdpMid: '0', sdpMLineIndex: 0 } }).ok).toBe(false);
  });

  it('validates resume ids and end reasons', () => {
    expect(parseClientMessage({ type: 'resume', sessionId: 'abcdefgh' }).ok).toBe(true);
    expect(parseClientMessage({ type: 'resume', sessionId: '../etc' }).ok).toBe(false);
    expect(parseClientMessage({ type: 'end', reason: 'x'.repeat(201) }).ok).toBe(false);
    expect(parseClientMessage({ type: 'end' }).ok).toBe(true);
  });

  it('validates SDP answers', () => {
    expect(isValidSdpAnswer({ type: 'answer', sdp: 'v=0' })).toBe(true);
    expect(isValidSdpAnswer({ type: 'offer', sdp: 'v=0' })).toBe(false);
    expect(isValidSdpAnswer('v=0')).toBe(false);
  });
});

describe('device identity helpers', () => {
  it('derives platform and default names from user agents', () => {
    expect(platformFromUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)')).toBe('ios');
    expect(platformFromUserAgent('Mozilla/5.0 (Linux; Android 14)')).toBe('android');
    expect(platformFromUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('windows');
    expect(platformFromUserAgent('SomethingElse')).toBe('other');
    expect(defaultDeviceName('Mozilla/5.0 (iPad; CPU OS 17_0)')).toBe('iPad');
    expect(defaultDeviceName('Mozilla/5.0 (Linux; Android 14)')).toBe('Android 设备');
  });

  it('sanitizes names and falls back when empty', () => {
    expect(sanitizeDeviceName('  客厅\u0000手机  ', '')).toBe('客厅手机');
    expect(sanitizeDeviceName('x'.repeat(80), '')).toHaveLength(48);
    expect(sanitizeDeviceName('', 'Mozilla/5.0 (Windows NT 10.0)')).toBe('Windows 电脑');
    expect(sanitizeDeviceName(42, 'Mozilla/5.0 (iPhone)')).toBe('iPhone');
  });

  it('validates ids', () => {
    expect(isId('abcdEFGH1234_-')).toBe(true);
    expect(isId('short')).toBe(false);
    expect(isId('has space')).toBe(false);
  });
});

describe('network classification', () => {
  it('recognizes private IPv4 ranges', () => {
    for (const ip of ['10.0.0.1', '172.16.0.1', '172.31.255.254', '192.168.1.1', '169.254.1.1', '127.0.0.1', '100.64.0.1']) {
      expect(isPrivateIPv4(ip), ip).toBe(true);
    }
    for (const ip of ['8.8.8.8', '172.32.0.1', '192.169.0.1', '11.0.0.1', '1.2.3', '1.2.3.256', 'abc']) {
      expect(isPrivateIPv4(ip), ip).toBe(false);
    }
  });

  it('accepts only http(s) remote urls', () => {
    expect(isSafeRemoteUrl('https://example.com/a.mp4')).toBe(true);
    expect(isSafeRemoteUrl('http://127.0.0.1:8123/a.png')).toBe(true);
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'data:image/png;base64,AA', 'ftp://example.com/a.mp4', 'not a url', '']) {
      expect(isSafeRemoteUrl(url), url).toBe(false);
    }
    expect(isSafeRemoteUrl(`https://example.com/${'a'.repeat(2100)}`)).toBe(false);
  });
});

describe('media classification', () => {
  it('infers kinds from extension or mime', () => {
    expect(kindFromNameOrMime('photo.HEIC', '')).toBe('image');
    expect(kindFromNameOrMime('audio', 'audio/mpeg')).toBe('audio');
    expect(kindFromNameOrMime('stream.m3u8', '')).toBe('video');
    expect(kindFromNameOrMime('file', 'application/octet-stream')).toBe('video');
  });

  it('validates supported mime families', () => {
    expect(isSupportedMediaMime('')).toBe(true);
    expect(isSupportedMediaMime('video/mp4')).toBe(true);
    expect(isSupportedMediaMime('image/png')).toBe(true);
    expect(isSupportedMediaMime('application/vnd.apple.mpegurl')).toBe(true);
    expect(isSupportedMediaMime('application/pdf')).toBe(false);
    expect(isSupportedMediaMime('text/plain')).toBe(false);
  });
});

describe('duration formatting', () => {
  it('parses DLNA hms durations', () => {
    expect(parseDurationHms('0:01:05')).toBe(65);
    expect(parseDurationHms('01:02:03.500')).toBe(3723.5);
    expect(parseDurationHms('1:2:3')).toBe(3723);
    expect(parseDurationHms('nope')).toBeNull();
    expect(parseDurationHms(42)).toBeNull();
  });

  it('formats hms with milliseconds', () => {
    expect(formatHms(0)).toBe('0:00:00.000');
    expect(formatHms(3723.5)).toBe('1:02:03.500');
    expect(formatHms(Number.NaN)).toBe('0:00:00.000');
    expect(formatHms(-5)).toBe('0:00:00.000');
  });
});

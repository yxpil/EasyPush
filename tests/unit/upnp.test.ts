import { describe, expect, it } from 'vitest';
import {
  UpnpError,
  buildAvtLastChange,
  buildDeviceDescription,
  buildDidl,
  buildRcsLastChange,
  deviceUuid,
  escapeXml,
  formatDidlDuration,
  itemFromDidl,
  parseDidl,
  parseSoapRequest,
  propertySet,
  soapEnvelope,
  soapFault,
  transportStateFor,
  unescapeXml,
} from '../../src/main/dlna/upnp';
import type { MediaItem } from '../../src/shared/types';

const soap = (action: string, inner: string) =>
  `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:${action} xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">${inner}</u:${action}></s:Body></s:Envelope>`;

describe('device description', () => {
  it('produces a stable version-5 style uuid', () => {
    const uuid = deviceUuid('instance-1');
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(uuid).toBe(deviceUuid('instance-1'));
    expect(uuid).not.toBe(deviceUuid('instance-2'));
  });

  it('escapes the friendly name and exposes every service endpoint', () => {
    const xml = buildDeviceDescription({ uuid: 'abc', friendlyName: '<月&阁>', version: '1.0', serverHeader: 'x' });
    expect(xml).toContain('<friendlyName>&lt;月&amp;阁&gt;</friendlyName>');
    expect(xml).toContain('urn:schemas-upnp-org:device:MediaRenderer:1');
    for (const service of ['AVTransport', 'RenderingControl', 'ConnectionManager']) {
      expect(xml).toContain(`urn:upnp-org:serviceId:${service}`);
      expect(xml).toContain(`/dlna/control/${service}`);
      expect(xml).toContain(`/dlna/event/${service}`);
    }
    expect(xml).toContain('<UDN>uuid:abc</UDN>');
    expect(xml).toContain('DMR-1.50');
  });

  it('round-trips XML escaping', () => {
    const raw = `a&b <c> "d" 'e'`;
    expect(unescapeXml(escapeXml(raw))).toBe(raw);
  });
});

describe('SOAP parsing', () => {
  it('reads action and arguments', () => {
    const parsed = parseSoapRequest(soap('Play', '<InstanceID>0</InstanceID><Speed>1</Speed>'), '"urn:schemas-upnp-org:service:AVTransport:1#Play"');
    expect(parsed).toEqual({ action: 'Play', args: { InstanceID: '0', Speed: '1' } });
  });

  it('rejects a mismatched SOAPACTION header', () => {
    expect(() => parseSoapRequest(soap('Play', '<InstanceID>0</InstanceID>'), '"urn:x#Stop"')).toThrowError(UpnpError);
    try {
      parseSoapRequest(soap('Play', '<InstanceID>0</InstanceID>'), '"urn:x#Stop"');
    } catch (error) {
      expect((error as UpnpError).code).toBe(401);
    }
  });

  it('rejects malformed envelopes', () => {
    for (const body of ['', '<not-xml', '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"></s:Envelope>']) {
      try {
        parseSoapRequest(body, undefined);
        expect.unreachable('should throw');
      } catch (error) {
        expect(error).toBeInstanceOf(UpnpError);
        expect((error as UpnpError).code).toBe(402);
      }
    }
  });

  it('builds envelopes and faults with escaped values', () => {
    const xml = soapEnvelope('AVTransport', 'SetAVTransportURI', { InstanceID: 0, CurrentURI: 'http://x/a?b=1&c=2' });
    expect(xml).toContain('<u:SetAVTransportURIResponse');
    expect(xml).toContain('http://x/a?b=1&amp;c=2');
    const fault = soapFault(new UpnpError(701, '不支持 <此格式>'));
    expect(fault).toContain('<errorCode>701</errorCode>');
    expect(fault).toContain('不支持 &lt;此格式&gt;');
  });
});

describe('DIDL', () => {
  const item: MediaItem = {
    id: 'id-1',
    kind: 'video',
    name: '<演示>&.mp4',
    mime: 'video/mp4',
    size: 1234,
    url: 'http://10.0.0.2/media/id-1?sig=a&b=1',
    source: 'upload',
    sourceLabel: '10.0.0.9',
    addedAt: 1,
    durationSec: 3661,
  };

  it('parses metadata and prefers http-get resources', () => {
    const xml = `<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/"><item id="1" restricted="1"><dc:title>测试\u0001 图片</dc:title><upnp:class>object.item.imageItem.photo</upnp:class><res protocolInfo="rtsp-rtp-udp:*:image/png:*">rtsp://x</res><res protocolInfo="http-get:*:image/png:*" duration="0:01:05" size="99">http://10.0.0.2/a.png</res></item></DIDL-Lite>`;
    const info = parseDidl(xml, 'http://fallback');
    expect(info).toEqual({ title: '测试 图片', mime: 'image/png', durationSec: 65, size: 99, kind: 'image', url: 'http://10.0.0.2/a.png' });
  });

  it('falls back safely for empty or malformed metadata', () => {
    expect(parseDidl(undefined, 'http://fallback')).toMatchObject({ url: 'http://fallback', title: null });
    expect(parseDidl('<broken', 'http://fallback')).toMatchObject({ url: 'http://fallback' });
    expect(parseDidl('<DIDL-Lite><item><dc:title>x</dc:title></item></DIDL-Lite>', 'http://fallback').url).toBe('http://fallback');
  });

  it('builds escaped metadata and recovers it', () => {
    const xml = buildDidl(item);
    expect(xml).toContain('&lt;演示&gt;&amp;.mp4');
    expect(xml).toContain('duration="1:01:01"');
    expect(xml).toContain('size="1234"');
    expect(xml).toContain('http://10.0.0.2/media/id-1?sig=a&amp;b=1');
    const info = parseDidl(xml, item.url);
    expect(info).toMatchObject({ title: '<演示>&.mp4', mime: 'video/mp4', durationSec: 3661, size: 1234, kind: 'video', url: item.url });
    expect(buildDidl(null)).toBe('');
  });

  it('merges parsed info with fallbacks', () => {
    const merged = itemFromDidl(
      { title: null, mime: null, durationSec: null, size: null, kind: null, url: null },
      { url: 'http://x/photo.jpg', title: 'photo.jpg', mime: 'application/octet-stream', kind: 'video', sourceLabel: 'ip' },
    );
    expect(merged).toMatchObject({ url: 'http://x/photo.jpg', title: 'photo.jpg', mime: 'image/jpeg', kind: 'image', sourceLabel: 'ip' });
  });
});

describe('transport and event helpers', () => {
  it('maps playback states to UPnP transport states', () => {
    expect(transportStateFor('playing', false)).toBe('NO_MEDIA_PRESENT');
    expect(transportStateFor('playing', true)).toBe('PLAYING');
    expect(transportStateFor('paused', true)).toBe('PAUSED_PLAYBACK');
    expect(transportStateFor('loading', true)).toBe('TRANSITIONING');
    expect(transportStateFor('ended', true)).toBe('STOPPED');
    expect(transportStateFor('error', true)).toBe('STOPPED');
  });

  it('escapes AVTransport LastChange values', () => {
    const xml = buildAvtLastChange({
      transportState: 'PLAYING',
      actions: 'Play,Pause',
      uri: 'http://x/a?b=1&c=2',
      metadata: '<DIDL-Lite/>',
      duration: '0:01:05',
      track: 1,
      trackCount: 2,
      trackUri: 'http://x/b',
    });
    expect(xml).toContain('<TransportState val="PLAYING"/>');
    expect(xml).toContain('<AVTransportURI val="http://x/a?b=1&amp;c=2"/>');
    expect(xml).toContain('&lt;DIDL-Lite/&gt;');
    expect(xml).toContain('<NumberOfTracks val="2"/>');
    expect(xml).toContain('<CurrentTrack val="1"/>');
  });

  it('formats rendering control and duration values', () => {
    const xml = buildRcsLastChange(42.6, true);
    expect(xml).toContain('Volume channel="Master" val="43"');
    expect(xml).toContain('Mute channel="Master" val="1"');
    expect(formatDidlDuration(3661)).toBe('1:01:01');
    expect(formatDidlDuration(59)).toBe('0:00:59');
    expect(formatDidlDuration(-1)).toBe('0:00:00');
    expect(propertySet('<LastChange>x</LastChange>')).toContain('<e:property><LastChange>x</LastChange></e:property>');
  });
});

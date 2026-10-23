import dgram from 'node:dgram';
import http from 'node:http';
import { expect, test } from '@playwright/test';
import type { IncomingHttpHeaders } from 'node:http';
import type { AppSnapshot } from '../../src/shared/types';
import { closeServer, launchTestApp, listen, type TestApp } from './harness';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const AVT = 'urn:schemas-upnp-org:service:AVTransport:1';
const RCS = 'urn:schemas-upnp-org:service:RenderingControl:1';
const CM = 'urn:schemas-upnp-org:service:ConnectionManager:1';

interface RawResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

interface Notification {
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
}

interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: Buffer | string;
  timeoutMs?: number;
}

function request(target: string, options: RequestOptions = {}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const url = new URL(target);
    const body = options.body === undefined ? null : Buffer.isBuffer(options.body) ? options.body : Buffer.from(options.body);
    const headers: Record<string, string> = { ...options.headers };
    if (body) headers['Content-Length'] = String(body.length);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: options.method ?? 'GET',
        headers,
        agent: false,
        timeout: options.timeoutMs ?? 15_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      },
    );
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
    if (body) req.end(body);
    else req.end();
  });
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function soap(service: 'AVTransport' | 'RenderingControl' | 'ConnectionManager', type: string, action: string, args: Record<string, string | number> = {}): Promise<RawResponse> {
  const payload = Object.entries(args)
    .map(([key, value]) => `<${key}>${escapeXml(String(value))}</${key}>`)
    .join('');
  const body = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
<s:Body><u:${action} xmlns:u="${type}">${payload}</u:${action}></s:Body></s:Envelope>`;
  return request(`http://127.0.0.1:${httpPort}/dlna/control/${service}`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml; charset="utf-8"', SOAPAction: `"${type}#${action}"` },
    body,
  });
}

async function searchSsdp(): Promise<string> {
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject);
      socket.bind(0, '0.0.0.0', () => resolve());
    });
    const reply = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no SSDP response within 8s')), 8000);
      socket.on('message', (message) => {
        const text = message.toString('utf8');
        if (!text.includes('MediaRenderer') || !/LOCATION:/i.test(text)) return;
        clearTimeout(timer);
        resolve(text);
      });
      socket.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    const query = [
      'M-SEARCH * HTTP/1.1',
      'HOST: 239.255.255.250:1900',
      'MAN: "ssdp:discover"',
      'MX: 1',
      'ST: urn:schemas-upnp-org:device:MediaRenderer:1',
      '',
      '',
    ].join('\r\n');
    for (let attempt = 0; attempt < 3; attempt += 1) {
      socket.send(Buffer.from(query), 1900, '239.255.255.250');
      socket.send(Buffer.from(query), 1900, '127.0.0.1');
    }
    return await reply;
  } finally {
    socket.close();
  }
}

function waitForNotification(predicate: (entry: Notification) => boolean, timeoutMs = 15_000): Promise<Notification> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      const found = notifications.find(predicate);
      if (found) {
        clearInterval(timer);
        resolve(found);
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error('notification not received'));
      }
    }, 100);
  });
}

function faultCode(response: RawResponse): string {
  return /<errorCode>(\d+)<\/errorCode>/.exec(response.body.toString('utf8'))?.[1] ?? '';
}

let app: TestApp;
let snapshot: AppSnapshot;
let httpPort: number;
let mediaServer: http.Server;
let eventServer: http.Server;
let photoUrl: string;
let eventPort: number;
let avtSid = '';
let rcsSid = '';
const notifications: Notification[] = [];

function didl(title: string, url: string): string {
  return `<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/"><item id="1" parentID="0" restricted="1"><dc:title>${escapeXml(title)}</dc:title><upnp:class>object.item.imageItem.photo</upnp:class><res protocolInfo="http-get:*:image/png:*" size="${PNG.length}">${escapeXml(url)}</res></item></DIDL-Lite>`;
}

test.describe.configure({ mode: 'serial' });

test.describe('DLNA MediaRenderer', () => {
  test.beforeAll(async () => {
    app = await launchTestApp();
    snapshot = await app.snapshot();
    httpPort = snapshot.server.httpPort;
    expect(httpPort).toBeGreaterThan(0);
    await expect
      .poll(async () => (await app.snapshot()).server.dlna, { timeout: 20_000 })
      .toMatchObject({ enabled: true, active: true, port: 1900 });
    const dlna = (await app.snapshot()).server.dlna;
    expect(dlna.location).toMatch(new RegExp(`^http://\\S+:${httpPort}/dlna/description\\.xml$`));

    mediaServer = http.createServer((req, res) => {
      if (req.url === '/photo.png') {
        res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': PNG.length });
        res.end(PNG);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const mediaPort = await listen(mediaServer);
    photoUrl = `http://127.0.0.1:${mediaPort}/photo.png`;

    eventServer = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        notifications.push({
          path: req.url ?? '',
          headers: req.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
        res.writeHead(200, { 'Content-Length': 0 });
        res.end();
      });
    });
    eventPort = await listen(eventServer);
  });

  test.afterAll(async () => {
    if (mediaServer) await closeServer(mediaServer);
    if (eventServer) await closeServer(eventServer);
    await app?.close();
  });

  test('announces itself over SSDP and serves a valid device description', async () => {
    const response = await searchSsdp();
    expect(response.startsWith('HTTP/1.1 200 OK')).toBe(true);
    expect(response).toContain('ST: urn:schemas-upnp-org:device:MediaRenderer:1');
    expect(response).toContain('USN: uuid:');
    const location = /LOCATION: (.+)/i.exec(response)?.[1]?.trim() ?? '';
    expect(location).toMatch(new RegExp(`:${httpPort}/dlna/description\\.xml$`));
    expect(/BOOTID\.UPNP\.ORG: \d+/.test(response)).toBe(true);

    const description = await request(`http://127.0.0.1:${httpPort}/dlna/description.xml`);
    expect(description.status).toBe(200);
    expect(description.headers['content-type']).toContain('text/xml');
    const xml = description.body.toString('utf8');
    expect(xml).toContain('urn:schemas-upnp-org:device:MediaRenderer:1');
    expect(xml).toContain('DMR-1.50');
    expect(xml).toContain('<manufacturer>EasyPush</manufacturer>');
    for (const service of [AVT, RCS, CM]) {
      expect(xml).toContain(`<serviceType>${service}</serviceType>`);
    }
    for (const scpd of ['AVTransport.xml', 'RenderingControl.xml', 'ConnectionManager.xml']) {
      const responseScpd = await request(`http://127.0.0.1:${httpPort}/dlna/scpd/${scpd}`);
      expect(responseScpd.status).toBe(200);
      expect(responseScpd.body.toString('utf8')).toContain('urn:schemas-upnp-org:service-1-0');
    }
    const avtScpd = (await request(`http://127.0.0.1:${httpPort}/dlna/scpd/AVTransport.xml`)).body.toString('utf8');
    for (const action of ['SetAVTransportURI', 'GetTransportInfo', 'GetPositionInfo', 'Play', 'Pause', 'Stop', 'Seek']) {
      expect(avtScpd).toContain(`<name>${action}</name>`);
    }
  });

  test('subscribes to GENA events and enforces callback rules', async () => {
    const avt = await request(`http://127.0.0.1:${httpPort}/dlna/event/AVTransport`, {
      method: 'SUBSCRIBE',
      headers: { CALLBACK: `<http://127.0.0.1:${eventPort}/events>`, NT: 'upnp:event', TIMEOUT: 'Second-300' },
    });
    expect(avt.status).toBe(200);
    avtSid = String(avt.headers['sid'] ?? '');
    expect(avtSid).toMatch(/^uuid:[0-9a-f-]{36}$/);
    expect(avt.headers['timeout']).toBe('Second-300');

    const rcs = await request(`http://127.0.0.1:${httpPort}/dlna/event/RenderingControl`, {
      method: 'SUBSCRIBE',
      headers: { CALLBACK: `<http://127.0.0.1:${eventPort}/events>`, NT: 'upnp:event', TIMEOUT: 'Second-300' },
    });
    expect(rcs.status).toBe(200);
    rcsSid = String(rcs.headers['sid'] ?? '');
    expect(rcsSid).not.toBe(avtSid);

    const initial = await waitForNotification((entry) => entry.headers['sid'] === avtSid);
    expect(initial.headers['nt']).toBe('upnp:event');
    expect(initial.headers['nts']).toBe('upnp:propchange');
    expect(initial.headers['seq']).toBe('0');
    expect(initial.body).toContain('e:propertyset');
    expect(initial.body).toContain('LastChange');
    expect(initial.body).toContain('TransportState');
    expect(initial.body).toContain('NO_MEDIA_PRESENT');

    const foreignCallback = await request(`http://127.0.0.1:${httpPort}/dlna/event/ConnectionManager`, {
      method: 'SUBSCRIBE',
      headers: { CALLBACK: `<http://127.0.0.2:${eventPort}/events>`, NT: 'upnp:event' },
    });
    expect(foreignCallback.status).toBe(403);

    const badNt = await request(`http://127.0.0.1:${httpPort}/dlna/event/ConnectionManager`, {
      method: 'SUBSCRIBE',
      headers: { CALLBACK: `<http://127.0.0.1:${eventPort}/events>`, NT: 'upnp:other' },
    });
    expect(badNt.status).toBe(412);

    const unknownRenew = await request(`http://127.0.0.1:${httpPort}/dlna/event/ConnectionManager`, {
      method: 'SUBSCRIBE',
      headers: { SID: 'uuid:00000000-0000-0000-0000-000000000000', TIMEOUT: 'Second-300' },
    });
    expect(unknownRenew.status).toBe(412);

    const cm = await request(`http://127.0.0.1:${httpPort}/dlna/event/ConnectionManager`, {
      method: 'SUBSCRIBE',
      headers: { CALLBACK: `<http://127.0.0.1:${eventPort}/events>`, NT: 'upnp:event', TIMEOUT: 'Second-120' },
    });
    expect(cm.status).toBe(200);
    const cmSid = String(cm.headers['sid'] ?? '');
    expect(cmSid).toMatch(/^uuid:/);

    const renewed = await request(`http://127.0.0.1:${httpPort}/dlna/event/ConnectionManager`, {
      method: 'SUBSCRIBE',
      headers: { SID: cmSid, TIMEOUT: 'Second-600' },
    });
    expect(renewed.status).toBe(200);
    expect(renewed.headers['sid']).toBe(cmSid);
    expect(renewed.headers['timeout']).toBe('Second-600');

    const unsubscribed = await request(`http://127.0.0.1:${httpPort}/dlna/event/ConnectionManager`, {
      method: 'UNSUBSCRIBE',
      headers: { SID: cmSid },
    });
    expect(unsubscribed.status).toBe(200);
    const unsubscribeAgain = await request(`http://127.0.0.1:${httpPort}/dlna/event/ConnectionManager`, {
      method: 'UNSUBSCRIBE',
      headers: { SID: cmSid },
    });
    expect(unsubscribeAgain.status).toBe(412);
  });

  test('renders a pushed image and reports UPnP transport state', async () => {
    const setUri = await soap('AVTransport', AVT, 'SetAVTransportURI', {
      InstanceID: 0,
      CurrentURI: photoUrl,
      CurrentURIMetaData: didl('DLNA E2E 图片', photoUrl),
    });
    expect(setUri.status).toBe(200);
    expect(setUri.body.toString('utf8')).toContain('SetAVTransportURIResponse');

    const stopped = await soap('AVTransport', AVT, 'GetTransportInfo', { InstanceID: 0 });
    expect(stopped.body.toString('utf8')).toContain('PAUSED_PLAYBACK');
    const mediaInfo = await soap('AVTransport', AVT, 'GetMediaInfo', { InstanceID: 0 });
    const mediaInfoBody = mediaInfo.body.toString('utf8');
    expect(mediaInfoBody).toContain('<NrTracks>1</NrTracks>');
    expect(mediaInfoBody).toContain(photoUrl);
    expect(mediaInfoBody).toContain('DLNA E2E 图片');
    expect(mediaInfoBody).toContain('NETWORK');

    const play = await soap('AVTransport', AVT, 'Play', { InstanceID: 0, Speed: 1 });
    expect(play.status).toBe(200);

    const image = app.desktop.locator('img.media-image');
    await expect(image).toBeVisible({ timeout: 20_000 });
    await expect.poll(async () => image.evaluate((node) => (node as HTMLImageElement).naturalWidth), { timeout: 20_000 }).toBeGreaterThan(0);

    await expect
      .poll(
        async () => {
          const media = (await app.snapshot()).media;
          return media ? { source: media.source, kind: media.items[0]?.kind, state: media.state } : null;
        },
        { timeout: 20_000 },
      )
      .toMatchObject({ source: 'dlna', kind: 'image', state: 'playing' });
    await expect
      .poll(async () => (await soap('AVTransport', AVT, 'GetTransportInfo', { InstanceID: 0 })).body.toString('utf8'), {
        timeout: 20_000,
      })
      .toContain('PLAYING');

    const position = await soap('AVTransport', AVT, 'GetPositionInfo', { InstanceID: 0 });
    expect(position.body.toString('utf8')).toContain(`<TrackURI>${photoUrl}</TrackURI>`);
    const actions = await soap('AVTransport', AVT, 'GetCurrentTransportActions', { InstanceID: 0 });
    expect(actions.body.toString('utf8')).toContain('Pause,Stop');

    const playingNotification = await waitForNotification(
      (entry) => entry.headers['sid'] === avtSid && entry.body.includes('PLAYING'),
    );
    expect(playingNotification.body).toContain('AVTransportURI');

    const volume = await soap('RenderingControl', RCS, 'SetVolume', { InstanceID: 0, Channel: 'Master', DesiredVolume: 35 });
    expect(volume.status).toBe(200);
    await expect
      .poll(async () => (await app.snapshot()).settings.volume, { timeout: 10_000 })
      .toBeCloseTo(0.35, 5);
    const volumeNotification = await waitForNotification(
      (entry) => entry.headers['sid'] === rcsSid && /Volume[^>]*35/.test(entry.body),
    );
    expect(volumeNotification.body).toContain('urn:schemas-upnp-org:metadata-1-0/RCS/');

    const getVolume = await soap('RenderingControl', RCS, 'GetVolume', { InstanceID: 0, Channel: 'Master' });
    expect(getVolume.body.toString('utf8')).toContain('<CurrentVolume>35</CurrentVolume>');

    const protocolInfo = await soap('ConnectionManager', CM, 'GetProtocolInfo');
    const protocolBody = protocolInfo.body.toString('utf8');
    expect(protocolBody).toContain('http-get:*:image/png:*');
    expect(protocolBody).toContain('http-get:*:video/mp4:*');

    const stop = await soap('AVTransport', AVT, 'Stop', { InstanceID: 0 });
    expect(stop.status).toBe(200);
    await expect.poll(async () => (await app.snapshot()).media, { timeout: 10_000 }).toBeNull();
    const afterStop = await soap('AVTransport', AVT, 'GetTransportInfo', { InstanceID: 0 });
    expect(afterStop.body.toString('utf8')).toContain('NO_MEDIA_PRESENT');
    const afterStopNotification = await waitForNotification(
      (entry) => entry.headers['sid'] === avtSid && entry.body.includes('NO_MEDIA_PRESENT'),
    );
    expect(afterStopNotification.body).toContain('TransportState');
  });

  test('returns UPnP faults for invalid input and oversized SOAP bodies', async () => {
    const badUri = await soap('AVTransport', AVT, 'SetAVTransportURI', {
      InstanceID: 0,
      CurrentURI: 'ftp://example.com/media.png',
      CurrentURIMetaData: '',
    });
    expect(badUri.status).toBe(500);
    expect(faultCode(badUri)).toBe('716');

    const badInstance = await soap('AVTransport', AVT, 'GetTransportInfo', { InstanceID: 7 });
    expect(badInstance.status).toBe(500);
    expect(faultCode(badInstance)).toBe('718');

    const noMedia = await soap('AVTransport', AVT, 'Play', { InstanceID: 0, Speed: 1 });
    expect(noMedia.status).toBe(500);
    expect(faultCode(noMedia)).toBe('701');

    const invalidAction = await soap('AVTransport', AVT, 'BogusAction', { InstanceID: 0 });
    expect(invalidAction.status).toBe(500);
    expect(faultCode(invalidAction)).toBe('401');

    const oversized = await request(`http://127.0.0.1:${httpPort}/dlna/control/AVTransport`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml; charset="utf-8"', SOAPAction: `"${AVT}#GetTransportInfo"` },
      body: Buffer.alloc(140 * 1024, 0x78),
    });
    expect(oversized.status).toBe(500);
    expect(faultCode(oversized)).toBe('402');
  });

  test('drops event subscriptions on request', async () => {
    for (const sid of [avtSid, rcsSid]) {
      const response = await request(`http://127.0.0.1:${httpPort}/dlna/event/${sid === avtSid ? 'AVTransport' : 'RenderingControl'}`, {
        method: 'UNSUBSCRIBE',
        headers: { SID: sid },
      });
      expect(response.status).toBe(200);
    }
  });
});

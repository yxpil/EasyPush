import { createHash } from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';
import type { MediaItem, MediaKind } from '../../shared/types';
import { kindFromNameOrMime, parseDurationHms } from '../../shared/protocol';
import { normalizeMime } from '../services/mediaLibrary';

export const DLNA_DEVICE_TYPE = 'urn:schemas-upnp-org:device:MediaRenderer:1';
export const SERVICE_TYPES = {
  AVTransport: 'urn:schemas-upnp-org:service:AVTransport:1',
  RenderingControl: 'urn:schemas-upnp-org:service:RenderingControl:1',
  ConnectionManager: 'urn:schemas-upnp-org:service:ConnectionManager:1',
} as const;
export type DlnaService = keyof typeof SERVICE_TYPES;

export const SERVICE_PATHS: Record<DlnaService, { scpd: string; control: string; event: string }> = {
  AVTransport: { scpd: 'scpd/AVTransport.xml', control: 'control/AVTransport', event: 'event/AVTransport' },
  RenderingControl: { scpd: 'scpd/RenderingControl.xml', control: 'control/RenderingControl', event: 'event/RenderingControl' },
  ConnectionManager: { scpd: 'scpd/ConnectionManager.xml', control: 'control/ConnectionManager', event: 'event/ConnectionManager' },
};

export const SINK_PROTOCOL_INFO = [
  'http-get:*:video/mp4:*',
  'http-get:*:video/webm:*',
  'http-get:*:video/x-matroska:*',
  'http-get:*:video/quicktime:*',
  'http-get:*:video/ogg:*',
  'http-get:*:application/vnd.apple.mpegurl:*',
  'http-get:*:audio/mpeg:*',
  'http-get:*:audio/mp4:*',
  'http-get:*:audio/aac:*',
  'http-get:*:audio/flac:*',
  'http-get:*:audio/wav:*',
  'http-get:*:audio/ogg:*',
  'http-get:*:image/jpeg:*',
  'http-get:*:image/png:*',
  'http-get:*:image/gif:*',
  'http-get:*:image/webp:*',
  'http-get:*:image/avif:*',
].join(',');

export class UpnpError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = 'UpnpError';
  }
}

export function deviceUuid(instanceId: string): string {
  const hex = createHash('sha256').update(`easypush-dmr:${instanceId}`).digest('hex').slice(0, 32);
  const chars = [...hex];
  chars[12] = '5';
  const variant = (Number.parseInt(chars[16] ?? '8', 16) & 0x3) | 0x8;
  chars[16] = variant.toString(16);
  const value = chars.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

export function buildDeviceDescription(options: {
  uuid: string;
  friendlyName: string;
  version: string;
  serverHeader: string;
}): string {
  const services = (Object.keys(SERVICE_TYPES) as DlnaService[])
    .map(
      (service) => `<service>
<serviceType>${SERVICE_TYPES[service]}</serviceType>
<serviceId>urn:upnp-org:serviceId:${service === 'AVTransport' ? 'AVTransport' : service === 'RenderingControl' ? 'RenderingControl' : 'ConnectionManager'}</serviceId>
<SCPDURL>${SERVICE_PATHS[service].scpd}</SCPDURL>
<controlURL>/${'dlna/'}${SERVICE_PATHS[service].control}</controlURL>
<eventSubURL>/${'dlna/'}${SERVICE_PATHS[service].event}</eventSubURL>
</service>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>
<root xmlns="urn:schemas-upnp-org:device-1-0" configId="1">
<specVersion><major>1</major><minor>0</minor></specVersion>
<device>
<deviceType>${DLNA_DEVICE_TYPE}</deviceType>
<friendlyName>${escapeXml(options.friendlyName)}</friendlyName>
<manufacturer>EasyPush</manufacturer>
<modelDescription>局域网投屏接收器</modelDescription>
<modelName>EasyPush Media Renderer</modelName>
<modelNumber>${escapeXml(options.version)}</modelNumber>
<serialNumber>${options.uuid.slice(0, 8)}</serialNumber>
<UDN>uuid:${options.uuid}</UDN>
<dlna:X_DLNADOC xmlns:dlna="urn:schemas-dlna-org:device-1-0">DMR-1.50</dlna:X_DLNADOC>
<serviceList>
${services}
</serviceList>
</device>
</root>
`;
}

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

export function soapEnvelope(service: DlnaService, action: string, args: Record<string, string | number> = {}): string {
  const payload = Object.entries(args)
    .map(([key, value]) => `<${key}>${escapeXml(String(value))}</${key}>`)
    .join('');
  return `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
<s:Body>
<u:${action}Response xmlns:u="${SERVICE_TYPES[service]}">${payload}</u:${action}Response>
</s:Body>
</s:Envelope>`;
}

export function soapFault(error: UpnpError): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
<s:Body>
<s:Fault>
<faultcode>s:Client</faultcode>
<faultstring>UPnPError</faultstring>
<detail>
<UPnPError xmlns="urn:schemas-upnp-org:control-1-0">
<errorCode>${error.code}</errorCode>
<errorDescription>${escapeXml(error.message)}</errorDescription>
</UPnPError>
</detail>
</s:Fault>
</s:Body>
</s:Envelope>`;
}

export interface ParsedSoap {
  action: string;
  args: Record<string, string>;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: true,
  processEntities: true,
});

export function parseSoapRequest(body: string, soapActionHeader: string | undefined): ParsedSoap {
  let parsed: unknown;
  try {
    parsed = parser.parse(body);
  } catch {
    throw new UpnpError(402, 'Invalid Args');
  }
  const envelope = isRecord(parsed) ? parsed : {};
  const envelopeBody = isRecord(envelope['Envelope']) ? envelope['Envelope'] : envelope;
  const bodyNode = isRecord(envelopeBody['Body']) ? envelopeBody['Body'] : null;
  if (!bodyNode) throw new UpnpError(402, 'Invalid Args');
  const actionKey = Object.keys(bodyNode).find((key) => key !== '#text' && key !== '@_encodingStyle');
  if (!actionKey) throw new UpnpError(402, 'Invalid Args');
  const headerAction = soapActionHeader?.split('#').pop()?.replace(/"/g, '').trim();
  if (headerAction && headerAction !== actionKey) throw new UpnpError(401, 'Invalid Action');
  const argNode = bodyNode[actionKey];
  const args: Record<string, string> = {};
  if (isRecord(argNode)) {
    for (const [key, value] of Object.entries(argNode)) {
      if (key.startsWith('@_') || key === '#text') continue;
      if (typeof value === 'string') args[key] = value;
      else if (typeof value === 'number' || typeof value === 'boolean') args[key] = String(value);
    }
  }
  return { action: actionKey, args };
}

export interface DidlInfo {
  title: string | null;
  mime: string | null;
  durationSec: number | null;
  size: number | null;
  kind: MediaKind | null;
  url: string | null;
}

export function parseDidl(xml: string | undefined, fallbackUrl: string): DidlInfo {
  const fallback: DidlInfo = {
    title: null,
    mime: null,
    durationSec: null,
    size: null,
    kind: null,
    url: fallbackUrl,
  };
  if (!xml || xml.trim().length === 0) return fallback;
  let parsed: unknown;
  try {
    parsed = parser.parse(xml);
  } catch {
    return fallback;
  }
  const root = isRecord(parsed) ? parsed : {};
  const didl = isRecord(root['DIDL-Lite']) ? root['DIDL-Lite'] : root;
  const itemRaw = didl['item'] ?? didl['container'] ?? null;
  const item = Array.isArray(itemRaw) ? itemRaw[0] : itemRaw;
  if (!isRecord(item)) return fallback;
  const title = typeof item['title'] === 'string' ? item['title'] : null;
  const upnpClass = typeof item['class'] === 'string' ? item['class'] : '';
  const resRaw = item['res'];
  const res = Array.isArray(resRaw) ? resRaw : resRaw ? [resRaw] : [];
  let chosen: Record<string, unknown> | null = null;
  for (const entry of res) {
    if (!isRecord(entry)) continue;
    const url = typeof entry['#text'] === 'string' ? entry['#text'].trim() : '';
    if (!url) continue;
    if (!chosen) chosen = entry;
    const protocol = typeof entry['@_protocolInfo'] === 'string' ? entry['@_protocolInfo'] : '';
    if (/^http-get:/i.test(protocol)) {
      chosen = entry;
      break;
    }
  }
  if (!chosen) return { ...fallback, title };
  const protocolInfo = typeof chosen['@_protocolInfo'] === 'string' ? chosen['@_protocolInfo'] : '';
  const mimeFromProtocol = protocolInfo.split(':')[2]?.trim() || null;
  const url = typeof chosen['#text'] === 'string' ? chosen['#text'].trim() : fallbackUrl;
  const durationAttr = typeof chosen['@_duration'] === 'string' ? chosen['@_duration'] : '';
  const sizeRaw = typeof chosen['@_size'] === 'string' ? Number(chosen['@_size']) : NaN;
  let kind: MediaKind | null = null;
  if (/audioItem/i.test(upnpClass)) kind = 'audio';
  else if (/imageItem/i.test(upnpClass)) kind = 'image';
  else if (/videoItem/i.test(upnpClass)) kind = 'video';
  return {
    title: title ? sanitizeTitle(title) : null,
    mime: mimeFromProtocol,
    durationSec: parseDurationHms(durationAttr),
    size: Number.isFinite(sizeRaw) && sizeRaw > 0 ? sizeRaw : null,
    kind,
    url,
  };
}

export function buildDidl(item: MediaItem | null): string {
  if (!item) return '';
  const upnpClass = item.kind === 'image' ? 'object.item.imageItem.photo' : item.kind === 'audio' ? 'object.item.audioItem.musicTrack' : 'object.item.videoItem';
  const duration = item.durationSec && item.durationSec > 0 ? ` duration="${formatDidlDuration(item.durationSec)}"` : '';
  const size = item.size ? ` size="${item.size}"` : '';
  return `<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/"><item id="${escapeXml(item.id)}" parentID="0" restricted="1"><dc:title>${escapeXml(item.name)}</dc:title><upnp:class>${upnpClass}</upnp:class><res protocolInfo="http-get:*:${escapeXml(item.mime)}:*"${duration}${size}>${escapeXml(item.url)}</res></item></DIDL-Lite>`;
}

export function itemFromDidl(info: DidlInfo, fallback: { url: string; title: string; mime: string; kind: MediaKind; sourceLabel: string }): {
  url: string;
  title: string;
  mime: string;
  kind: MediaKind;
  sourceLabel: string;
  durationSec: number | null;
  size: number | null;
} {
  const url = info.url || fallback.url;
  const mime = normalizeMime(info.mime ?? fallback.mime, url);
  return {
    url,
    title: info.title || fallback.title,
    mime,
    kind: info.kind ?? kindFromNameOrMime(fallback.title || url, mime),
    sourceLabel: fallback.sourceLabel,
    durationSec: info.durationSec,
    size: info.size,
  };
}

export function transportStateFor(state: string, hasMedia: boolean): string {
  if (!hasMedia) return 'NO_MEDIA_PRESENT';
  switch (state) {
    case 'playing':
      return 'PLAYING';
    case 'paused':
      return 'PAUSED_PLAYBACK';
    case 'loading':
      return 'TRANSITIONING';
    case 'error':
    case 'ended':
      return 'STOPPED';
    default:
      return 'STOPPED';
  }
}

export function buildAvtLastChange(state: {
  transportState: string;
  actions: string;
  uri: string;
  metadata: string;
  duration: string;
  track: number;
  trackCount: number;
  trackUri: string;
}): string {
  const inner = `<Event xmlns="urn:schemas-upnp-org:metadata-1-0/AVT/"><InstanceID val="0"><TransportState val="${state.transportState}"/><TransportStatus val="OK"/><CurrentTransportActions val="${escapeXml(state.actions)}"/><AVTransportURI val="${escapeXml(state.uri)}"/><AVTransportURIMetaData val="${escapeXml(state.metadata)}"/><CurrentTrackURI val="${escapeXml(state.trackUri)}"/><CurrentTrackDuration val="${state.duration}"/><CurrentMediaDuration val="${state.duration}"/><NumberOfTracks val="${state.trackCount}"/><CurrentTrack val="${state.track}"/><PlaybackStorageMedium val="NETWORK"/><CurrentPlayMode val="NORMAL"/></InstanceID></Event>`;
  return inner;
}

export function buildRcsLastChange(volume: number, muted: boolean): string {
  return `<Event xmlns="urn:schemas-upnp-org:metadata-1-0/RCS/"><InstanceID val="0"><Volume channel="Master" val="${Math.round(volume)}"/><Mute channel="Master" val="${muted ? 1 : 0}"/></InstanceID></Event>`;
}

export function formatDidlDuration(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export function propertySet(inner: string): string {
  return `<?xml version="1.0" encoding="utf-8"?><e:propertyset xmlns:e="urn:schemas-upnp-org:event-1-0"><e:property>${inner}</e:property></e:propertyset>`;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function sanitizeTitle(title: string): string {
  return title.replace(/\p{Cc}/gu, '').trim().slice(0, 160) || 'DLNA 媒体';
}

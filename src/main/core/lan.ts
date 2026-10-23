import os from 'node:os';
import { domainToASCII } from 'node:url';
import { isPrivateIPv4 } from '../../shared/protocol';
import type { AddressInfo } from '../../shared/types';

export interface LanInterface {
  name: string;
  address: string;
  netmask: string;
  private: boolean;
  virtual: boolean;
}

const VIRTUAL_PATTERN =
  /vEthernet|VMware|VirtualBox|Hyper-V|WSL|Loopback|Tailscale|ZeroTier|WireGuard|OpenVPN|TAP-|TUN|Docker|veth|br-|utun|awdl|llw|Bluetooth|Npcap|Wintun|VPN/i;
const WIFI_PATTERN = /Wi-?Fi|WLAN|Wireless|无线|AirPort/i;
const ETHERNET_PATTERN = /Ethernet|以太网|en\d|eth\d|LAN/i;

export function detectLanInterfaces(): LanInterface[] {
  const out: LanInterface[] = [];
  for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
    for (const info of addresses ?? []) {
      if (info.family !== 'IPv4' || info.internal) continue;
      out.push({
        name,
        address: info.address,
        netmask: info.netmask,
        private: isPrivateIPv4(info.address),
        virtual: VIRTUAL_PATTERN.test(name),
      });
    }
  }
  return out;
}

export function scoreInterface(iface: LanInterface): number {
  let score = 0;
  if (iface.private) score += 100;
  if (iface.address.startsWith('192.168.')) score += 20;
  if (iface.address.startsWith('10.')) score += 10;
  if (iface.virtual) score -= 120;
  if (iface.address.startsWith('169.254.')) score -= 40;
  if (iface.address.startsWith('100.')) score -= 30;
  if (WIFI_PATTERN.test(iface.name)) score += 30;
  else if (ETHERNET_PATTERN.test(iface.name)) score += 25;
  return score;
}

export function pickLanInterface(ifaces: LanInterface[], preferredAddress: string | null): LanInterface | null {
  if (preferredAddress) {
    const preferred = ifaces.find((iface) => iface.address === preferredAddress);
    if (preferred) return preferred;
  }
  return [...ifaces].sort((a, b) => scoreInterface(b) - scoreInterface(a))[0] ?? null;
}

export function buildAddressInfos(
  ifaces: LanInterface[],
  httpPort: number,
  httpsPort: number | null,
  primary: LanInterface | null,
): AddressInfo[] {
  return ifaces
    .map((iface) => ({
      address: iface.address,
      iface: iface.name,
      url: `http://${iface.address}:${httpPort}`,
      httpsUrl: httpsPort ? `https://${iface.address}:${httpsPort}` : null,
      primary: primary?.address === iface.address,
      virtual: iface.virtual,
    }))
    .sort((a, b) => Number(b.primary) - Number(a.primary) || Number(a.virtual) - Number(b.virtual));
}

export function normalizeRemoteAddress(address: string | undefined): string {
  if (!address) return 'unknown';
  if (address.startsWith('::ffff:')) return address.slice(7);
  return address;
}

export function isLoopbackAddress(address: string | undefined): boolean {
  const normalized = normalizeRemoteAddress(address);
  return normalized === '::1' || normalized === '127.0.0.1' || normalized.startsWith('127.');
}

export function isAllowedHostHeader(hostHeader: string | undefined, extraHosts: string[] = []): boolean {
  if (!hostHeader) return false;
  let hostname: string;
  try {
    hostname = new URL(`http://${hostHeader}`).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (hostname.startsWith('[') && hostname.endsWith(']')) hostname = hostname.slice(1, -1);
  if (hostname === 'localhost' || hostname === '::1') return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return isPrivateIPv4(hostname);
  // URL parsing IDNA-encodes Unicode hostnames, while os.hostname() can stay Unicode.
  const normalized = domainToASCII(hostname) || hostname;
  const local = os.hostname().toLowerCase();
  const localNames = [local, `${local}.local`, ...extraHosts.map((host) => host.trim().toLowerCase())].map(
    (name) => domainToASCII(name) || name,
  );
  return localNames.includes(normalized);
}

export function parseHostHeader(hostHeader: string | undefined): string | null {
  if (!hostHeader) return null;
  try {
    return new URL(`http://${hostHeader}`).host.toLowerCase();
  } catch {
    return null;
  }
}

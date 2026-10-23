import { defaultDeviceName } from '../src/shared/protocol';

const NAME_KEY = 'easypush.device-name';
const clientKey = () => `easypush.client-id:${location.host}`;
const secretKey = () => `easypush.device-secret:${location.host}`;

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // private mode or storage disabled; pairing still works for this page load
  }
}

function randomToken(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  let binary = '';
  for (const byte of buffer) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function clientId(): string {
  const existing = read(clientKey());
  if (existing && /^[a-zA-Z0-9_-]{12,64}$/.test(existing)) return existing;
  const id = randomToken(16);
  write(clientKey(), id);
  return id;
}

export function storedSecret(): string | null {
  return read(secretKey());
}

export function storeSecret(secret: string | null): void {
  write(secretKey(), secret);
}

export function defaultName(): string {
  return defaultDeviceName(navigator.userAgent);
}

export function displayName(): string {
  return read(NAME_KEY) ?? defaultName();
}

export function saveName(name: string): string {
  const cleaned = name.replace(/\p{Cc}/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 48);
  const value = cleaned || defaultName();
  write(NAME_KEY, value);
  return value;
}

export function clearCredentials(): void {
  write(secretKey(), null);
}

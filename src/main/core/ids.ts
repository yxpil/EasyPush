import { randomBytes } from 'node:crypto';

export function randomId(bytes = 12): string {
  return randomBytes(bytes).toString('base64url');
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function randomDigits(length: number): string {
  let out = '';
  while (out.length < length) {
    for (const byte of randomBytes(length)) {
      if (byte < 250) out += String(byte % 10);
      if (out.length >= length) break;
    }
  }
  return out;
}

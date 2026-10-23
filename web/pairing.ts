import type { PairStartResponse } from '../src/shared/types';
import { ApiError, api } from './api';
import { clientId, clearCredentials, displayName, saveName, storeSecret, storedSecret } from './identity';

export type BeginResult =
  | { status: 'approved' }
  | { status: 'pending'; requestId: string }
  | { status: 'error'; message: string };

export type ApprovalOutcome = 'approved' | 'denied' | 'expired';

function normalize(response: PairStartResponse): BeginResult {
  if (response.status === 'approved') {
    if (response.deviceSecret) storeSecret(response.deviceSecret);
    return { status: 'approved' };
  }
  if (response.status === 'pending' && response.requestId) {
    return { status: 'pending', requestId: response.requestId };
  }
  return {
    status: 'error',
    message: response.error?.message ?? '配对未完成，请重新输入配对码',
  };
}

export async function beginWithTicket(ticket: string, name: string): Promise<BeginResult> {
  const saved = saveName(name);
  return normalize(await api.pairTicket(ticket, saved, clientId()));
}

export async function beginWithCode(code: string, name: string): Promise<BeginResult> {
  const saved = saveName(name);
  return normalize(await api.pairCode(code, saved, clientId()));
}

export async function waitForApproval(
  requestId: string,
  signal: AbortSignal,
  onExpiry: (expiresAt: number | null) => void,
): Promise<ApprovalOutcome> {
  let failures = 0;
  for (;;) {
    if (signal.aborted) throw new DOMException('已取消', 'AbortError');
    try {
      const status = await api.pairStatus(requestId);
      failures = 0;
      onExpiry(status.expiresAt ?? null);
      if (status.status === 'approved') {
        if (status.deviceSecret) storeSecret(status.deviceSecret);
        return 'approved';
      }
      if (status.status === 'denied') return 'denied';
      if (status.status === 'expired') return 'expired';
    } catch (error) {
      if (signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
        throw new DOMException('已取消', 'AbortError');
      }
      failures += 1;
      if (failures >= 4) throw error;
    }
    await delay(1400, signal);
  }
}

export async function resumeStoredSession(): Promise<boolean> {
  const secret = storedSecret();
  if (!secret) return false;
  try {
    const response = await api.pairResume(clientId(), secret);
    if (response.status === 'approved') return true;
    clearCredentials();
  } catch (error) {
    if (error instanceof ApiError && (error.status === 401 || error.status === 403)) clearCredentials();
  }
  return false;
}

export async function signOut(): Promise<void> {
  await api.signOut();
  clearCredentials();
}

export function pairingName(): string {
  return displayName();
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('已取消', 'AbortError'));
      return;
    }
    const timer = window.setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      window.clearTimeout(timer);
      reject(new DOMException('已取消', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

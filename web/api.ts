import type {
  MeResponse,
  PairStartResponse,
  PairStatusResponse,
  ServerHealth,
  UploadResponse,
} from '../src/shared/types';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

function errorFrom(status: number, data: unknown): ApiError {
  let code = `http-${status}`;
  let message = status === 0 ? '无法连接电脑，请确认 EasyPush 正在运行' : '请求失败，请稍后重试';
  if (typeof data === 'object' && data !== null) {
    const error = (data as Record<string, unknown>)['error'];
    if (typeof error === 'object' && error !== null) {
      const record = error as Record<string, unknown>;
      if (typeof record['code'] === 'string') code = record['code'];
      if (typeof record['message'] === 'string') message = record['message'];
    }
  }
  return new ApiError(status, code, message);
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      credentials: 'same-origin',
      cache: 'no-store',
      ...init,
    });
  } catch {
    throw new ApiError(0, 'network', '无法连接电脑，请检查 Wi-Fi 后重试');
  }
  let data: unknown = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  if (!response.ok) throw errorFrom(response.status, data);
  return data as T;
}

function post<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export const api = {
  health(): Promise<ServerHealth> {
    return request<ServerHealth>('/api/health');
  },
  me(): Promise<MeResponse> {
    return request<MeResponse>('/api/me');
  },
  pairTicket(ticket: string, deviceName: string, clientId: string): Promise<PairStartResponse> {
    return post<PairStartResponse>('/api/pair/ticket', { ticket, deviceName, clientId });
  },
  pairCode(code: string, deviceName: string, clientId: string): Promise<PairStartResponse> {
    return post<PairStartResponse>('/api/pair/code', { code, deviceName, clientId });
  },
  pairResume(clientId: string, deviceSecret: string): Promise<PairStartResponse> {
    return post<PairStartResponse>('/api/pair/resume', { clientId, deviceSecret });
  },
  pairStatus(requestId: string): Promise<PairStatusResponse> {
    return request<PairStatusResponse>(`/api/pair/status?id=${encodeURIComponent(requestId)}`);
  },
  signOut(): Promise<{ ok: boolean }> {
    return post<{ ok: boolean }>('/api/pair/signout', {});
  },
  castUrl(url: string): Promise<UploadResponse> {
    return post<UploadResponse>('/api/cast/url', { url });
  },
};

export function uploadFile(file: File, onProgress: (ratio: number) => void, signal?: AbortSignal, append = false): Promise<UploadResponse> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('已取消上传', 'AbortError'));
      return;
    }
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload');
    xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name));
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    if (append) xhr.setRequestHeader('X-EasyPush-Append', '1');
    const abort = () => xhr.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const cleanup = () => signal?.removeEventListener('abort', abort);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) onProgress(Math.min(1, event.loaded / event.total));
    };
    xhr.onload = () => {
      cleanup();
      let data: unknown = null;
      try {
        data = JSON.parse(xhr.responseText) as unknown;
      } catch {
        data = null;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(data as UploadResponse);
        return;
      }
      reject(errorFrom(xhr.status, data));
    };
    xhr.onerror = () => {
      cleanup();
      reject(new ApiError(0, 'network', '上传中断，请检查网络后重试'));
    };
    xhr.onabort = () => {
      cleanup();
      reject(new DOMException('已取消上传', 'AbortError'));
    };
    xhr.send(file);
  });
}

export function isUnauthorized(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}

export function errorText(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof DOMException && error.name === 'AbortError') return '已取消';
  if (error instanceof Error && error.message) return error.message;
  return '发生未知错误，请重试';
}

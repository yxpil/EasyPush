import type { DesktopApi, Platform } from '../shared/types';

declare global {
  interface Window {
    easypush: DesktopApi;
  }
}

export const api: DesktopApi = window.easypush;

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand('copy');
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

export function platformLabel(platform: Platform): string {
  switch (platform) {
    case 'ios':
      return 'iPhone / iPad';
    case 'android':
      return 'Android';
    case 'windows':
      return 'Windows';
    case 'macos':
      return 'macOS';
    case 'linux':
      return 'Linux';
    default:
      return '未知设备';
  }
}

export function sourceLabel(source: string): string {
  switch (source) {
    case 'upload':
      return '手机上传';
    case 'local':
      return '本机文件';
    case 'url':
      return '网络地址';
    case 'dlna':
      return 'DLNA 推送';
    default:
      return source;
  }
}

export function errorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  return '操作失败，请稍后重试';
}

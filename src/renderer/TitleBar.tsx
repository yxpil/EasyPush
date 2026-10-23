import type { ServerInfo } from '../shared/types';
import { Icon } from './Icons';

interface TitleBarProps {
  server: ServerInfo;
  deviceName: string;
  liveActive: boolean;
  onOpenSettings(): void;
  onOpenLogs(): void;
  onCopyAddress(): void;
}

export function TitleBar({ server, deviceName, liveActive, onOpenSettings, onOpenLogs, onCopyAddress }: TitleBarProps) {
  const url = server.primaryUrl?.replace(/^https?:\/\//, '') ?? '未联网';
  return (
    <header className="titlebar">
      <div className="titlebar-brand">
        <span className="brand-mark" aria-hidden="true">
          <Icon name="cast" size={18} />
        </span>
        <span className="brand-name">EasyPush</span>
        <span className="brand-divider" />
        <span className="brand-device">{deviceName}</span>
      </div>

      <button type="button" className="titlebar-status" onClick={onCopyAddress} title="复制访问地址">
        <span className={`status-dot ${liveActive ? 'is-live' : ''}`} />
        <span className="status-label">{liveActive ? '正在投屏' : '服务运行中'}</span>
        <span className="status-url">{url}</span>
        <Icon name="copy" size={13} />
      </button>

      <div className="titlebar-actions no-drag">
        <button type="button" className="icon-btn" onClick={onOpenLogs} title="运行日志" aria-label="运行日志">
          <Icon name="logs" size={17} />
        </button>
        <button type="button" className="icon-btn" onClick={onOpenSettings} title="设置" aria-label="设置">
          <Icon name="settings" size={17} />
        </button>
        <span className="window-divider" />
        <button
          type="button"
          className="icon-btn window-btn"
          onClick={() => window.easypush.windowAction('minimize')}
          title="最小化"
          aria-label="最小化"
        >
          <Icon name="minimize" size={16} />
        </button>
        <button
          type="button"
          className="icon-btn window-btn"
          onClick={() => window.easypush.windowAction('toggle-maximize')}
          title="最大化 / 还原"
          aria-label="最大化或还原"
        >
          <Icon name="maximize" size={13} />
        </button>
        <button
          type="button"
          className="icon-btn window-btn close"
          onClick={() => window.easypush.windowAction('close')}
          title="关闭"
          aria-label="关闭"
        >
          <Icon name="close" size={16} />
        </button>
      </div>
    </header>
  );
}

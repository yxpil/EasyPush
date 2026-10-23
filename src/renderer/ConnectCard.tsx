import { useState } from 'react';
import type { ConnectInfo, ServerInfo } from '../shared/types';
import { api, copyText } from './api';
import { Icon, Spinner } from './Icons';
import { clockLeft, secondsLeft, useNow } from './useNow';

interface ConnectCardProps {
  connect: ConnectInfo;
  server: ServerInfo;
  onToast(kind: 'info' | 'success' | 'warn' | 'error', title: string, message?: string): void;
}

export function ConnectCard({ connect, server, onToast }: ConnectCardProps) {
  const [secure, setSecure] = useState(false);
  const [busy, setBusy] = useState(false);
  const now = useNow(1000);
  const httpsAvailable = Boolean(connect.httpsUrl);
  const mode = secure && httpsAvailable ? 'secure' : 'plain';
  const url = mode === 'secure' ? connect.httpsUrl : connect.httpUrl;
  const qr = mode === 'secure' ? connect.qrSecureDataUrl : connect.qrDataUrl;
  const ticketLeft = secondsLeft(connect.ticketExpiresAt, now);
  const codeLeft = secondsLeft(connect.codeExpiresAt, now);

  const copy = async (value: string | null, label: string) => {
    if (!value) return;
    const ok = await copyText(value);
    onToast(ok ? 'success' : 'error', ok ? `${label}已复制` : '复制失败', ok ? value : undefined);
  };

  const refresh = async () => {
    setBusy(true);
    try {
      await api.refreshConnect();
      onToast('info', '连接信息已刷新');
    } catch (error) {
      onToast('error', '刷新失败', error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card connect-card">
      <div className="card-head">
        <div>
          <p className="eyebrow">Connect</p>
          <h2>让手机连上来</h2>
        </div>
        <button type="button" className="icon-btn subtle" onClick={() => void refresh()} title="刷新二维码" aria-label="刷新二维码">
          {busy ? <Spinner size={16} /> : <Icon name="refresh" size={16} />}
        </button>
      </div>

      <div className="segmented" role="tablist" aria-label="连接方式">
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'plain'}
          className={mode === 'plain' ? 'active' : ''}
          onClick={() => setSecure(false)}
        >
          普通连接
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'secure'}
          className={mode === 'secure' ? 'active' : ''}
          onClick={() => setSecure(true)}
          disabled={!httpsAvailable}
          title={httpsAvailable ? undefined : 'HTTPS 服务尚未就绪'}
        >
          安全连接
        </button>
      </div>

      <div className="qr-shell">
        {qr ? (
          <img className="qr-image" src={qr} alt="手机配对二维码" draggable={false} />
        ) : (
          <div className="qr-empty">
            <Icon name="wifi" size={26} />
            <span>未检测到可用的局域网地址</span>
          </div>
        )}
        <span className="qr-corner tl" />
        <span className="qr-corner tr" />
        <span className="qr-corner bl" />
        <span className="qr-corner br" />
      </div>

      <p className="qr-caption">
        {mode === 'secure' ? '扫码后按提示安装本地证书，可启用摄像头与屏幕共享。' : '扫码打开手机页面即可上传照片、视频，无需安装应用。'}
      </p>

      <div className="connect-address">
        <div className="connect-address-main">
          <span className="address-label">{mode === 'secure' ? 'HTTPS 地址' : '局域网地址'}</span>
          <code>{url?.replace(/^https?:\/\//, '') ?? '等待网络'}</code>
        </div>
        <button type="button" className="icon-btn small" onClick={() => void copy(url, '地址')} disabled={!url} aria-label="复制地址">
          <Icon name="copy" size={14} />
        </button>
      </div>

      <div className="code-row">
        <div>
          <span className="address-label">配对码</span>
          <div className="pair-code" aria-label={`配对码 ${connect.code}`}>
            <span>{connect.code.slice(0, 3)}</span>
            <span className="pair-code-gap">{connect.code.slice(3)}</span>
          </div>
        </div>
        <div className="expiry">
          <span className={codeLeft < 30 ? 'is-expiring' : ''}>{clockLeft(codeLeft)}</span>
          <small>后失效</small>
        </div>
      </div>

      <div className="connect-foot">
        <span className={`ticket-timer ${ticketLeft < 20 ? 'is-expiring' : ''}`}>
          <Icon name="clock" size={12} /> 二维码 {clockLeft(ticketLeft)}
        </span>
        {connect.autoApprove ? <span className="auto-badge">免确认已开启</span> : null}
      </div>

      {mode === 'secure' ? (
        <div className="secure-note">
          <div className="secure-note-head">
            <Icon name="shield" size={15} />
            <span>启用摄像头、屏幕共享需要 HTTPS</span>
          </div>
          <p>首次使用请先在手机浏览器中安装并信任 EasyPush 本地证书。证书仅对当前局域网生效。</p>
          <div className="secure-actions">
            <a className="btn btn-ghost btn-sm" href={connect.caUrl ?? '#'} download="EasyPush-CA.crt">
              <Icon name="folder" size={14} /> 下载 CA 证书
            </a>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={!connect.httpsUrl}
              onClick={() => void copy(connect.httpsUrl, 'HTTPS 地址')}
            >
              <Icon name="link" size={14} /> 复制安全地址
            </button>
          </div>
          <details className="setup-steps">
            <summary>查看安装步骤</summary>
            <ol>
              <li>保持手机与本机在同一 Wi-Fi，使用上面的二维码或地址打开页面。</li>
              <li>下载 CA 证书后，在系统设置中安装为「受信任的根证书」（iOS：设置 → 通用 → VPN 与设备管理；Android：安全 → 加密与凭据）。</li>
              <li>回到浏览器，改用 https 地址打开页面，即可使用手机摄像头与电脑屏幕共享。</li>
            </ol>
          </details>
        </div>
      ) : null}

      {!server.addresses.length ? (
        <div className="inline-warning">
          <Icon name="warning" size={15} /> 未发现局域网网卡，请检查网络连接。
        </div>
      ) : null}

      {server.firewall.warning ? (
        <div className="inline-warning">
          <Icon name="warning" size={15} />
          <span>{server.firewall.warning}</span>
        </div>
      ) : null}
    </section>
  );
}

import { useEffect, useMemo, useState } from 'react';
import type { AppSnapshot, LogLevel, Settings } from '../shared/types';
import { api, errorText } from './api';
import { Icon } from './Icons';
import { Spinner } from './Icons';

interface SettingsModalProps {
  open: boolean;
  snapshot: AppSnapshot;
  onClose(): void;
  onToast(kind: 'info' | 'success' | 'warn' | 'error', title: string, message?: string): void;
}

const LOG_LEVELS: Array<{ value: LogLevel; label: string }> = [
  { value: 'debug', label: '调试（详细）' },
  { value: 'info', label: '常规' },
  { value: 'warn', label: '仅警告' },
  { value: 'error', label: '仅错误' },
];

const SLIDE_OPTIONS = [3000, 5000, 8000, 12000];

export function SettingsModal({ open, snapshot, onClose, onToast }: SettingsModalProps) {
  const [draft, setDraft] = useState<Settings>(snapshot.settings);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [firewallBusy, setFirewallBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setDraft(snapshot.settings);
    setError(null);
    setConfirmClear(false);
  }, [open, snapshot.settings]);

  const patch = useMemo(() => {
    const entries = Object.entries(draft) as Array<[keyof Settings, Settings[keyof Settings]]>;
    const changed: Partial<Settings> = {};
    for (const [key, value] of entries) {
      if (key === 'schema') continue;
      if (snapshot.settings[key] !== value) (changed as Record<string, unknown>)[key] = value;
    }
    return changed;
  }, [draft, snapshot.settings]);

  const dirty = Object.keys(patch).length > 0;
  const busyStage = snapshot.live !== null || snapshot.livePending !== null || snapshot.media !== null;
  const portsChanged = patch.httpPort !== undefined || patch.httpsPort !== undefined;

  if (!open) return null;

  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => setDraft((prev) => ({ ...prev, [key]: value }));

  const save = async () => {
    if (!dirty) {
      onClose();
      return;
    }
    if (portsChanged && busyStage) {
      setError('请先结束当前投屏与媒体播放，再修改端口。');
      return;
    }
    if (!draft.deviceName.trim()) {
      setError('设备名称不能为空。');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api.updateSettings(patch);
      onToast('success', '设置已保存', portsChanged ? '本地服务正在按新端口重启' : undefined);
      onClose();
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setSaving(false);
    }
  };

  const clearUploads = async () => {
    if (!confirmClear) {
      setConfirmClear(true);
      return;
    }
    try {
      await api.clearUploads();
      onToast('success', '上传缓存已清空');
      setConfirmClear(false);
    } catch (caught) {
      onToast('error', '清空失败', errorText(caught));
    }
  };

  const installFirewall = async () => {
    setFirewallBusy(true);
    try {
      const result = await api.installFirewallRule();
      if (result.ok) onToast('success', '防火墙规则已安装', '已放行 EasyPush 的 TCP 端口与 DLNA 发现端口');
      else onToast('error', '安装失败', result.error ?? '可能取消了管理员授权');
    } catch (caught) {
      onToast('error', '安装失败', errorText(caught));
    } finally {
      setFirewallBusy(false);
    }
  };

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-labelledby="settings-title">
      <div className="modal settings-modal">
        <header className="modal-head">
          <div>
            <p className="eyebrow">Preferences</p>
            <h2 id="settings-title">设置</h2>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭设置">
            <Icon name="close" size={16} />
          </button>
        </header>

        <div className="settings-body">
          <section className="settings-section">
            <h3>接收端</h3>
            <label className="field">
              <span>设备名称</span>
              <input
                value={draft.deviceName}
                maxLength={40}
                onChange={(event) => set('deviceName', event.target.value)}
                placeholder="例如：客厅大屏"
              />
            </label>
            <div className="field-row">
              <label className="field">
                <span>HTTP 端口</span>
                <input
                  type="number"
                  min={1024}
                  max={65535}
                  value={draft.httpPort}
                  onChange={(event) => set('httpPort', Number(event.target.value))}
                />
              </label>
              <label className="field">
                <span>HTTPS 端口</span>
                <input
                  type="number"
                  min={1024}
                  max={65535}
                  value={draft.httpsPort}
                  onChange={(event) => set('httpsPort', Number(event.target.value))}
                />
              </label>
            </div>
            <label className="field">
              <span>优先局域网地址</span>
              <select
                value={draft.primaryAddress ?? ''}
                onChange={(event) => set('primaryAddress', event.target.value || null)}
              >
                <option value="">自动选择（推荐）</option>
                {snapshot.server.addresses.map((address) => (
                  <option key={address.address} value={address.address}>
                    {address.address} · {address.iface}{address.virtual ? '（虚拟网卡）' : ''}
                  </option>
                ))}
              </select>
            </label>
            {portsChanged ? <p className="field-note">修改端口会重启本地服务并刷新二维码；端口被占用时会自动尝试后续 9 个端口。</p> : null}
          </section>

          <section className="settings-section">
            <h3>连接与权限</h3>
            <ToggleRow
              title="自动批准配对"
              description="开启后同一局域网设备扫描二维码即可直接连接，不再弹窗确认。"
              checked={draft.autoApprove}
              onChange={(value) => set('autoApprove', value)}
            />
            <ToggleRow
              title="允许实时投屏"
              description="允许手机摄像头或电脑浏览器共享屏幕；每次连接仍需确认（接管时也需确认）。"
              checked={draft.allowLive}
              onChange={(value) => set('allowLive', value)}
            />
            <ToggleRow
              title="启用 DLNA 接收"
              description="让支持 DLNA 的视频 App 将内容推送到本机。与实时投屏互斥。"
              checked={draft.allowDlna}
              onChange={(value) => set('allowDlna', value)}
            />
          </section>

          <section className="settings-section">
            <h3>播放</h3>
            <label className="field">
              <span>图片自动轮播间隔</span>
              <select value={draft.imageSlideMs} onChange={(event) => set('imageSlideMs', Number(event.target.value))}>
                {SLIDE_OPTIONS.map((value) => (
                  <option key={value} value={value}>{value / 1000} 秒</option>
                ))}
              </select>
            </label>
            <div className="field-row">
              <ToggleRow
                title="关闭时最小化到托盘"
                description="点击窗口关闭按钮时继续在后台提供服务。"
                checked={draft.closeToTray}
                onChange={(value) => set('closeToTray', value)}
              />
              <ToggleRow
                title="开机自动启动"
                description="仅安装版可用，启动后静默驻留托盘。"
                checked={draft.launchAtLogin}
                onChange={(value) => set('launchAtLogin', value)}
              />
            </div>
            <label className="field">
              <span>日志级别</span>
              <select value={draft.logLevel} onChange={(event) => set('logLevel', event.target.value as LogLevel)}>
                {LOG_LEVELS.map((level) => (
                  <option key={level.value} value={level.value}>{level.label}</option>
                ))}
              </select>
            </label>
          </section>

          <section className="settings-section">
            <h3>网络与安全</h3>
            <div className="setting-card">
              <div className="setting-card-head">
                <span className="setting-ic"><Icon name="shield" size={16} /></span>
                <div>
                  <strong>本地 CA 证书</strong>
                  <span>{snapshot.server.caFingerprint ?? '尚未生成'}</span>
                </div>
              </div>
              <p>证书仅用于当前局域网的 HTTPS 连接。指纹可用于核对手机上下载的证书是否一致。</p>
              <div className="setting-card-actions">
                {snapshot.server.caUrl ? (
                  <a className="btn btn-ghost btn-sm" href={snapshot.server.caUrl} download="EasyPush-CA.crt">
                    下载 CA
                  </a>
                ) : null}
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => void api.copyDiagnostics().then(() => onToast('success', '诊断信息已复制'))}>
                  复制诊断信息
                </button>
              </div>
            </div>
            <div className="setting-card">
              <div className="setting-card-head">
                <span className="setting-ic"><Icon name="wifi" size={16} /></span>
                <div>
                  <strong>Windows 防火墙</strong>
                  <span>当前网络：{profileLabel(snapshot.server.firewall.networkProfile)}</span>
                </div>
              </div>
              {snapshot.server.firewall.warning ? <p className="warn-text">{snapshot.server.firewall.warning}</p> : <p>若手机无法打开页面，可为 EasyPush 添加入站放行规则。</p>}
              <div className="setting-card-actions">
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => void installFirewall()} disabled={firewallBusy}>
                  {firewallBusy ? <Spinner size={14} /> : null} 安装防火墙规则
                </button>
              </div>
            </div>
          </section>

          <section className="settings-section">
            <h3>存储与运行</h3>
            <div className="setting-card">
              <div className="setting-card-head">
                <span className="setting-ic"><Icon name="folder" size={16} /></span>
                <div>
                  <strong>数据目录</strong>
                  <span className="mono small">{snapshot.server.dataDir}</span>
                </div>
              </div>
              <div className="setting-card-actions">
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => api.openDataDir()}>
                  打开数据目录
                </button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => api.openLogs()}>
                  打开日志目录
                </button>
                <button type="button" className={`btn btn-sm ${confirmClear ? 'btn-danger' : 'btn-ghost'}`} onClick={() => void clearUploads()}>
                  {confirmClear ? '确认清空上传缓存' : '清空上传缓存'}
                </button>
              </div>
            </div>
            <p className="field-note">
              EasyPush {snapshot.server.version} · Electron {snapshot.server.electron} · Chrome {snapshot.server.chrome}
            </p>
          </section>
        </div>

        {error ? (
          <div className="modal-error">
            <Icon name="warning" size={15} /> {error}
          </div>
        ) : null}

        <footer className="modal-foot">
          <span className="modal-foot-hint">{dirty ? '有尚未保存的修改' : '所有修改已保存'}</span>
          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" onClick={onClose}>
              取消
            </button>
            <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={saving || !dirty}>
              {saving ? <Spinner size={15} /> : null} 保存设置
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

function ToggleRow({
  title,
  description,
  checked,
  onChange,
}: {
  title: string;
  description: string;
  checked: boolean;
  onChange(value: boolean): void;
}) {
  return (
    <div className="toggle-row">
      <div>
        <strong>{title}</strong>
        <p>{description}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        className={`switch ${checked ? 'on' : ''}`}
        onClick={() => onChange(!checked)}
      >
        <span />
      </button>
    </div>
  );
}

function profileLabel(profile: string): string {
  switch (profile) {
    case 'private':
      return '专用网络';
    case 'public':
      return '公用网络';
    case 'domain':
      return '域网络';
    default:
      return '未知';
  }
}

import { useRef, useState } from 'react';
import type { DeviceInfo, HistoryEntry, LiveSession, LiveStats, ServerInfo } from '../shared/types';
import { formatBitrate, formatClock, formatDuration, formatResolution, relativeTime } from '../shared/format';
import { platformLabel, sourceLabel } from './api';
import { Icon } from './Icons';

export function InsertCard({
  onFiles,
  onUrl,
  busy,
}: {
  onFiles(paths: string[]): Promise<void>;
  onUrl(url: string): Promise<void>;
  busy: boolean;
}) {
  const input = useRef<HTMLInputElement | null>(null);
  const [url, setUrl] = useState('');
  const [sending, setSending] = useState(false);

  const pick = () => input.current?.click();

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const paths: string[] = [];
    for (const file of Array.from(files)) {
      const path = window.easypush.pathForFile(file);
      if (path) paths.push(path);
    }
    if (paths.length > 0) await onFiles(paths);
    if (input.current) input.current.value = '';
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const value = url.trim();
    if (!value) return;
    setSending(true);
    try {
      await onUrl(value);
      setUrl('');
    } finally {
      setSending(false);
    }
  };

  return (
    <section className="card">
      <div className="card-head compact">
        <div>
          <p className="eyebrow">Local input</p>
          <h2>直接在本机投放</h2>
        </div>
      </div>
      <input
        ref={input}
        type="file"
        multiple
        accept="image/*,video/*,audio/*,.mkv,.m3u8"
        className="visually-hidden"
        onChange={(event) => void handleFiles(event.target.files)}
      />
      <div className="insert-actions">
        <button type="button" className="btn btn-soft" onClick={pick} disabled={busy}>
          <Icon name="upload" size={16} /> 选择文件
        </button>
        <span className="insert-hint">图片 / 视频 / 音频</span>
      </div>
      <form className="url-form" onSubmit={(event) => void submit(event)}>
        <span className="input-icon">
          <Icon name="link" size={14} />
        </span>
        <input
          type="url"
          inputMode="url"
          placeholder="粘贴 HLS / 视频 / 音频地址"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          spellCheck={false}
        />
        <button type="submit" className="btn btn-ghost btn-sm" disabled={!url.trim() || sending}>
          播放
        </button>
      </form>
      <p className="card-note">本机文件不会复制到上传目录；远程地址需可被本机直接访问。</p>
    </section>
  );
}

export function DevicesCard({
  devices,
  onRevoke,
}: {
  devices: DeviceInfo[];
  onRevoke(device: DeviceInfo): void;
}) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? devices : devices.slice(0, 4);
  return (
    <section className="card">
      <div className="card-head compact">
        <div>
          <p className="eyebrow">Devices</p>
          <h2>已配对设备 <span className="count">{devices.length}</span></h2>
        </div>
      </div>
      {devices.length === 0 ? (
        <div className="empty-row">
          <Icon name="phone" size={18} />
          <span>还没有设备配对，扫描上方二维码开始。</span>
        </div>
      ) : (
        <ul className="device-list">
          {visible.map((device) => (
            <li key={device.id}>
              <span className="device-icon">
                <Icon name={device.platform === 'ios' || device.platform === 'android' ? 'phone' : 'laptop'} size={16} />
              </span>
              <span className="device-copy">
                <strong>{device.name}</strong>
                <span>
                  {platformLabel(device.platform)} · {device.ip} · {relativeTime(device.lastSeenAt)}
                </span>
              </span>
              {device.remembered ? <span className="mini-badge">已记住</span> : null}
              <button
                type="button"
                className="icon-btn small danger-hover"
                title="移除设备"
                aria-label={`移除 ${device.name}`}
                onClick={() => onRevoke(device)}
              >
                <Icon name="trash" size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {devices.length > 4 ? (
        <button type="button" className="text-btn" onClick={() => setExpanded((value) => !value)}>
          {expanded ? '收起' : `查看全部 ${devices.length} 台`}
          <Icon name="chevron" size={13} className={expanded ? 'flip' : ''} />
        </button>
      ) : null}
    </section>
  );
}

export function ActivityCard({ history }: { history: HistoryEntry[] }) {
  const items = history.slice(0, 7);
  return (
    <section className="card">
      <div className="card-head compact">
        <div>
          <p className="eyebrow">Activity</p>
          <h2>最近活动</h2>
        </div>
      </div>
      {items.length === 0 ? (
        <div className="empty-row">
          <Icon name="clock" size={18} />
          <span>投屏和播放记录会显示在这里。</span>
        </div>
      ) : (
        <ul className="activity-list">
          {items.map((entry) => (
            <li key={`${entry.id}-${entry.endedAt}`}>
              <span className={`activity-icon ${entry.kind}`}>
                <Icon name={entry.kind === 'live' ? 'cast' : 'play'} size={13} />
              </span>
              <span className="activity-copy">
                <strong>{entry.title}</strong>
                <span>
                  {entry.deviceName ? `${entry.deviceName} · ` : ''}
                  {entry.kind === 'live' ? '实时投屏' : sourceLabel(entry.protocol)} · {formatClock(entry.endedAt)}
                </span>
              </span>
              <span className="activity-duration">{formatDuration(entry.durationSec)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function LiveSignalCard({ session, stats, phase }: { session: LiveSession; stats: LiveStats | null; phase: string }) {
  return (
    <section className="card signal-card">
      <div className="card-head compact">
        <div>
          <p className="eyebrow">Live signal</p>
          <h2>{session.deviceName}</h2>
        </div>
        <span className="live-chip">
          <span className="status-dot is-live" /> {phase === 'live' ? '直播中' : phase === 'disconnected' ? '重连中' : '连接中'}
        </span>
      </div>
      <div className="signal-meta">
        {session.media === 'screen' ? '电脑屏幕' : '手机摄像头'} · {session.ip} · {session.audio ? '含音频' : '无音频'}
      </div>
      <div className="stat-grid">
        <Stat label="分辨率" value={stats ? formatResolution(stats.width, stats.height) : '—'} />
        <Stat label="帧率" value={stats ? `${stats.fps} fps` : '—'} />
        <Stat label="码率" value={stats ? formatBitrate(stats.bitrateKbps) : '—'} />
        <Stat label="延迟 RTT" value={stats?.rttMs != null ? `${stats.rttMs} ms` : '—'} />
        <Stat label="视频编码" value={stats?.codec ?? '—'} />
        <Stat label="丢包" value={stats ? String(stats.packetsLost) : '—'} />
      </div>
      {stats?.jitterBufferMs != null ? <p className="card-note">抖动缓冲 {stats.jitterBufferMs} ms · 首帧 {session.firstFrameMs != null ? `${session.firstFrameMs} ms` : '测量中'}</p> : null}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

export function RailFoot({ server, onOpenLogs, onOpenData }: { server: ServerInfo; onOpenLogs(): void; onOpenData(): void }) {
  return (
    <footer className="rail-foot">
      <div>
        <span>EasyPush {server.version}</span>
        <span>·</span>
        <span>协议 v{server.protocolVersion}</span>
      </div>
      <div className="rail-foot-actions">
        <button type="button" className="text-btn" onClick={onOpenLogs}>
          日志
        </button>
        <button type="button" className="text-btn" onClick={onOpenData}>
          数据目录
        </button>
      </div>
    </footer>
  );
}

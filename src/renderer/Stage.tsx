import { useState } from 'react';
import type { AppSnapshot, LiveSession, MediaItem, MediaSession, Presentation, Settings } from '../shared/types';
import { formatBitrate, formatDuration, formatResolution } from '../shared/format';
import { sourceLabel } from './api';
import { Icon, Spinner } from './Icons';
import type { MediaPlayback } from './useMediaPlayback';
import type { LiveReceiver } from './useLiveReceiver';
import { copyText } from './api';

export function Stage({
  snapshot,
  media,
  live,
  dragActive,
  onToast,
}: {
  snapshot: AppSnapshot;
  media: MediaPlayback;
  live: LiveReceiver;
  dragActive: boolean;
  onToast(kind: 'info' | 'success' | 'warn' | 'error', title: string, message?: string): void;
}) {
  const mode = snapshot.presentation.mode;
  const liveSession = snapshot.live ?? live.session;
  return (
    <div className="stage-wrap">
      <div className={`stage-layer media-layer ${mode === 'media' ? 'is-visible' : ''}`}>
        <MediaView media={media} />
      </div>
      <div className={`stage-layer live-layer ${mode === 'live' ? 'is-visible' : ''}`}>
        <LiveView live={live} session={liveSession} />
      </div>
      <div className={`stage-layer idle-layer ${mode === 'idle' ? 'is-visible' : ''}`}>
        <IdleHero snapshot={snapshot} onToast={onToast} />
      </div>
      {dragActive ? (
        <div className="drop-overlay">
          <div className="drop-card">
            <Icon name="upload" size={28} />
            <strong>松手即可投放</strong>
            <span>支持图片、视频和音频文件</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function IdleHero({
  snapshot,
  onToast,
}: {
  snapshot: AppSnapshot;
  onToast(kind: 'info' | 'success' | 'warn' | 'error', title: string, message?: string): void;
}) {
  const { connect, server } = snapshot;
  const copy = async () => {
    if (!connect.httpUrl) return;
    const ok = await copyText(connect.httpUrl);
    onToast(ok ? 'success' : 'error', ok ? '地址已复制' : '复制失败', ok ? connect.httpUrl : undefined);
  };
  return (
    <div className="idle">
      <div className="idle-aura" aria-hidden="true" />
      <div className="idle-grid" aria-hidden="true" />
      <div className="idle-content">
        <div className="idle-emblem">
          <span className="pulse-ring r1" />
          <span className="pulse-ring r2" />
          <Icon name="cast" size={34} />
        </div>
        <p className="eyebrow">Local casting hub</p>
        <h1>
          把手机里的画面
          <br />
          <span>投到这块屏幕上</span>
        </h1>
        <p className="idle-sub">照片、视频、摄像头、电脑屏幕，或者通过 DLNA 推送。数据只在局域网内直连，不经过任何云端。</p>
        <div className="idle-steps">
          <Step icon="qr" index="01" title="扫码连接" text="手机与电脑连接同一 Wi-Fi" />
          <Step icon="upload" index="02" title="选择内容" text="上传文件、开摄像头或共享屏幕" />
          <Step icon="cast" index="03" title="本机确认" text="允许后立即出现在屏幕上" />
        </div>
        <button type="button" className="idle-address" onClick={() => void copy()} disabled={!connect.httpUrl}>
          <span className="idle-code-label">配对码</span>
          <strong>{connect.code}</strong>
          <span className="idle-code-divider" />
          <span className="idle-url">{connect.httpUrl?.replace(/^https?:\/\//, '') ?? '等待局域网连接'}</span>
          <Icon name="copy" size={13} />
        </button>
      </div>
      <div className="idle-foot">
        <span>屏幕共享请使用电脑浏览器访问上方地址</span>
        <span className="dot-sep">·</span>
        <span>手机系统镜像请使用手机自带投屏</span>
        {server.firewall.warning ? (
          <>
            <span className="dot-sep">·</span>
            <span className="idle-warn"><Icon name="warning" size={12} /> 防火墙可能阻止访问</span>
          </>
        ) : null}
      </div>
    </div>
  );
}

function Step({ icon, index, title, text }: { icon: string; index: string; title: string; text: string }) {
  return (
    <div className="idle-step">
      <span className="step-icon"><Icon name={icon} size={17} /></span>
      <div>
        <span className="step-index">{index}</span>
        <strong>{title}</strong>
        <p>{text}</p>
      </div>
    </div>
  );
}

function LiveView({ live, session }: { live: LiveReceiver; session: LiveSession | null }) {
  const phase = live.phase;
  const stats = live.stats;
  // A single persistent <video>: swapping the element on mode changes aborts an
  // in-flight play() promise and orphans the MediaStream attached by ontrack.
  const connecting = phase === 'preparing' || phase === 'connecting';
  return (
    <div className="live-stage">
      <video
        ref={live.videoRef}
        className={`live-video ${phase === 'live' ? 'is-playing' : ''}`}
        autoPlay
        playsInline
        muted={live.muted}
        onClick={() => live.resumePlayback()}
      />
      {phase === 'live' ? <div className="live-vignette" aria-hidden="true" /> : null}

      <div className="live-top">
        <div className="live-badge">
          <span className="live-dot" />
          <span>实时投屏</span>
          {session ? (
            <>
              <span className="live-badge-divider" />
              <span className="live-device">{session.deviceName}</span>
              <span className="live-kind">{session.media === 'screen' ? '屏幕' : '摄像头'}</span>
            </>
          ) : null}
        </div>
        <div className="live-metrics">
          {stats ? (
            <>
              <span>{formatResolution(stats.width, stats.height)}</span>
              <span>{stats.fps} fps</span>
              <span>{formatBitrate(stats.bitrateKbps)}</span>
              <span>{stats.rttMs != null ? `${stats.rttMs} ms` : '局域网'}</span>
            </>
          ) : (
            <span>建立点对点通道…</span>
          )}
        </div>
      </div>

      {live.playbackIssue === 'audio' ? (
        <button type="button" className="live-gesture" onClick={() => live.resumePlayback()}>
          <Icon name="volume" size={14} /> 静音播放中 · 点击画面恢复声音
        </button>
      ) : null}

      {live.playbackIssue === 'video' ? (
        <div className="live-center">
          <button type="button" className="live-connecting gesture" onClick={() => live.resumePlayback()}>
            <Icon name="play" size={22} />
            <strong>点击开始播放</strong>
            <span>系统未允许自动播放，点一下即可开始</span>
          </button>
        </div>
      ) : null}

      {connecting && live.playbackIssue !== 'video' ? (
        <div className="live-center">
          <div className="live-connecting">
            <Spinner size={26} />
            <strong>{phase === 'preparing' ? '正在准备接收画面' : '正在建立点对点连接'}</strong>
            <span>{session ? `${session.deviceName} · 通常只需数秒` : '等待发送端开始传输'}</span>
          </div>
        </div>
      ) : null}

      {phase === 'disconnected' ? (
        <div className="live-center">
          <div className="live-connecting warn">
            <Spinner size={24} />
            <strong>连接暂时中断</strong>
            <span>正在等待发送端恢复，最多 8 秒</span>
          </div>
        </div>
      ) : null}

      {phase === 'failed' ? (
        <div className="live-center">
          <div className="live-connecting error">
            <Icon name="warning" size={24} />
            <strong>投屏连接失败</strong>
            <span>{live.error ?? '请检查两台设备是否在同一局域网'}</span>
          </div>
        </div>
      ) : null}

      {session?.state === 'disconnected' && phase === 'live' ? (
        <div className="live-banner">
          <Icon name="warning" size={14} /> 控制连接中断，画面可能随时停止
        </div>
      ) : null}

      {phase === 'live' || phase === 'disconnected' ? (
        <div className="live-controls">
          <div className="live-controls-left">
            <button
              type="button"
              className="round-btn"
              onClick={() => live.requestMute(!live.muted)}
              title={live.muted ? '取消静音' : '静音'}
              aria-label={live.muted ? '取消静音' : '静音'}
            >
              <Icon name={live.muted ? 'mute' : 'volume'} size={18} />
            </button>
            <input
              type="range"
              className="volume-range slim"
              min={0}
              max={1}
              step={0.01}
              value={live.volume}
              aria-label="投屏音量"
              onChange={(event) => live.requestVolume(Number(event.target.value))}
            />
          </div>
          <div className="live-controls-mid">
            <span className="live-codec">{stats?.codec ? `视频 ${stats.codec}${stats.audioCodec ? ` · 音频 ${stats.audioCodec}` : ''}` : 'WebRTC 点对点'}</span>
          </div>
          <button type="button" className="btn btn-danger-soft" onClick={() => live.stop()}>
            <Icon name="stop" size={14} /> 结束投屏
          </button>
        </div>
      ) : (
        <div className="live-controls">
          <span className="live-codec">{session ? `${session.deviceName} · ${session.ip}` : '等待投屏请求'}</span>
          {session ? (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => live.stop()}>
              取消
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}

function MediaView({ media }: { media: MediaPlayback }) {
  const item = media.current;
  const isImage = item?.kind === 'image';
  const isVideo = item?.kind === 'video';
  const isAudio = item?.kind === 'audio';
  return (
    <div className={`media-stage ${isImage ? 'is-image' : ''}`}>
      <video ref={media.videoRef} className={`media-video ${isVideo ? 'is-visible' : ''}`} playsInline />
      <audio ref={media.audioRef} />
      {isImage && item ? (
        <img
          key={item.id}
          className="media-image"
          src={item.url}
          alt={item.name}
          draggable={false}
          onLoad={(event) => media.imageLoaded(event.currentTarget.naturalWidth, event.currentTarget.naturalHeight)}
          onError={() => media.imageFailed()}
        />
      ) : null}
      {isAudio ? (
        <div className="audio-scene">
          <div className={`audio-art ${media.phase === 'playing' ? 'is-playing' : ''}`}>
            <span />
            <span />
            <span />
            <span />
            <span />
            <Icon name="audio" size={28} />
          </div>
          <p className="eyebrow">Now playing</p>
          <h2>{item?.name}</h2>
          <p>{sourceLabel(media.session?.source ?? '')}</p>
        </div>
      ) : null}

      {item ? (
        <div className="media-info">
          <span className="media-kind">
            <Icon name={isImage ? 'image' : isVideo ? 'video' : 'audio'} size={13} />
            {isImage ? '图片' : isVideo ? '视频' : '音频'}
          </span>
          <span className="media-name">{item.name}</span>
          {media.session && media.session.items.length > 1 ? (
            <span className="media-index">{media.session.index + 1} / {media.session.items.length}</span>
          ) : null}
        </div>
      ) : null}

      {media.phase === 'loading' ? (
        <div className="media-center soft">
          <Spinner size={24} />
          <span>正在载入媒体…</span>
        </div>
      ) : null}

      {media.phase === 'error' ? (
        <div className="media-center">
          <div className="media-error">
            <Icon name="warning" size={22} />
            <strong>无法播放</strong>
            <span>{media.error ?? '文件格式不受支持'}</span>
          </div>
        </div>
      ) : null}

      {media.phase === 'ended' && isVideo ? (
        <button type="button" className="media-replay" onClick={() => window.easypush.mediaCommand('play')}>
          <Icon name="refresh" size={16} /> 重新播放
        </button>
      ) : null}
    </div>
  );
}

export function Transport({
  media,
  settings,
  queueOpen,
  onToggleQueue,
  onToast,
}: {
  media: MediaPlayback;
  settings: Settings;
  queueOpen: boolean;
  onToggleQueue(): void;
  onToast(kind: 'info' | 'success' | 'warn' | 'error', title: string, message?: string): void;
}) {
  const session = media.session;
  const item = media.current;
  if (!session || !item) return null;
  const image = item.kind === 'image';
  const multi = session.items.length > 1;
  const playing = media.phase === 'playing' || media.phase === 'loading';

  const stop = () => {
    window.easypush.mediaCommand('stop');
  };

  return (
    <div className="transport">
      <div className="transport-meta">
        <span className={`transport-icon ${item.kind}`}>
          <Icon name={item.kind === 'image' ? 'image' : item.kind === 'video' ? 'video' : 'audio'} size={16} />
        </span>
        <div className="transport-copy">
          <strong title={item.name}>{item.name}</strong>
          <span>{sourceLabel(session.source)} · {session.items.length} 项</span>
        </div>
        <button type="button" className={`queue-toggle ${queueOpen ? 'active' : ''}`} onClick={onToggleQueue}>
          <Icon name="logs" size={14} /> 队列
        </button>
      </div>

      <div className="transport-main">
        <div className="transport-buttons">
          <button type="button" className="icon-btn" disabled={!multi} onClick={() => window.easypush.mediaCommand('previous')} aria-label="上一个">
            <Icon name="previous" size={17} />
          </button>
          <button type="button" className="play-btn" onClick={() => media.toggle()} aria-label={playing ? '暂停' : '播放'}>
            <Icon name={playing ? 'pause' : 'play'} size={19} />
          </button>
          <button type="button" className="icon-btn" disabled={!multi} onClick={() => window.easypush.mediaCommand('next')} aria-label="下一个">
            <Icon name="next" size={17} />
          </button>
        </div>
        {image ? (
          <div className="transport-image">
            <span>{session.index + 1} / {session.items.length}</span>
            <label className="switch-line">
              <button
                type="button"
                className={`switch ${media.autoplayImages ? 'on' : ''}`}
                role="switch"
                aria-checked={media.autoplayImages}
                onClick={() => media.setAutoplayImages(!media.autoplayImages)}
              >
                <span />
              </button>
              自动轮播 {Math.round(settings.imageSlideMs / 1000)}s
            </label>
          </div>
        ) : (
          <div className="transport-timeline">
            <span className="time">{formatDuration(media.position)}</span>
            <SeekBar
              position={media.position}
              duration={media.duration}
              disabled={!media.session?.canSeek && item.kind !== 'video' && item.kind !== 'audio'}
              onSeek={(value) => media.seekTo(value)}
            />
            <span className="time">{formatDuration(media.duration)}</span>
          </div>
        )}
      </div>

      <div className="transport-volume">
        <button
          type="button"
          className="icon-btn small"
          onClick={() => media.setMuted(!media.muted)}
          aria-label={media.muted ? '取消静音' : '静音'}
          title={media.muted ? '取消静音' : '静音'}
        >
          <Icon name={media.muted || media.volume === 0 ? 'mute' : 'volume'} size={16} />
        </button>
        <input
          type="range"
          className="volume-range"
          min={0}
          max={1}
          step={0.01}
          value={media.muted ? 0 : media.volume}
          aria-label="音量"
          onChange={(event) => {
            const value = Number(event.target.value);
            if (value > 0 && media.muted) media.setMuted(false);
            media.setVolume(value);
          }}
        />
        <button
          type="button"
          className="icon-btn small"
          onClick={() => {
            stop();
            onToast('info', '已停止播放');
          }}
          aria-label="停止播放"
          title="停止播放"
        >
          <Icon name="stop" size={14} />
        </button>
      </div>
    </div>
  );
}

function SeekBar({
  position,
  duration,
  disabled,
  onSeek,
}: {
  position: number;
  duration: number;
  disabled: boolean;
  onSeek(value: number): void;
}) {
  const [drag, setDrag] = useState<number | null>(null);
  const max = Math.max(0.1, duration);
  const value = Math.min(max, Math.max(0, drag ?? position));
  const progress = Math.round((value / max) * 1000) / 10;
  return (
    <input
      type="range"
      className="seek-range"
      min={0}
      max={max}
      step={0.1}
      value={value}
      disabled={disabled}
      style={{ ['--progress' as string]: `${progress}%` }}
      onChange={(event) => setDrag(Number(event.target.value))}
      onPointerUp={() => {
        if (drag !== null) onSeek(drag);
        setDrag(null);
      }}
      onPointerCancel={() => setDrag(null)}
      onKeyUp={(event) => {
        if (drag !== null && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
          onSeek(drag);
          setDrag(null);
        }
      }}
      aria-label="播放进度"
    />
  );
}

export function QueuePanel({
  media,
  onClose,
}: {
  media: MediaPlayback;
  onClose(): void;
}) {
  const session = media.session;
  if (!session) return null;
  return (
    <div className="queue-panel">
      <div className="queue-head">
        <div>
          <p className="eyebrow">Up next</p>
          <h3>播放队列 <span className="count">{session.items.length}</span></h3>
        </div>
        <button type="button" className="icon-btn small" onClick={onClose} aria-label="关闭队列">
          <Icon name="close" size={14} />
        </button>
      </div>
      <ul className="queue-list">
        {session.items.map((item, index) => (
          <li key={item.id} className={index === session.index ? 'active' : ''}>
            <button type="button" className="queue-item" onClick={() => media.playIndex(item.id)}>
              <span className="queue-number">{index + 1}</span>
              <span className="queue-kind">
                <Icon name={item.kind === 'image' ? 'image' : item.kind === 'video' ? 'video' : 'audio'} size={14} />
              </span>
              <span className="queue-copy">
                <strong>{item.name}</strong>
                <span>{sourceLabel(item.source)}</span>
              </span>
              {index === session.index ? (
                <span className="now-indicator">
                  <span /><span /><span />
                </span>
              ) : null}
            </button>
          </li>
        ))}
      </ul>
      <div className="queue-foot">{sourceLabel(session.source)} · {session.items.length} 项 · 直播时上传的内容会自动排队</div>
    </div>
  );
}

export function presentationLabel(presentation: Presentation, live: LiveSession | null, media: MediaSession | null): string {
  if (presentation.mode === 'live') return live ? `${live.deviceName} 正在投屏` : '实时投屏';
  if (presentation.mode === 'media' && media) {
    const item = media.items[media.index];
    return item ? item.name : '媒体播放';
  }
  return '等待投屏';
}

export function kindLabel(item: MediaItem): string {
  return item.kind === 'image' ? '图片' : item.kind === 'video' ? '视频' : '音频';
}

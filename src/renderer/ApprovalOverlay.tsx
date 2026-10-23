import type { AppSnapshot } from '../shared/types';
import { platformLabel } from './api';
import { Icon } from './Icons';
import { clockLeft, secondsLeft, useNow } from './useNow';

interface ApprovalOverlayProps {
  snapshot: AppSnapshot;
  onApprovePair(remember: boolean): void;
  onDenyPair(): void;
  onApproveLive(): void;
  onDenyLive(): void;
}

const LIVE_TTL_MS = 60_000;

export function ApprovalOverlay({ snapshot, onApprovePair, onDenyPair, onApproveLive, onDenyLive }: ApprovalOverlayProps) {
  const now = useNow(1000);
  const live = snapshot.livePending;
  const pair = snapshot.pairing;

  if (live) {
    const takeover = live.state === 'awaiting-takeover' && snapshot.live;
    const left = Math.min(60, secondsLeft(live.createdAt + LIVE_TTL_MS, now));
    return (
      <div className="overlay" role="dialog" aria-modal="true" aria-labelledby="live-approval-title">
        <div className="modal approval-modal">
          <div className={`approval-signal ${takeover ? 'is-warning' : ''}`}>
            <Icon name={takeover ? 'warning' : live.media === 'screen' ? 'monitor' : 'camera'} size={26} />
          </div>
          <p className="eyebrow">{takeover ? '接管请求' : '投屏请求'}</p>
          <h2 id="live-approval-title">{takeover ? '是否允许切换投屏？' : '有设备想要投屏'}</h2>
          <div className="approval-device">
            <span className="approval-avatar">
              <Icon name={live.platform === 'ios' || live.platform === 'android' ? 'phone' : 'laptop'} size={18} />
            </span>
            <div>
              <strong>{live.deviceName}</strong>
              <span>
                {platformLabel(live.platform)} · {live.ip}
              </span>
            </div>
            <span className="approval-countdown">{clockLeft(left)}</span>
          </div>
          <div className="approval-facts">
            <span><Icon name={live.media === 'screen' ? 'monitor' : 'camera'} size={14} /> {live.media === 'screen' ? '共享屏幕' : '摄像头画面'}</span>
            <span><Icon name="speaker" size={14} /> {live.audio ? '包含音频' : '仅画面'}</span>
          </div>
          {takeover ? (
            <p className="approval-note warning">
              当前「{snapshot.live?.deviceName ?? '其他设备'}」正在投屏，允许后原投屏会立即结束。请确认对方是你认识的人。
            </p>
          ) : (
            <p className="approval-note">只接受你认识的设备。投屏过程中可随时在本机停止。</p>
          )}
          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" onClick={onDenyLive}>
              拒绝
            </button>
            <button type="button" className="btn btn-primary" onClick={onApproveLive} autoFocus>
              {takeover ? '结束原投屏并接管' : '允许投屏'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (pair) {
    const left = secondsLeft(pair.expiresAt, now);
    return (
      <div className="overlay" role="dialog" aria-modal="true" aria-labelledby="pair-approval-title">
        <div className="modal approval-modal">
          <div className="approval-signal">
            <Icon name="shield" size={26} />
          </div>
          <p className="eyebrow">配对请求</p>
          <h2 id="pair-approval-title">允许这台设备连接？</h2>
          <div className="approval-device">
            <span className="approval-avatar">
              <Icon name={pair.platform === 'ios' || pair.platform === 'android' ? 'phone' : 'laptop'} size={18} />
            </span>
            <div>
              <strong>{pair.deviceName}</strong>
              <span>
                {platformLabel(pair.platform)} · {pair.ip}
              </span>
            </div>
            <span className="approval-countdown">{clockLeft(left)}</span>
          </div>
          <p className="approval-note">
            配对后该设备可以上传照片和视频，并在你确认后发起投屏。如果开启「记住此设备」，下次打开页面无需再次确认。
          </p>
          <div className="modal-actions stack-mobile">
            <button type="button" className="btn btn-ghost" onClick={onDenyPair}>
              拒绝
            </button>
            <button type="button" className="btn btn-secondary" onClick={() => onApprovePair(false)}>
              仅本次允许
            </button>
            <button type="button" className="btn btn-primary" onClick={() => onApprovePair(true)} autoFocus>
              允许并记住
            </button>
          </div>
          <p className="approval-fineprint">仅在你本人操作手机时确认。配对请求来自局域网内同一 Wi-Fi。</p>
        </div>
      </div>
    );
  }

  return null;
}

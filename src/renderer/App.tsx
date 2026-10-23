import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppSnapshot, ToastMessage } from '../shared/types';
import { api, errorText } from './api';
import { ApprovalOverlay } from './ApprovalOverlay';
import { ConnectCard } from './ConnectCard';
import { Icon, Spinner } from './Icons';
import { LogsModal } from './LogsModal';
import { SettingsModal } from './SettingsModal';
import { ActivityCard, DevicesCard, InsertCard, LiveSignalCard, RailFoot } from './SideRail';
import { QueuePanel, Stage, Transport } from './Stage';
import { TitleBar } from './TitleBar';
import { Toasts } from './Toasts';
import { useLiveReceiver } from './useLiveReceiver';
import { useMediaPlayback } from './useMediaPlayback';

type ToastKind = 'info' | 'success' | 'warn' | 'error';

export function App() {
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [logsOpen, setLogsOpen] = useState(false);
  const [queueOpen, setQueueOpen] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [addBusy, setAddBusy] = useState(false);
  const readySent = useRef(false);

  const pushToast = useCallback((kind: ToastKind, title: string, message?: string) => {
    const id = `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    setToasts((prev) => [...prev.slice(-3), { id, kind, title, message }]);
    window.setTimeout(() => setToasts((prev) => prev.filter((toast) => toast.id !== id)), 4800);
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
  }, []);

  const acceptSnapshot = useCallback((next: AppSnapshot) => {
    setSnapshot((prev) => (prev && prev.revision > next.revision ? prev : next));
  }, []);

  useEffect(() => {
    const offSnapshot = api.onSnapshot(acceptSnapshot);
    const offToast = api.onToast((toast) => {
      setToasts((prev) => [...prev.slice(-3), toast]);
      window.setTimeout(() => setToasts((prev) => prev.filter((entry) => entry.id !== toast.id)), 5200);
    });
    void api
      .getSnapshot()
      .then(acceptSnapshot)
      .catch((error) => {
        setToasts((prev) => [
          ...prev,
          { id: 'boot-error', kind: 'error', title: '无法读取运行状态', message: errorText(error) },
        ]);
      });
    return () => {
      offSnapshot();
      offToast();
    };
  }, [acceptSnapshot]);

  const liveReceiver = useLiveReceiver({
    onNotice: (message) => pushToast('info', '投屏提示', message),
    onError: (message) => pushToast('error', '投屏异常', message),
  });
  const playback = useMediaPlayback(snapshot?.settings.imageSlideMs ?? 5000, snapshot !== null);

  useEffect(() => {
    if (!snapshot || readySent.current) return;
    readySent.current = true;
    api.reportReady();
  }, [snapshot]);

  useEffect(() => {
    if (queueOpen && !playback.session) setQueueOpen(false);
  }, [queueOpen, playback.session]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (settingsOpen) setSettingsOpen(false);
        else if (logsOpen) setLogsOpen(false);
        else if (queueOpen) setQueueOpen(false);
        return;
      }
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) return;
      if (event.code === 'Space' && snapshot?.presentation.mode === 'media' && !settingsOpen && !logsOpen) {
        event.preventDefault();
        playback.toggle();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [logsOpen, playback, queueOpen, settingsOpen, snapshot?.presentation.mode]);

  const addFiles = useCallback(
    async (paths: string[]) => {
      if (paths.length === 0) {
        pushToast('warn', '没有找到可读取的文件', '拖入的文件需要在磁盘上存在');
        return;
      }
      setAddBusy(true);
      try {
        const count = await api.addLocalFiles(paths);
        if (count > 0) pushToast('success', `已投放 ${count} 个文件`);
        else pushToast('warn', '没有可播放的文件', '支持图片、视频和音频常见格式');
      } catch (error) {
        pushToast('error', '投放失败', errorText(error));
      } finally {
        setAddBusy(false);
      }
    },
    [pushToast],
  );

  const addUrl = useCallback(
    async (url: string) => {
      try {
        await api.addUrl(url);
        pushToast('success', '已开始播放网络媒体');
      } catch (error) {
        pushToast('error', '网络媒体播放失败', errorText(error));
        throw error;
      }
    },
    [pushToast],
  );

  const handleDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      setDragActive(false);
      const paths: string[] = [];
      for (const file of Array.from(event.dataTransfer.files)) {
        const path = api.pathForFile(file);
        if (path) paths.push(path);
      }
      void addFiles(paths);
    },
    [addFiles],
  );

  const revoke = useCallback(
    (device: AppSnapshot['devices'][number]) => {
      const ok = window.confirm(`移除「${device.name}」？该设备需要重新扫码配对。`);
      if (!ok) return;
      void api
        .revokeDevice(device.id)
        .then(() => pushToast('info', '设备已移除', device.name))
        .catch((error) => pushToast('error', '移除失败', errorText(error)));
    },
    [pushToast],
  );

  if (!snapshot) {
    return (
      <div className="boot">
        <div className="boot-mark">
          <Icon name="cast" size={30} />
        </div>
        <Spinner size={22} />
        <p>正在连接本地服务…</p>
        <span>EasyPush</span>
      </div>
    );
  }

  const liveStats = liveReceiver.stats;
  const mode = snapshot.presentation.mode;

  return (
    <div className="app">
      <TitleBar
        server={snapshot.server}
        deviceName={snapshot.settings.deviceName}
        liveActive={mode === 'live'}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenLogs={() => setLogsOpen(true)}
        onCopyAddress={() => {
          const url = snapshot.server.primaryUrl;
          if (!url) {
            pushToast('warn', '还没有可用的局域网地址');
            return;
          }
          void navigator.clipboard.writeText(url).then(
            () => pushToast('success', '访问地址已复制', url),
            () => pushToast('error', '复制失败'),
          );
        }}
      />

      <div
        className="app-body"
        onDragOver={(event) => {
          event.preventDefault();
          if (event.dataTransfer.types.includes('Files')) setDragActive(true);
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragActive(false);
        }}
        onDrop={handleDrop}
      >
        <main className="main-col">
          <Stage snapshot={snapshot} media={playback} live={liveReceiver} dragActive={dragActive} onToast={pushToast} />
          {mode === 'media' && playback.session ? (
            <Transport
              media={playback}
              settings={snapshot.settings}
              queueOpen={queueOpen}
              onToggleQueue={() => setQueueOpen((value) => !value)}
              onToast={pushToast}
            />
          ) : null}
          {queueOpen && playback.session ? <QueuePanel media={playback} onClose={() => setQueueOpen(false)} /> : null}
        </main>

        <aside className="rail">
          <ConnectCard connect={snapshot.connect} server={snapshot.server} onToast={pushToast} />
          {snapshot.live ? <LiveSignalCard session={snapshot.live} stats={liveStats} phase={liveReceiver.phase} /> : null}
          <InsertCard onFiles={addFiles} onUrl={addUrl} busy={addBusy} />
          <DevicesCard devices={snapshot.devices} onRevoke={revoke} />
          <ActivityCard history={snapshot.history} />
          <RailFoot
            server={snapshot.server}
            onOpenLogs={() => setLogsOpen(true)}
            onOpenData={() => {
              try {
                api.openDataDir();
              } catch (error) {
                pushToast('error', '无法打开目录', errorText(error));
              }
            }}
          />
        </aside>
      </div>

      <ApprovalOverlay
        snapshot={snapshot}
        onApprovePair={(remember) => {
          if (!snapshot.pairing) return;
          void api
            .approvePairing(snapshot.pairing.id, remember)
            .then(() => pushToast('success', '已允许配对', snapshot.pairing?.deviceName))
            .catch((error) => pushToast('error', '操作失败', errorText(error)));
        }}
        onDenyPair={() => {
          if (!snapshot.pairing) return;
          void api.denyPairing(snapshot.pairing.id).catch((error) => pushToast('error', '操作失败', errorText(error)));
        }}
        onApproveLive={() => {
          if (!snapshot.livePending) return;
          void api
            .approveLive(snapshot.livePending.id)
            .catch((error) => pushToast('error', '操作失败', errorText(error)));
        }}
        onDenyLive={() => {
          if (!snapshot.livePending) return;
          void api.denyLive(snapshot.livePending.id).catch((error) => pushToast('error', '操作失败', errorText(error)));
        }}
      />

      <SettingsModal
        open={settingsOpen}
        snapshot={snapshot}
        onClose={() => setSettingsOpen(false)}
        onToast={pushToast}
      />
      <LogsModal open={logsOpen} onClose={() => setLogsOpen(false)} />
      <Toasts items={toasts} onDismiss={dismissToast} />
    </div>
  );
}

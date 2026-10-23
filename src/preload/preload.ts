import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { DesktopApi } from '../shared/types';

function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, payload: T) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api: DesktopApi = {
  getSnapshot: () => ipcRenderer.invoke('app:snapshot'),
  getHistory: () => ipcRenderer.invoke('app:history'),
  getLogs: () => ipcRenderer.invoke('app:logs'),
  reportReady: () => ipcRenderer.send('app:ready'),
  onSnapshot: (cb) => subscribe('app:snapshot', cb),
  onToast: (cb) => subscribe('app:toast', cb),
  onLivePrepare: (cb) => subscribe('live:prepare', cb),
  onLiveOffer: (cb) => subscribe('live:offer', cb),
  onLiveIce: (cb) => subscribe('live:ice', cb),
  onLiveStop: (cb) => subscribe('live:stop', cb),
  onLiveNotice: (cb) => subscribe('live:notice', cb),
  onLiveCommand: (cb) => subscribe('live:command', cb),
  onMediaLoad: (cb) => subscribe('media:load', cb),
  onMediaSync: (cb) => subscribe('media:sync', cb),
  onMediaCommand: (cb) => subscribe('media:command', cb),
  approvePairing: (requestId, remember) => ipcRenderer.invoke('app:approve-pairing', requestId, remember),
  denyPairing: (requestId) => ipcRenderer.invoke('app:deny-pairing', requestId),
  approveLive: (sessionId) => ipcRenderer.invoke('app:approve-live', sessionId),
  denyLive: (sessionId) => ipcRenderer.invoke('app:deny-live', sessionId),
  stopLive: (sessionId) => ipcRenderer.invoke('app:stop-live', sessionId),
  setLiveMuted: (sessionId, muted) => ipcRenderer.invoke('app:live-muted', sessionId, muted),
  setLiveVolume: (sessionId, volume) => ipcRenderer.invoke('app:live-volume', sessionId, volume),
  mediaCommand: (command, value) => ipcRenderer.invoke('app:media-command', command, value),
  updateSettings: (patch) => ipcRenderer.invoke('app:update-settings', patch),
  revokeDevice: (deviceId) => ipcRenderer.invoke('app:revoke-device', deviceId),
  refreshConnect: () => ipcRenderer.invoke('app:refresh-connect'),
  addLocalFiles: (paths) => ipcRenderer.invoke('app:add-local-files', paths),
  addUrl: (url) => ipcRenderer.invoke('app:add-url', url),
  reportLiveState: (report) => ipcRenderer.send('app:report-live-state', report),
  reportLiveSignal: (payload) => ipcRenderer.send('app:report-live-signal', payload),
  reportLiveGone: (payload) => ipcRenderer.send('app:report-live-gone', payload),
  reportMediaState: (report) => ipcRenderer.send('app:report-media-state', report),
  reportMediaGone: (payload) => ipcRenderer.send('app:report-media-gone', payload),
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },
  openLogs: () => {
    void ipcRenderer.invoke('app:open-logs');
  },
  openDataDir: () => {
    void ipcRenderer.invoke('app:open-data-dir');
  },
  clearUploads: () => ipcRenderer.invoke('app:clear-uploads'),
  copyDiagnostics: () => ipcRenderer.invoke('app:diagnostics'),
  installFirewallRule: () => ipcRenderer.invoke('app:install-firewall-rule'),
  setFullscreen: (value) => ipcRenderer.invoke('app:set-fullscreen', value),
  windowAction: (action) => {
    void ipcRenderer.invoke('app:window-action', action);
  },
  quit: () => {
    void ipcRenderer.invoke('app:quit');
  },
};

contextBridge.exposeInMainWorld('easypush', api);

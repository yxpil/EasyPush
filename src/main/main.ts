import { execFile } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  Menu,
  nativeImage,
  Notification,
  powerSaveBlocker,
  safeStorage,
  session,
  shell,
  Tray,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from 'electron';
import type { Settings } from '../shared/types';
import { AppCore, type DesktopPort } from './core/appCore';
import type { SecretBox } from './core/certs';
import { createDlnaRenderer } from './dlna/dlna';
import { registerIpcHandlers, removeIpcHandlers, type IpcHost } from './ipc';

const execFileAsync = promisify(execFile);
const APP_ID = 'com.easypush.receiver';

app.setName('EasyPush');
app.setAppUserModelId(APP_ID);
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// Test-only isolation: a private userData dir also gives the E2E run its own
// single-instance lock, so it can start beside an installed copy.
const userDataOverride = !app.isPackaged ? process.env['EASY_PUSH_USER_DATA'] : undefined;
if (userDataOverride) app.setPath('userData', path.resolve(userDataOverride));

const gotLock = app.requestSingleInstanceLock();
let core: AppCore | null = null;
let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let desktopOrigin = '';
let quitting = false;
let shutdownStarted = false;
let powerBlocker: number | null = null;
let startHidden = false;

if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  void bootstrap();
}

async function bootstrap(): Promise<void> {
  await app.whenReady();
  const dataOverride = !app.isPackaged ? process.env['EASY_PUSH_DATA_DIR'] : undefined;
  const dataDir = dataOverride ? path.resolve(dataOverride) : app.getPath('userData');
  await mkdir(dataDir, { recursive: true }).catch(() => undefined);
  const dev = !app.isPackaged;
  const paths = {
    webDir: path.join(app.getAppPath(), 'dist', 'web'),
    desktopDir: path.join(app.getAppPath(), 'dist', 'renderer'),
  };

  const box: SecretBox = {
    available: safeStorage.isEncryptionAvailable(),
    encrypt: (plain) => safeStorage.encryptString(plain).toString('base64'),
    decrypt: (cipher) => {
      try {
        return safeStorage.decryptString(Buffer.from(cipher, 'base64'));
      } catch {
        return null;
      }
    },
  };

  const desktopPort: DesktopPort = {
    isReady: () => Boolean(win && !win.isDestroyed()),
    send: (channel, payload) => {
      if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
    },
  };

  core = new AppCore({
    dataDir,
    version: app.getVersion(),
    desktop: desktopPort,
    secretBox: box,
    consoleLogs: dev,
    createDlna: createDlnaRenderer,
    onSettingsChanged: (settings) => {
      applyLoginItem(settings);
      updateTray(settings);
      void writeRuntime();
    },
    onSystemNotice: (title, body) => showNotification(title, body),
    onLiveActiveChanged: (active) => setPowerBlocker(active),
    onServerRestarted: (httpPort) => {
      desktopOrigin = `http://127.0.0.1:${httpPort}`;
      if (win && !win.isDestroyed()) void win.loadURL(`${desktopOrigin}/desktop/`);
      void writeRuntime();
    },
  });

  try {
    await core.start(paths);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[easypush] startup failed:', error instanceof Error ? (error.stack ?? error.message) : error);
    dialog.showErrorBox('EasyPush 启动失败', `无法启动本地服务：${message}\n\n请查看日志目录获取详细信息，或检查端口是否被占用。`);
    app.exit(1);
    return;
  }

  const ports = core.http.getPorts();
  desktopOrigin = `http://127.0.0.1:${ports.http}`;
  startHidden = process.argv.includes('--hidden') && core.getSnapshot().settings.closeToTray;

  configureSession();
  Menu.setApplicationMenu(null);
  const host: IpcHost = {
    assertTrusted: (event) => assertTrusted(event),
    windowAction: (action) => {
      if (!win) return;
      if (action === 'minimize') win.minimize();
      else if (action === 'toggle-maximize') {
        if (win.isMaximized()) win.unmaximize();
        else win.maximize();
      } else win.close();
    },
    setFullscreen: (value) => win?.setFullScreen(value),
    openPath: async (target) => {
      if (!core) return;
      const dir = target === 'logs' ? core.dataPaths.logsDir : core.dataPaths.dataDir;
      await mkdir(dir, { recursive: true }).catch(() => undefined);
      const error = await shell.openPath(dir);
      if (error) throw new Error(error);
    },
    copyText: (text) => clipboard.writeText(text),
    installFirewallRule: (portsToOpen) => installFirewallRule(portsToOpen),
    quit: () => {
      quitting = true;
      app.quit();
    },
  };
  registerIpcHandlers(core, host);
  createTray();
  updateTray(core.getSnapshot().settings);
  createWindow();
  applyLoginItem(core.getSnapshot().settings);
  await writeRuntime();

  app.on('activate', () => showWindow());
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('before-quit', (event) => {
    quitting = true;
    if (shutdownStarted) return;
    event.preventDefault();
    shutdownStarted = true;
    void finalize();
  });
}

function createWindow(): void {
  if (!core) return;
  if (win && !win.isDestroyed()) {
    showWindow();
    return;
  }
  const icon = iconPath();
  win = new BrowserWindow({
    width: 1200,
    height: 780,
    minWidth: 980,
    minHeight: 640,
    show: false,
    frame: false,
    backgroundColor: '#0a0c0d',
    title: 'EasyPush',
    icon: icon && !icon.isEmpty() ? icon : undefined,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      devTools: !app.isPackaged,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  win.setMenuBarVisibility(false);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(`${desktopOrigin}/desktop`)) event.preventDefault();
  });
  win.webContents.on('will-attach-webview', (event) => event.preventDefault());
  win.webContents.on('did-start-loading', () => {
    if (core?.isRendererReady) core.reportRendererGone('界面重新加载');
  });
  win.webContents.on('render-process-gone', (_event, details) => {
    if (quitting) return;
    core?.reportRendererGone(`渲染进程异常：${details.reason}`);
    showNotification('EasyPush 界面已恢复', '播放界面发生异常，正在重新加载。');
    setTimeout(() => {
      if (win && !win.isDestroyed()) win.webContents.reload();
    }, 800).unref();
  });
  win.webContents.on('unresponsive', () => {
    core?.reportRendererGone('界面无响应');
  });
  win.once('ready-to-show', () => {
    if (!startHidden) win?.show();
  });
  win.on('close', (event) => {
    if (!quitting && core?.getSnapshot().settings.closeToTray) {
      event.preventDefault();
      win?.hide();
    }
  });
  win.on('closed', () => {
    core?.reportRendererGone('窗口已关闭');
    win = null;
  });
  void win.loadURL(`${desktopOrigin}/desktop/`);
}

function showWindow(): void {
  if (!core) return;
  if (!win || win.isDestroyed()) {
    createWindow();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function configureSession(): void {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.setDisplayMediaRequestHandler((_request, callback) => callback({}));
}

function createTray(): void {
  try {
    const icon = iconPath();
    if (!icon || icon.isEmpty()) return;
    tray = new Tray(icon.resize({ width: 32, height: 32 }));
    tray.on('double-click', () => showWindow());
    tray.on('click', () => showWindow());
    rebuildTrayMenu();
  } catch {
    tray = null;
  }
}

function rebuildTrayMenu(): void {
  if (!tray) return;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示 EasyPush', click: () => showWindow() },
      {
        label: '复制访问地址',
        click: () => {
          const url = core?.getSnapshot().server.primaryUrl;
          if (url) clipboard.writeText(url);
        },
      },
      { type: 'separator' },
      { label: '打开日志目录', click: () => core && void shell.openPath(core.dataPaths.logsDir) },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
}

function updateTray(settings: Settings): void {
  if (!tray) return;
  const url = core?.getSnapshot().server.primaryUrl;
  tray.setToolTip(`EasyPush · ${settings.deviceName}${url ? ` · ${url.replace(/^https?:\/\//, '')}` : ''}`);
  rebuildTrayMenu();
}

function iconPath(): Electron.NativeImage | null {
  const file = app.isPackaged
    ? path.join(process.resourcesPath, 'assets', 'icon.png')
    : path.join(app.getAppPath(), 'assets', 'icon.png');
  try {
    const image = nativeImage.createFromPath(file);
    return image.isEmpty() ? null : image;
  } catch {
    return null;
  }
}

function showNotification(title: string, body: string): void {
  if (!Notification.isSupported()) return;
  try {
    const icon = iconPath();
    const notification = new Notification({
      title,
      body,
      icon: icon ?? undefined,
      silent: false,
    });
    notification.on('click', () => showWindow());
    notification.show();
  } catch {
    // notifications are best-effort
  }
}

function setPowerBlocker(active: boolean): void {
  if (active) {
    if (powerBlocker === null) powerBlocker = powerSaveBlocker.start('prevent-display-sleep');
  } else if (powerBlocker !== null) {
    if (powerSaveBlocker.isStarted(powerBlocker)) powerSaveBlocker.stop(powerBlocker);
    powerBlocker = null;
  }
}

function applyLoginItem(settings: Settings): void {
  if (!app.isPackaged) return;
  try {
    app.setLoginItemSettings({
      openAtLogin: settings.launchAtLogin,
      path: process.execPath,
      args: settings.launchAtLogin ? ['--hidden'] : [],
    });
  } catch {
    // some environments do not support login items
  }
}

async function writeRuntime(): Promise<void> {
  if (!core) return;
  try {
    const snapshot = core.getSnapshot();
    const payload = {
      app: 'EasyPush',
      version: snapshot.server.version,
      pid: process.pid,
      startedAt: snapshot.server.startedAt,
      httpPort: snapshot.server.httpPort,
      httpsPort: snapshot.server.httpsPort,
      urls: snapshot.server.addresses.map((address) => address.url),
      httpsUrls: snapshot.server.addresses.map((address) => address.httpsUrl).filter(Boolean),
      dlna: snapshot.server.dlna.location,
      updatedAt: Date.now(),
    };
    await writeFile(path.join(core.dataPaths.dataDir, 'runtime.json'), JSON.stringify(payload, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
  } catch {
    // runtime file is diagnostic only
  }
}

async function finalize(): Promise<void> {
  try {
    if (core) core.reportRendererGone('应用退出');
    setPowerBlocker(false);
    tray?.destroy();
    tray = null;
    removeIpcHandlers();
    await core?.shutdown();
    if (core) await rm(path.join(core.dataPaths.dataDir, 'runtime.json'), { force: true }).catch(() => undefined);
  } finally {
    app.exit(0);
  }
}

function assertTrusted(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  if (!win || win.isDestroyed()) return false;
  if (event.sender.id !== win.webContents.id) return false;
  const url = event.senderFrame?.url ?? '';
  return url.startsWith(`${desktopOrigin}/desktop`);
}

async function installFirewallRule(ports: number[]): Promise<{ ok: boolean; error?: string }> {
  if (process.platform !== 'win32') return { ok: false, error: '此功能仅支持 Windows' };
  const safePorts = [...new Set(ports.filter((port) => Number.isInteger(port) && port > 0 && port < 65_536))];
  if (safePorts.length === 0) return { ok: false, error: '端口不可用' };
  const list = safePorts.join(',');
  const command =
    `netsh advfirewall firewall delete rule name=EasyPush_TCP >nul 2>nul & ` +
    `netsh advfirewall firewall add rule name=EasyPush_TCP dir=in action=allow protocol=TCP localport=${list} >nul & ` +
    `netsh advfirewall firewall delete rule name=EasyPush_UDP >nul 2>nul & ` +
    `netsh advfirewall firewall add rule name=EasyPush_UDP dir=in action=allow protocol=UDP localport=1900 >nul`;
  const script = `Start-Process -FilePath cmd.exe -ArgumentList '/c ${command}' -Verb RunAs -Wait`;
  try {
    await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      timeout: 90_000,
      windowsHide: true,
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

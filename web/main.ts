import type { LiveStats, MeResponse, ServerHealth, UploadResponse } from '../src/shared/types';
import { MAX_UPLOAD_BYTES } from '../src/shared/types';
import { formatResolution } from '../src/shared/format';
import { ApiError, api, errorText, isUnauthorized, uploadFile } from './api';
import { beginWithCode, beginWithTicket, pairingName, resumeStoredSession, signOut, waitForApproval } from './pairing';
import { LiveSender, type LivePhase, type LiveMedia } from './live';
import {
  $,
  canShareScreen,
  closeSheet,
  copyText,
  escapeHtml,
  formatElapsed,
  formatRate,
  formatSize,
  icon,
  initUi,
  isSecure,
  openSheet,
  platform,
  setButtonBusy,
  toast,
} from './ui';

let health: ServerHealth | null = null;
let me: MeResponse | null = null;
let ticket: string | null = null;
let offline = false;
let signedOut = false;
let pairRunId = 0;
let pendingAbort: AbortController | null = null;
let countdownTimer: number | null = null;
let countdownDeadline: number | null = null;
let pollTimer: number | null = null;

let live: LiveSender | null = null;
let currentStream: MediaStream | null = null;
let liveStartedAt = 0;
let liveTimer: number | null = null;
let wakeLock: WakeLockSentinel | null = null;

let uploadQueue: UploadJob[] = [];
let uploading = false;

interface UploadJob {
  file: File;
  row: HTMLLIElement;
  bar: HTMLElement | null;
  meta: HTMLElement | null;
  state: HTMLElement | null;
  append: boolean;
}

function encrypted(): boolean {
  return location.protocol === 'https:';
}

function mobileBrowser(): boolean {
  return platform() !== 'desktop' || (navigator.maxTouchPoints > 1 && /Macintosh/i.test(navigator.userAgent));
}

function receiverName(): string {
  return me?.receiver.name ?? health?.deviceName ?? '电脑';
}

function appVersion(): string {
  return health?.version ?? me?.receiver.version ?? '';
}

function setText(id: string, value: string): void {
  const element = document.getElementById(id);
  if (element) element.textContent = value;
}

async function boot(): Promise<void> {
  initUi();
  bindStaticEvents();
  ticket = readTicket();
  try {
    health = await api.health();
  } catch (error) {
    showBootError(error instanceof ApiError && error.status === 0 ? networkHint() : errorText(error));
    return;
  }
  try {
    me = await api.me();
  } catch (error) {
    me = null;
    if (!isUnauthorized(error) && !(error instanceof ApiError && error.status === 0)) {
      showBootError(errorText(error));
      return;
    }
    if (error instanceof ApiError && error.status === 0) {
      showBootError(networkHint());
      return;
    }
  }
  if (!me) {
    const resumed = await resumeStoredSession().catch(() => false);
    if (resumed) {
      try {
        me = await api.me();
      } catch {
        me = null;
      }
    }
  }
  if (me) {
    enterApp();
  } else {
    enterPairing();
    if (ticket) void runTicketFlow(ticket);
  }
  startPolling();
}

function readTicket(): string | null {
  if (!location.hash) return null;
  const params = new URLSearchParams(location.hash.replace(/^#/, ''));
  const value = params.get('t');
  history.replaceState(null, '', location.pathname + location.search);
  if (!value || !/^[A-Za-z0-9_-]{16,128}$/.test(value)) return null;
  return value;
}

function networkHint(): string {
  if (location.protocol === 'https:') {
    return '无法建立加密连接。请确认已安装并信任 EasyPush 本地证书，然后重试。';
  }
  return '无法连接电脑。请确认电脑端 EasyPush 正在运行，并且手机与电脑连接同一个 Wi-Fi。';
}

function showBootError(detail: string): void {
  $('boot').hidden = false;
  $('screen-pair').hidden = true;
  $('screen-app').hidden = true;
  $('boot-status').textContent = '暂时连不上电脑';
  $('boot-detail').hidden = false;
  $('boot-detail').textContent = detail;
  $('boot-progress').hidden = true;
  $('boot-retry').hidden = false;
  document.title = '无法连接 · EasyPush';
}

function enterPairing(): void {
  closeSheet();
  $('boot').hidden = true;
  $('screen-app').hidden = true;
  $('screen-pair').hidden = false;
  document.title = '连接电脑 · EasyPush';
  resetPairView();
  applyBasicUi();
}

function enterApp(): void {
  closeSheet();
  $('boot').hidden = true;
  $('screen-pair').hidden = true;
  $('screen-app').hidden = false;
  document.title = `${receiverName()} · EasyPush`;
  signedOut = false;
  offline = false;
  applyUi();
}

function applyBasicUi(): void {
  const name = receiverName();
  setText('pair-receiver-chip', name);
  setText('top-receiver', name);
  setText('hero-receiver', name);
  setText('dlna-target', name);
  setText('top-status-text', encrypted() ? '已配对 · 加密连接' : '已配对 · 局域网');
  const version = appVersion();
  setText('pair-version', version ? `EasyPush v${version} · 协议 v1` : '');
  setText('foot-version', version ? `EasyPush v${version}` : 'EasyPush');
  const pill = $('pair-pill');
  pill.hidden = false;
  pill.textContent = encrypted() ? 'HTTPS 加密' : '局域网';
  pill.classList.toggle('is-secure', encrypted());
}

function applyUi(): void {
  applyBasicUi();
  if (!me) return;
  updatePolicyUi();
  $('secure-note').hidden = encrypted();
  $('secure-link').hidden = encrypted();
  const dlna = health?.allowDlna ?? false;
  $('dlna-card').hidden = !dlna;
  const hint = $('screen-hint');
  if (canShareScreen()) hint.textContent = '共享当前屏幕或标签页';
  else if (mobileBrowser()) hint.textContent = '手机浏览器不支持 · 查看替代方案';
  else hint.textContent = '需要 HTTPS 才能共享';
  updateStatusLine();
}

function updatePolicyUi(): void {
  if (!me) return;
  const allow = me.receiver.allowLive;
  const note = $('policy-note');
  note.hidden = allow;
  if (!allow) {
    note.innerHTML =
      `${icon('alert')}<div class="notice-body"><strong>实时投屏已关闭</strong><span>请在电脑端设置中开启「允许实时投屏」。照片与视频上传不受影响。</span></div>`;
  }
  for (const id of ['btn-camera', 'btn-screen']) {
    const button = document.getElementById(id);
    if (!button) continue;
    button.classList.toggle('is-off', !allow);
    button.setAttribute('aria-disabled', String(!allow));
  }
}

function updateStatusLine(): void {
  const line = $('top-status');
  const text = $('top-status-text');
  if (offline || !navigator.onLine) {
    line.classList.add('is-offline');
    text.textContent = '连接已断开';
    return;
  }
  line.classList.remove('is-offline');
  if (!live || !live.active) {
    text.textContent = encrypted() ? '已配对 · 加密连接' : '已配对 · 局域网';
    return;
  }
  switch (live.currentPhase) {
    case 'live':
      text.textContent = live.currentMedia === 'screen' ? '正在共享屏幕' : '摄像头投屏中';
      break;
    case 'reconnecting':
      text.textContent = '正在恢复连接';
      break;
    case 'awaiting-approval':
    case 'awaiting-takeover':
      text.textContent = '等待电脑确认';
      break;
    default:
      text.textContent = '正在连接电脑';
      break;
  }
}

function resetPairView(): void {
  $('pair-form').hidden = false;
  $('pair-pending').hidden = true;
  $('pair-heading').textContent = '连接这台电脑';
  $('pair-lede').textContent = '输入电脑屏幕上显示的 6 位配对码';
  hidePairError();
  clearCountdown();
  const code = $<HTMLInputElement>('pair-code');
  code.value = '';
  $<HTMLButtonElement>('pair-submit').disabled = true;
  $<HTMLInputElement>('pair-name').value = pairingName();
}

function setPairHeading(title: string, lede: string): void {
  $('pair-heading').textContent = title;
  $('pair-lede').textContent = lede;
}

function showPending(title: string, sub: string): void {
  $('pair-form').hidden = true;
  $('pair-pending').hidden = false;
  setText('pending-title', title);
  setText('pending-sub', sub);
}

function hidePairError(): void {
  const box = $('pair-inline-error');
  box.hidden = true;
  box.textContent = '';
}

function showPairError(message: string): void {
  pairRunId += 1;
  pendingAbort?.abort();
  pendingAbort = null;
  resetPairView();
  const box = $('pair-inline-error');
  box.textContent = message;
  box.hidden = false;
  setButtonBusy($<HTMLButtonElement>('pair-submit'), false, '');
}

function startCountdown(expiresAt: number | null): void {
  countdownDeadline = expiresAt;
  if (countdownTimer === null) countdownTimer = window.setInterval(renderCountdown, 1000);
  renderCountdown();
}

function renderCountdown(): void {
  if (!countdownDeadline || $('pair-pending').hidden) return;
  const left = Math.max(0, Math.ceil((countdownDeadline - Date.now()) / 1000));
  $('pending-sub').textContent = left > 0 ? `请在电脑上点击「允许」· ${left} 秒` : '请求即将超时，请重新发起配对';
}

function clearCountdown(): void {
  if (countdownTimer !== null) window.clearInterval(countdownTimer);
  countdownTimer = null;
  countdownDeadline = null;
}

async function runTicketFlow(value: string): Promise<void> {
  const runId = ++pairRunId;
  enterPairing();
  setPairHeading('正在连接电脑', '二维码已识别，正在等待电脑确认');
  showPending('正在验证二维码', '正在向电脑确认这次邀请…');
  pendingAbort?.abort();
  const controller = new AbortController();
  pendingAbort = controller;
  try {
    const result = await beginWithTicket(value, $<HTMLInputElement>('pair-name').value || pairingName());
    if (runId !== pairRunId) return;
    if (result.status === 'error') {
      showPairError(result.message);
      return;
    }
    if (result.status === 'approved') {
      await completePairing(runId);
      return;
    }
    setPairHeading('等待电脑确认', '配对请求已发送到电脑');
    showPending('等待电脑确认', '请在电脑上点击「允许」');
    const outcome = await waitForApproval(result.requestId, controller.signal, (expiresAt) => {
      if (runId === pairRunId) startCountdown(expiresAt);
    });
    if (runId !== pairRunId) return;
    if (outcome === 'approved') {
      await completePairing(runId);
      return;
    }
    showPairError(outcome === 'denied' ? '电脑拒绝了这次配对请求，请重新尝试。' : '配对请求已超时，请输入电脑上的 6 位配对码。');
  } catch (error) {
    if (runId !== pairRunId) return;
    if (error instanceof DOMException && error.name === 'AbortError') return;
    showPairError(errorText(error));
  } finally {
    if (runId === pairRunId) pendingAbort = null;
  }
}

async function runCodeFlow(code: string): Promise<void> {
  const runId = ++pairRunId;
  pendingAbort?.abort();
  const controller = new AbortController();
  pendingAbort = controller;
  hidePairError();
  const submit = $<HTMLButtonElement>('pair-submit');
  setButtonBusy(submit, true, '正在连接');
  try {
    const result = await beginWithCode(code, $<HTMLInputElement>('pair-name').value || pairingName());
    if (runId !== pairRunId) return;
    if (result.status === 'error') {
      showPairError(result.message);
      return;
    }
    if (result.status === 'approved') {
      await completePairing(runId);
      return;
    }
    setButtonBusy(submit, false, '');
    setPairHeading('等待电脑确认', '配对请求已发送到电脑');
    showPending('等待电脑确认', '请在电脑上点击「允许」');
    const outcome = await waitForApproval(result.requestId, controller.signal, (expiresAt) => {
      if (runId === pairRunId) startCountdown(expiresAt);
    });
    if (runId !== pairRunId) return;
    if (outcome === 'approved') {
      await completePairing(runId);
      return;
    }
    showPairError(outcome === 'denied' ? '电脑拒绝了这次配对请求，请重新输入配对码。' : '配对请求已超时，请重新输入电脑上的 6 位配对码。');
  } catch (error) {
    if (runId !== pairRunId) return;
    if (error instanceof DOMException && error.name === 'AbortError') return;
    showPairError(errorText(error));
  } finally {
    if (runId === pairRunId) {
      pendingAbort = null;
      setButtonBusy(submit, false, '');
    }
  }
}

async function completePairing(runId: number): Promise<void> {
  clearCountdown();
  if (runId !== pairRunId) return;
  setPairHeading('配对成功', '正在读取电脑信息…');
  showPending('配对成功', '即将进入投屏页面…');
  try {
    const next = await api.me();
    if (runId !== pairRunId) return;
    me = next;
    ticket = null;
    pendingAbort?.abort();
    pendingAbort = null;
    enterApp();
    toast('success', '已连接电脑', `${next.receiver.name} · 这台设备已加入`);
    void refreshStatus(false);
  } catch (error) {
    if (runId !== pairRunId) return;
    showBootError(`配对已完成，但读取电脑信息失败：${errorText(error)}。请重新加载页面。`);
  }
}

function cancelPairing(): void {
  pairRunId += 1;
  pendingAbort?.abort();
  pendingAbort = null;
  resetPairView();
  applyBasicUi();
}

function startPolling(): void {
  if (pollTimer !== null) return;
  pollTimer = window.setInterval(() => {
    if (document.visibilityState === 'visible') void refreshStatus(false);
  }, 45_000);
}

async function refreshStatus(announce: boolean): Promise<void> {
  if (!me) return;
  try {
    const [nextHealth, nextMe] = await Promise.all([api.health(), api.me()]);
    health = nextHealth;
    me = nextMe;
    offline = false;
    applyUi();
    if (announce) toast('success', '连接正常', receiverName());
  } catch (error) {
    if (isUnauthorized(error)) {
      handleSignedOut();
      return;
    }
    offline = true;
    updateStatusLine();
    if (announce) toast('error', '无法连接电脑', errorText(error));
  }
}

function handleSignedOut(): void {
  if (signedOut) return;
  signedOut = true;
  live?.stop();
  endLiveUi();
  me = null;
  uploadQueue = [];
  closeSheet();
  enterPairing();
  const message = '这台设备已从电脑移除，或连接已过期。请输入电脑上的新配对码。';
  showPairError(message);
  toast('warn', '需要重新配对', message);
  window.setTimeout(() => {
    signedOut = false;
  }, 500);
}

function bindStaticEvents(): void {
  $('boot-retry').addEventListener('click', () => location.reload());

  const codeInput = $<HTMLInputElement>('pair-code');
  codeInput.addEventListener('input', () => {
    const digits = codeInput.value.replace(/\D/g, '').slice(0, 6);
    codeInput.value = digits;
    $<HTMLButtonElement>('pair-submit').disabled = digits.length !== 6;
    if (!digits) hidePairError();
  });
  $('pair-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const code = codeInput.value.replace(/\D/g, '');
    if (code.length !== 6) return;
    hidePairError();
    void runCodeFlow(code);
  });
  $('pair-cancel').addEventListener('click', cancelPairing);
  $('pair-help').addEventListener('click', openHelpSheet);

  $('btn-camera').addEventListener('click', openCameraSheet);
  $('btn-screen').addEventListener('click', () => {
    if (!requireLiveAccess()) return;
    if (!canShareScreen()) {
      openScreenHelp();
      return;
    }
    void startScreenShare();
  });
  $('btn-secure-note').addEventListener('click', openSecureSheet);
  $('secure-link').addEventListener('click', openSecureSheet);
  $('btn-menu').addEventListener('click', openMenuSheet);
  $('btn-foot-help').addEventListener('click', openHelpSheet);

  $('live-stop').addEventListener('click', stopLiveByUser);
  $('live-mic').addEventListener('click', toggleMic);
  $('live-flip').addEventListener('click', () => void flipCamera());

  const fileInput = $<HTMLInputElement>('file-input');
  fileInput.addEventListener('change', () => {
    const files = fileInput.files;
    uploadFiles(files);
    fileInput.value = '';
  });
  const dropzone = $('dropzone');
  for (const type of ['dragenter', 'dragover']) {
    dropzone.addEventListener(type, (event) => {
      event.preventDefault();
      dropzone.classList.add('is-drag');
    });
  }
  for (const type of ['dragleave', 'dragend']) {
    dropzone.addEventListener(type, () => dropzone.classList.remove('is-drag'));
  }
  dropzone.addEventListener('drop', (event) => {
    event.preventDefault();
    dropzone.classList.remove('is-drag');
    uploadFiles(event.dataTransfer?.files ?? null);
  });

  const urlForm = $<HTMLFormElement>('url-form');
  const urlInput = $<HTMLInputElement>('url-input');
  urlForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const value = urlInput.value.trim();
    if (!/^https?:\/\//i.test(value)) {
      toast('warn', '地址无效', '请输入以 http:// 或 https:// 开头的媒体直链');
      return;
    }
    if (!me) return;
    const button = urlForm.querySelector<HTMLButtonElement>('button');
    if (!button) return;
    setButtonBusy(button, true, '发送中');
    void (async () => {
      try {
        const result = await api.castUrl(value);
        urlInput.value = '';
        toast(
          'success',
          result.queued ? '已加入播放队列' : '已发送到电脑',
          result.queued ? '当前投屏结束后开始播放' : '电脑端即将开始播放',
        );
      } catch (error) {
        if (isUnauthorized(error)) {
          handleSignedOut();
          return;
        }
        toast('error', '无法播放此地址', errorText(error));
      } finally {
        setButtonBusy(button, false, '');
      }
    })();
  });

  live = new LiveSender({
    stream: (stream) => {
      currentStream = stream;
      const video = $<HTMLVideoElement>('live-video');
      video.srcObject = stream;
      void video.play().catch(() => undefined);
    },
    phase: (phase) => renderLivePhase(phase),
    stats: (stats) => renderStats(stats),
    notice: (message) => toast('info', '电脑提示', message),
    error: (message) => {
      endLiveUi();
      toast('error', '投屏失败', message);
    },
    ended: (reason) => {
      endLiveUi();
      toast('info', '投屏已结束', liveReason(reason));
    },
  });

  window.addEventListener('online', () => {
    offline = false;
    updateStatusLine();
    if (me && !$('screen-app').hidden) void refreshStatus(false);
  });
  window.addEventListener('offline', () => {
    offline = true;
    updateStatusLine();
    toast('warn', '网络已断开', '请检查 Wi-Fi，重新连接后投屏会自动恢复');
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (live?.active && live.currentPhase === 'live') void acquireWakeLock();
    if (me && !$('screen-app').hidden) void refreshStatus(false);
  });
  window.addEventListener('pagehide', () => {
    live?.stop();
    releaseWakeLock();
  });
}

function requireLiveAccess(): boolean {
  if (!me) {
    toast('warn', '需要先配对', '请回到电脑完成配对后再投屏');
    return false;
  }
  if (!me.receiver.allowLive) {
    toast('warn', '实时投屏已关闭', '请在电脑端设置中开启「允许实时投屏」');
    return false;
  }
  if (live?.active) {
    toast('info', '正在投屏', '请先结束当前投屏，再开始新的投屏');
    scrollToLive();
    return false;
  }
  return true;
}

function openCameraSheet(): void {
  if (!requireLiveAccess()) return;
  if (!isSecure()) {
    openSecureSheet();
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    openSecureSheet();
    return;
  }
  const body = openSheet(
    '摄像头投屏',
    `
      <p>把手机摄像头画面实时投到电脑。画面仅在局域网内传输，不经过云端。</p>
      <div class="sheet-section">
        <span class="sheet-label">使用哪个摄像头</span>
        <div class="segmented" role="group" aria-label="选择摄像头">
          <button type="button" data-facing="environment" class="on">后置摄像头</button>
          <button type="button" data-facing="user">前置摄像头</button>
        </div>
      </div>
      <div class="switch-row">
        <span><strong>传输手机声音</strong><small>默认关闭，开启后会使用手机麦克风</small></span>
        <input id="cam-audio" class="switch" type="checkbox" role="switch" aria-label="传输手机麦克风声音" />
      </div>
      <p class="sheet-note">首次使用时浏览器会询问摄像头权限。建议手机与电脑连接同一 5 GHz Wi-Fi。</p>
      <p id="cam-error" class="inline-error" hidden></p>
      <div class="sheet-actions">
        <button id="cam-start" class="btn btn-primary btn-lg" type="button">开始投屏</button>
      </div>
    `,
  );
  let facing: 'environment' | 'user' = 'environment';
  for (const button of body.querySelectorAll<HTMLButtonElement>('[data-facing]')) {
    button.addEventListener('click', () => {
      facing = button.dataset.facing === 'user' ? 'user' : 'environment';
      for (const other of body.querySelectorAll<HTMLButtonElement>('[data-facing]')) {
        other.classList.toggle('on', other === button);
      }
    });
  }
  const audio = body.querySelector<HTMLInputElement>('#cam-audio');
  const start = body.querySelector<HTMLButtonElement>('#cam-start');
  start?.addEventListener('click', () => {
    if (!start) return;
    setButtonBusy(start, true, '正在打开摄像头');
    void (async () => {
      try {
        const stream = await openCameraStream(facing, audio?.checked ?? false);
        closeSheet();
        await startLive('camera', stream);
      } catch (error) {
        if (start) setButtonBusy(start, false, '');
        showSheetError(body, cameraErrorText(error));
      }
    })();
  });
}

async function openCameraStream(facing: 'environment' | 'user', withAudio: boolean): Promise<MediaStream> {
  const video: MediaTrackConstraints = {
    facingMode: { ideal: facing },
    width: { ideal: 1280 },
    height: { ideal: 720 },
    frameRate: { ideal: 30, max: 30 },
  };
  const audio: MediaTrackConstraints | false = withAudio
    ? { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    : false;
  try {
    return await navigator.mediaDevices.getUserMedia({ video, audio });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'OverconstrainedError') {
      return navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: facing } }, audio });
    }
    throw error;
  }
}

function cameraErrorText(error: unknown): string {
  if (error instanceof DOMException) {
    switch (error.name) {
      case 'NotAllowedError':
      case 'SecurityError':
        return '摄像头权限被拒绝。请在浏览器地址栏的权限设置中允许摄像头，或确认当前是 HTTPS 安全连接。';
      case 'NotFoundError':
      case 'DevicesNotFoundError':
        return '没有找到可用的摄像头。';
      case 'NotReadableError':
      case 'TrackStartError':
        return '摄像头被其他应用占用，请关闭占用摄像头的应用后重试。';
      case 'OverconstrainedError':
        return '当前摄像头不支持请求的画面规格，请重试。';
      default:
        break;
    }
  }
  return errorText(error);
}

function openScreenHelp(): void {
  const body = openSheet(
    '关于手机共享屏幕',
    `
      <div class="notice notice-warn">
        ${icon('monitor')}
        <div class="notice-body">
          <strong>手机浏览器不能抓取整块手机屏幕</strong>
          <span>iOS 与 Android 的浏览器都没有开放屏幕捕获接口，这是系统限制，不是 EasyPush 缺少功能。</span>
        </div>
      </div>
      <p>可以改用这些方式，把内容放到电脑大屏：</p>
      <ul class="sheet-list">
        <li><b>录屏后上传：</b>用系统录屏录下手机画面，回到本页上传视频即可播放。</li>
        <li><b>用电脑共享屏幕：</b>在电脑浏览器打开本页，点击「共享屏幕」选择屏幕或标签页。</li>
        <li><b>用 DLNA 推送：</b>在支持 DLNA 的应用里把照片、音乐或视频投到电脑。</li>
      </ul>
      <div class="sheet-actions">
        <button id="screen-upload" class="btn btn-primary" type="button">上传录屏文件</button>
        <button id="screen-copy" class="btn btn-ghost" type="button">复制电脑访问地址</button>
        <button id="screen-secure" class="btn btn-ghost" type="button">查看 HTTPS 证书设置</button>
      </div>
      <p class="sheet-note">在电脑浏览器上使用屏幕共享时，需要先开启 HTTPS 安全连接（本机 127.0.0.1 访问除外）。</p>
    `,
  );
  body.querySelector('#screen-upload')?.addEventListener('click', () => {
    closeSheet();
    $<HTMLInputElement>('file-input').click();
  });
  body.querySelector('#screen-copy')?.addEventListener('click', () => {
    void copyText(`${location.origin}/`).then((ok) => {
      toast(ok ? 'success' : 'warn', ok ? '地址已复制' : '复制失败', `${location.origin}/`);
    });
  });
  body.querySelector('#screen-secure')?.addEventListener('click', () => openSecureSheet());
}

async function startScreenShare(): Promise<void> {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    openScreenHelp();
    return;
  }
  let stream: MediaStream;
  try {
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30, max: 30 } },
        audio: true,
      });
    } catch (error) {
      if (error instanceof DOMException && ['NotSupportedError', 'TypeError', 'OverconstrainedError'].includes(error.name)) {
        stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      } else {
        throw error;
      }
    }
  } catch (error) {
    toast('error', '无法共享屏幕', displayErrorText(error));
    return;
  }
  if (stream.getVideoTracks().length === 0) {
    stopStream(stream);
    toast('error', '无法共享屏幕', '没有获取到屏幕画面，请重试。');
    return;
  }
  const track = stream.getVideoTracks()[0];
  track?.addEventListener(
    'ended',
    () => {
      if (live?.active) {
        live.stop();
        toast('info', '共享已结束', '你已停止共享屏幕');
      }
    },
    { once: true },
  );
  await startLive('screen', stream);
}

function displayErrorText(error: unknown): string {
  if (error instanceof DOMException) {
    switch (error.name) {
      case 'NotAllowedError':
        return '共享被取消，或浏览器拒绝了屏幕捕获权限。';
      case 'NotFoundError':
        return '没有可共享的屏幕。';
      case 'NotSupportedError':
      case 'TypeError':
        return '当前浏览器或页面不支持屏幕共享，请使用桌面 Chrome、Edge 或 Safari 并通过 HTTPS 访问。';
      default:
        break;
    }
  }
  return errorText(error);
}

async function startLive(media: LiveMedia, stream: MediaStream): Promise<void> {
  if (!me) {
    stopStream(stream);
    return;
  }
  if (live?.active) {
    stopStream(stream);
    toast('info', '正在投屏', '请先结束当前投屏');
    scrollToLive();
    return;
  }
  if (!live) return;
  currentStream = stream;
  const video = $<HTMLVideoElement>('live-video');
  video.srcObject = stream;
  void video.play().catch(() => undefined);
  const hasAudio = stream.getAudioTracks().length > 0;
  $('live-panel').hidden = false;
  $('live-cover').hidden = false;
  $('live-metrics').hidden = true;
  $('live-cover-title').textContent = '正在联系电脑';
  $('live-cover-sub').textContent = '请确认电脑端 EasyPush 仍在前台运行';
  $('live-timer').textContent = '0:00';
  $('live-kicker').textContent = media === 'screen' ? '屏幕共享' : '实时投屏';
  configureLiveControls(media, hasAudio);
  setMicUi(true);
  liveStartedAt = 0;
  stopLiveTimer();
  updateStatusLine();
  window.setTimeout(scrollToLive, 80);
  await live.start(media, stream);
}

function configureLiveControls(media: LiveMedia, hasAudio: boolean): void {
  $('live-mic').hidden = !hasAudio;
  $('live-flip').hidden = media !== 'camera';
  const controls = document.querySelector<HTMLElement>('.live-controls');
  if (!controls) return;
  const visible = (hasAudio ? 1 : 0) + (media === 'camera' ? 1 : 0) + 1;
  controls.classList.toggle('is-two', visible === 2);
  controls.classList.toggle('is-solo', visible === 1);
}

function renderLivePhase(phase: LivePhase): void {
  if (phase === 'ended' || phase === 'error') {
    endLiveUi();
    return;
  }
  const cover = $('live-cover');
  const title = $('live-cover-title');
  const sub = $('live-cover-sub');
  switch (phase) {
    case 'requesting':
      cover.hidden = false;
      title.textContent = '正在联系电脑';
      sub.textContent = '请确认电脑端 EasyPush 已打开且在同一 Wi-Fi';
      break;
    case 'awaiting-approval':
      cover.hidden = false;
      title.textContent = '等待电脑确认';
      sub.textContent = '请在电脑上点击「允许」开始投屏';
      break;
    case 'awaiting-takeover':
      cover.hidden = false;
      title.textContent = '电脑正在投屏';
      sub.textContent = '请在电脑上确认是否允许本次投屏接管画面';
      break;
    case 'connecting':
      cover.hidden = false;
      title.textContent = '正在建立画面';
      sub.textContent = '通常只需要一两秒';
      break;
    case 'reconnecting':
      cover.hidden = false;
      title.textContent = '连接中断，正在恢复';
      sub.textContent = '请保持本页在前台，并确认 Wi-Fi 可用';
      break;
    case 'live':
      cover.hidden = true;
      $('live-metrics').hidden = false;
      $('live-kicker').textContent = live?.currentMedia === 'screen' ? '屏幕共享' : '实时投屏';
      startLiveTimer();
      void acquireWakeLock();
      break;
    default:
      break;
  }
  updateStatusLine();
}

function renderStats(stats: LiveStats): void {
  setText('m-res', formatResolution(stats.width, stats.height));
  setText('m-fps', stats.fps > 0 ? `${Math.round(stats.fps)} fps` : '—');
  setText('m-rate', formatRate(stats.bitrateKbps));
  setText('m-rtt', stats.rttMs === null ? '—' : `${Math.round(stats.rttMs)} ms`);
}

function stopLiveByUser(): void {
  live?.stop();
  endLiveUi();
}

function toggleMic(): void {
  if (!live?.hasAudio) return;
  const button = $('live-mic');
  const enabled = !button.classList.contains('is-off');
  live.setAudioEnabled(!enabled);
  setMicUi(!enabled);
}

function setMicUi(on: boolean): void {
  const button = $('live-mic');
  button.classList.toggle('is-off', !on);
  button.setAttribute('aria-pressed', String(on));
  setText('live-mic-label', on ? '麦克风' : '已静音');
  const use = button.querySelector('use');
  use?.setAttribute('href', on ? '#i-mic' : '#i-mic-off');
}

async function flipCamera(): Promise<void> {
  if (!live || live.currentMedia !== 'camera') return;
  const button = $<HTMLButtonElement>('live-flip');
  const label = button.querySelector('span');
  const previous = label?.textContent ?? '翻转';
  button.disabled = true;
  if (label) label.textContent = '翻转中';
  try {
    const facing = await live.switchCamera();
    if (facing !== 'none') toast('info', '摄像头已切换', facing === 'environment' ? '正在使用后置摄像头' : '正在使用前置摄像头');
  } catch (error) {
    toast('error', '切换摄像头失败', errorText(error));
  } finally {
    button.disabled = false;
    if (label) label.textContent = previous;
  }
}

function endLiveUi(): void {
  stopLiveTimer();
  liveStartedAt = 0;
  releaseWakeLock();
  const video = $<HTMLVideoElement>('live-video');
  try {
    video.pause();
  } catch {
    // video may already be detached
  }
  video.srcObject = null;
  if (currentStream) stopStream(currentStream);
  currentStream = null;
  $('live-panel').hidden = true;
  $('live-cover').hidden = false;
  $('live-metrics').hidden = true;
  setText('live-timer', '0:00');
  updateStatusLine();
}

function scrollToLive(): void {
  const panel = $('live-panel');
  if (panel.hidden) return;
  panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function startLiveTimer(): void {
  if (liveTimer !== null) return;
  if (!liveStartedAt) liveStartedAt = Date.now();
  const render = () => {
    const seconds = liveStartedAt ? Math.floor((Date.now() - liveStartedAt) / 1000) : 0;
    setText('live-timer', formatElapsed(seconds));
  };
  render();
  liveTimer = window.setInterval(render, 1000);
}

function stopLiveTimer(): void {
  if (liveTimer !== null) window.clearInterval(liveTimer);
  liveTimer = null;
}

async function acquireWakeLock(): Promise<void> {
  if (wakeLock || !window.isSecureContext || !('wakeLock' in navigator)) return;
  try {
    const sentinel = await navigator.wakeLock.request('screen');
    wakeLock = sentinel;
    sentinel.addEventListener('release', () => {
      if (wakeLock === sentinel) wakeLock = null;
    });
  } catch {
    // wake lock is best-effort
  }
}

function releaseWakeLock(): void {
  const current = wakeLock;
  wakeLock = null;
  if (current) void current.release().catch(() => undefined);
}

function stopStream(stream: MediaStream): void {
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      // already ended
    }
  }
}

function liveReason(reason: string): string {
  if (!reason) return '投屏已结束';
  if (/[\u4e00-\u9fff]/.test(reason)) return reason;
  const known: Record<string, string> = {
    'stopped by receiver': '电脑端结束了投屏',
    'receiver-unavailable': '电脑端接收界面已关闭',
    'connection timeout': '连接超时，请重试',
    'control connection lost': '控制连接已中断',
    'sender did not start media': '画面没有成功建立',
    'replaced by sender': '已由新的投屏替换',
    takeover: '投屏已被新的设备接管',
    shutdown: '电脑端应用已关闭',
  };
  return known[reason] ?? '投屏已结束';
}

function uploadFiles(files: FileList | null): void {
  if (!files || !me) return;
  const list = $('upload-list');
  const limit = me.limits.maxUploadBytes || MAX_UPLOAD_BYTES;
  let accepted = 0;
  for (const file of Array.from(files)) {
    if (file.size === 0) {
      toast('warn', '文件为空', file.name);
      continue;
    }
    if (file.size > limit) {
      toast('error', '文件太大', `${file.name} 超过 ${formatSize(limit)} 限制`);
      continue;
    }
    const type = file.type.toLowerCase();
    if (type && !type.startsWith('image/') && !type.startsWith('video/') && !type.startsWith('audio/')) {
      toast('warn', '不支持的文件类型', `${file.name} 不是图片、视频或音频`);
      continue;
    }
    const job = createUploadRow(file, accepted > 0);
    accepted += 1;
    uploadQueue.push(job);
    list.append(job.row);
    while (list.children.length > 12) {
      list.firstElementChild?.remove();
    }
  }
  void pumpUploads();
}

function createUploadRow(file: File, append: boolean): UploadJob {
  const row = document.createElement('li');
  row.className = 'upload-row';
  const kind = file.type.startsWith('image/')
    ? 'image'
    : file.type.startsWith('audio/')
      ? 'audio'
      : file.type.startsWith('video/')
        ? 'video'
        : 'upload';
  row.innerHTML =
    `<span class="upload-kind">${icon(kind)}</span>` +
    '<div class="upload-info">' +
    '<span class="upload-name"></span>' +
    `<span class="upload-meta">${formatSize(file.size)} · 准备上传</span>` +
    '<div class="upload-bar"><i></i></div>' +
    '</div>' +
    `<span class="upload-state">${icon('upload')}</span>`;
  const name = row.querySelector<HTMLElement>('.upload-name');
  if (name) name.textContent = file.name;
  return {
    file,
    row,
    bar: row.querySelector<HTMLElement>('.upload-bar i'),
    meta: row.querySelector<HTMLElement>('.upload-meta'),
    state: row.querySelector<HTMLElement>('.upload-state'),
    append,
  };
}

async function pumpUploads(): Promise<void> {
  if (uploading) return;
  uploading = true;
  try {
    for (;;) {
      const job = uploadQueue.shift();
      if (!job || !me) break;
      await runUpload(job);
    }
  } finally {
    uploading = false;
  }
}

async function runUpload(job: UploadJob): Promise<void> {
  job.row.classList.remove('is-ok', 'is-error');
  if (job.meta) job.meta.textContent = `${formatSize(job.file.size)} · 正在上传`;
  if (job.state) job.state.innerHTML = '<span class="spinner"></span>';
  try {
    const response = await uploadFile(job.file, (ratio) => {
      if (job.bar) job.bar.style.width = `${Math.round(ratio * 100)}%`;
      if (job.meta) job.meta.textContent = `${Math.round(ratio * 100)}% · ${formatSize(job.file.size)}`;
    }, undefined, job.append);
    job.row.classList.add('is-ok');
    if (job.bar) job.bar.style.width = '100%';
    if (job.state) job.state.innerHTML = icon('check');
    if (job.meta) job.meta.textContent = uploadResultText(response);
  } catch (error) {
    if (isUnauthorized(error)) {
      markUploadFailed(job, '连接已失效');
      handleSignedOut();
      return;
    }
    markUploadFailed(job, errorText(error));
    toast('error', '上传失败', `${job.file.name} · ${errorText(error)}`);
  }
}

function markUploadFailed(job: UploadJob, message: string): void {
  job.row.classList.add('is-error');
  if (job.meta) job.meta.textContent = message;
  if (job.state) job.state.innerHTML = icon('alert');
}

function uploadResultText(response: UploadResponse): string {
  if (response.queued) return '已发送 · 当前投屏结束后播放';
  if (response.appended) return '已加入 · 将在当前内容后播放';
  return '已发送 · 正在电脑上播放';
}

function showSheetError(body: HTMLElement, message: string): void {
  let box = body.querySelector<HTMLParagraphElement>('[data-sheet-error]');
  if (!box) {
    box = document.createElement('p');
    box.className = 'inline-error';
    box.dataset['sheetError'] = '';
    body.appendChild(box);
  }
  box.textContent = message;
  box.hidden = false;
}

function openSecureSheet(): void {
  if (encrypted()) {
    const body = openSheet(
      '安全连接',
      `
        <p>当前页面已通过 HTTPS 加密连接，摄像头与屏幕捕获能力可用。</p>
        <div class="sheet-section">
          <div class="sheet-row"><span>连接方式</span><b>HTTPS · 已加密</b></div>
          <div class="sheet-row"><span>接收端</span><b>${escapeHtml(receiverName())}</b></div>
          <div class="sheet-row"><span>页面地址</span><b>${escapeHtml(location.origin)}</b></div>
          <div class="sheet-row"><span>证书</span><b>EasyPush Local CA</b></div>
        </div>
        <p class="sheet-note">证书由电脑本地生成，私钥不会离开电脑。如果浏览器地址栏仍显示安全警告，说明本地 CA 尚未被系统完全信任，请重新安装证书并开启完全信任。</p>
        <div class="sheet-actions">
          <button id="secure-refresh" class="btn btn-ghost" type="button">刷新连接状态</button>
        </div>
      `,
    );
    body.querySelector('#secure-refresh')?.addEventListener('click', () => {
      void refreshStatus(true);
      closeSheet();
    });
    return;
  }

  const httpsUrl = secureUrl();
  const body = openSheet(
    '开启安全连接',
    `
      <div class="notice notice-warn">
        ${icon('shield')}
        <div class="notice-body">
          <strong>HTTP 页面无法使用摄像头</strong>
          <span>浏览器只在 HTTPS 或本机地址上开放摄像头、麦克风与屏幕捕获。安装一次本地证书即可。</span>
        </div>
      </div>
      <div class="sheet-section">
        <h3>安装步骤</h3>
        <ul class="sheet-list">
          <li><b>第一步：</b>点击下方按钮下载 EasyPush 本地证书（<code>CA.crt</code>）。</li>
          <li><b>iPhone / iPad：</b>在「设置」中安装已下载的描述文件，再到 设置 → 通用 → 关于本机 → 证书信任设置，为 EasyPush Local CA 开启完全信任。</li>
          <li><b>Android：</b>打开 设置 → 安全 → 加密与凭据 → 安装证书 → CA 证书，选择下载的文件。</li>
          <li><b>第二步：</b>打开加密地址，重新输入电脑上的配对码完成配对。</li>
        </ul>
      </div>
      <div class="sheet-actions">
        <a class="btn btn-primary btn-block" href="/ca.crt" download="EasyPush-CA.crt">${icon('download')}下载 EasyPush 证书</a>
        <button id="secure-copy" class="btn btn-ghost" type="button">${icon('copy')}复制加密地址</button>
        ${
          httpsUrl
            ? `<a class="btn btn-ghost btn-block" href="${escapeHtml(httpsUrl)}">${icon('lock')}打开加密页面</a>`
            : '<p class="sheet-note">电脑端的 HTTPS 服务没有启动。请在电脑上检查 7443 端口是否被占用，然后重启 EasyPush。</p>'
        }
      </div>
      <p class="sheet-note">加密地址与当前 HTTP 地址属于不同来源，浏览器的登录状态不会共享，因此切换后需要重新配对一次。二维码邀请也可以通过电脑上的加密二维码直接完成配对。</p>
    `,
  );
  body.querySelector('#secure-copy')?.addEventListener('click', () => {
    if (!httpsUrl) {
      toast('warn', '没有可用的加密地址', '请先在电脑端启动 HTTPS 服务');
      return;
    }
    void copyText(httpsUrl).then((ok) => {
      toast(ok ? 'success' : 'warn', ok ? '加密地址已复制' : '复制失败', httpsUrl);
    });
  });
}

function secureUrl(): string | null {
  const port = health?.httpsPort;
  if (!port) return null;
  return `https://${location.hostname}:${port}/`;
}

function openMenuSheet(): void {
  const body = openSheet(
    '连接与设备',
    `
      <div class="sheet-section">
        <div class="sheet-row"><span>接收端</span><b>${escapeHtml(receiverName())}</b></div>
        <div class="sheet-row"><span>这台设备</span><b>${escapeHtml(me?.device.name ?? '—')}</b></div>
        <div class="sheet-row"><span>页面地址</span><b>${escapeHtml(location.origin)}</b></div>
        <div class="sheet-row"><span>连接方式</span><b>${encrypted() ? 'HTTPS · 已加密' : 'HTTP · 仅局域网'}</b></div>
        <div class="sheet-row"><span>版本</span><b>${escapeHtml(appVersion() || '—')}</b></div>
      </div>
      <div class="sheet-actions">
        <button id="menu-secure" class="btn btn-ghost" type="button">${icon('shield')}${encrypted() ? '查看安全连接信息' : '开启 HTTPS 安全连接'}</button>
        <button id="menu-help" class="btn btn-ghost" type="button">连接与证书指南</button>
        <button id="menu-refresh" class="btn btn-ghost" type="button">刷新连接状态</button>
        <button id="menu-signout" class="btn btn-danger" type="button">断开这台设备</button>
      </div>
      <p class="sheet-note">断开后，这台手机会从电脑的已配对设备中移除，需要重新输入配对码才能连接。</p>
    `,
  );
  body.querySelector('#menu-secure')?.addEventListener('click', () => openSecureSheet());
  body.querySelector('#menu-help')?.addEventListener('click', () => openHelpSheet());
  body.querySelector('#menu-refresh')?.addEventListener('click', () => {
    closeSheet();
    void refreshStatus(true);
  });
  const signout = body.querySelector<HTMLButtonElement>('#menu-signout');
  signout?.addEventListener('click', () => {
    if (!signout) return;
    setButtonBusy(signout, true, '正在断开');
    void (async () => {
      try {
        live?.stop();
        endLiveUi();
        await signOut();
        location.reload();
      } catch (error) {
        setButtonBusy(signout, false, '');
        toast('error', '断开失败', errorText(error));
      }
    })();
  });
}

function openHelpSheet(): void {
  const body = openSheet(
    '连接与证书指南',
    `
      <p>大多数连接问题来自网络隔离、防火墙或浏览器权限。可以按下面的清单逐项检查。</p>
      <div class="sheet-section">
        <h3>连接自检</h3>
        <ul class="sheet-list">
          <li>手机与电脑连接同一个 Wi-Fi，并关闭路由器的「访客网络隔离」或「AP 隔离」。</li>
          <li>电脑端 EasyPush 正在运行；Windows 防火墙需允许专用网络访问 7333 与 7443 端口。</li>
          <li>二维码邀请 120 秒内有效，配对成功后电脑会自动刷新二维码。</li>
          <li>摄像头、麦克风与屏幕共享需要 HTTPS；HTTP 页面会被浏览器禁用这些能力。</li>
          <li>电脑 IP 地址变化后，请重新扫描电脑上的新二维码。</li>
        </ul>
      </div>
      <div class="sheet-actions">
        <button id="help-secure" class="btn btn-primary" type="button">${icon('shield')}开启 HTTPS 安全连接</button>
        <button id="help-refresh" class="btn btn-ghost" type="button">重新加载本页</button>
      </div>
      <p class="sheet-note">所有媒体与投屏画面只在局域网内传输。上传的文件保存在电脑本机，不会上传到互联网。</p>
    `,
  );
  body.querySelector('#help-secure')?.addEventListener('click', () => openSecureSheet());
  body.querySelector('#help-refresh')?.addEventListener('click', () => location.reload());
}

void boot();

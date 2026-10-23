import { formatBytes, formatDuration } from '../src/shared/format';

export type ToastKind = 'info' | 'success' | 'warn' | 'error';

export function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`缺少界面元素 #${id}`);
  return element as T;
}

export function icon(name: string, className = 'ic'): string {
  return `<svg class="${className}" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function formatSize(bytes: number | null): string {
  return bytes === null ? '—' : formatBytes(bytes);
}

export function formatElapsed(seconds: number): string {
  return formatDuration(seconds);
}

export function formatRate(kbps: number): string {
  if (!Number.isFinite(kbps) || kbps <= 0) return '—';
  if (kbps < 1000) return `${Math.round(kbps)} kbps`;
  return `${(kbps / 1000).toFixed(1)} Mbps`;
}

let toastSeq = 0;

export function toast(kind: ToastKind, title: string, message?: string): void {
  const root = $('toasts');
  const item = document.createElement('div');
  toastSeq += 1;
  item.className = `toast toast-${kind}`;
  item.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  const iconName = kind === 'success' ? 'check' : kind === 'info' ? 'cast' : 'alert';
  item.innerHTML =
    icon(iconName) +
    `<div class="toast-body"><strong>${escapeHtml(title)}</strong>` +
    (message ? `<span>${escapeHtml(message)}</span>` : '') +
    '</div>';
  root.appendChild(item);
  while (root.children.length > 4) root.firstElementChild?.remove();
  let removed = false;
  const dismiss = () => {
    if (removed) return;
    removed = true;
    item.classList.add('is-leaving');
    window.setTimeout(() => item.remove(), 220);
  };
  item.addEventListener('click', dismiss);
  window.setTimeout(dismiss, kind === 'error' ? 6500 : 4200);
  toastSeq = toastSeq % 1000;
}

export function platform(): 'ios' | 'android' | 'desktop' {
  if (/iPhone|iPad|iPod/i.test(navigator.userAgent)) return 'ios';
  if (/Android/i.test(navigator.userAgent)) return 'android';
  return 'desktop';
}

export function isSecure(): boolean {
  return window.isSecureContext;
}

export function canShareScreen(): boolean {
  return isSecure() && platform() === 'desktop' && typeof navigator.mediaDevices?.getDisplayMedia === 'function';
}

export function copyText(value: string): Promise<boolean> {
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(value).then(
      () => true,
      () => legacyCopy(value),
    );
  }
  return Promise.resolve(legacyCopy(value));
}

function legacyCopy(value: string): boolean {
  try {
    const area = document.createElement('textarea');
    area.value = value;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    area.setSelectionRange(0, value.length);
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

let lastFocus: HTMLElement | null = null;
let sheetOpen = false;

export function openSheet(title: string, html: string): HTMLElement {
  const sheet = $('sheet');
  const backdrop = $('sheet-backdrop');
  $('sheet-title').textContent = title;
  const body = $('sheet-body');
  body.innerHTML = html;
  lastFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  backdrop.hidden = false;
  sheet.hidden = false;
  document.body.classList.add('sheet-open');
  sheetOpen = true;
  sheet.scrollTop = 0;
  $('sheet-close').focus({ preventScroll: true });
  return body;
}

export function closeSheet(): void {
  if (!sheetOpen) return;
  sheetOpen = false;
  $('sheet').hidden = true;
  $('sheet-backdrop').hidden = true;
  $('sheet-body').innerHTML = '';
  document.body.classList.remove('sheet-open');
  if (lastFocus && document.contains(lastFocus)) lastFocus.focus({ preventScroll: true });
  lastFocus = null;
}

function focusables(): HTMLElement[] {
  const sheet = $('sheet');
  return [...sheet.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, summary, [tabindex]:not([tabindex="-1"])')].filter(
    (element) => !element.hasAttribute('disabled') && element.offsetParent !== null,
  );
}

export function initUi(): void {
  $('sheet-close').addEventListener('click', closeSheet);
  $('sheet-backdrop').addEventListener('click', closeSheet);
  document.addEventListener('keydown', (event) => {
    if (!sheetOpen) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      closeSheet();
      return;
    }
    if (event.key !== 'Tab') return;
    const menu = $('sheet');
    const items = focusables();
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (!first || !last) return;
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !menu.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  });
}

export function setButtonBusy(button: HTMLButtonElement, busy: boolean, busyLabel: string): void {
  if (busy) {
    if (!button.dataset.label) button.dataset.label = button.textContent ?? '';
    button.disabled = true;
    button.innerHTML = `<span class="spinner" aria-hidden="true"></span><span>${escapeHtml(busyLabel)}</span>`;
  } else {
    button.disabled = false;
    if (button.dataset.label) {
      button.textContent = button.dataset.label;
      delete button.dataset.label;
    }
  }
}

import type { ToastMessage } from '../shared/types';
import { Icon } from './Icons';

export function Toasts({ items, onDismiss }: { items: ToastMessage[]; onDismiss(id: string): void }) {
  if (items.length === 0) return null;
  return (
    <div className="toast-stack" role="status" aria-live="polite">
      {items.map((toast) => (
        <div key={toast.id} className={`toast toast-${toast.kind}`}>
          <span className="toast-icon">
            <Icon name={toast.kind === 'success' ? 'check' : toast.kind === 'error' || toast.kind === 'warn' ? 'warning' : 'wifi'} size={16} />
          </span>
          <div className="toast-body">
            <strong>{toast.title}</strong>
            {toast.message ? <p>{toast.message}</p> : null}
          </div>
          <button type="button" className="toast-close" onClick={() => onDismiss(toast.id)} aria-label="关闭提示">
            <Icon name="close" size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}

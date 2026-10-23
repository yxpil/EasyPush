import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import { Icon, Spinner } from './Icons';

export function LogsModal({ open, onClose }: { open: boolean; onClose(): void }) {
  const [lines, setLines] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const scroller = useRef<HTMLPreElement | null>(null);

  useEffect(() => {
    if (!open) return;
    let disposed = false;
    let timer = 0;
    const load = async () => {
      setLoading(true);
      try {
        const next = await api.getLogs();
        if (!disposed) setLines(next);
      } catch {
        // keep previous lines
      } finally {
        if (!disposed) setLoading(false);
      }
    };
    void load();
    timer = window.setInterval(() => void load(), 2500);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [open]);

  useEffect(() => {
    const node = scroller.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [lines]);

  if (!open) return null;

  const copy = async () => {
    const text = await api.copyDiagnostics();
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
    void text;
  };

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-labelledby="logs-title">
      <div className="modal logs-modal">
        <header className="modal-head">
          <div>
            <p className="eyebrow">Diagnostics</p>
            <h2 id="logs-title">运行日志</h2>
          </div>
          <div className="logs-actions">
            {loading ? <Spinner size={15} /> : null}
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => void copy()}>
              <Icon name={copied ? 'check' : 'copy'} size={14} /> {copied ? '已复制' : '复制诊断'}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => api.openLogs()}>
              <Icon name="folder" size={14} /> 打开目录
            </button>
            <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭日志">
              <Icon name="close" size={16} />
            </button>
          </div>
        </header>
        <pre className="log-scroller" ref={scroller}>
          {lines.length > 0 ? lines.join('\n') : '暂无日志。新的连接、投屏与媒体事件会实时写入这里。'}
        </pre>
        <footer className="modal-foot">
          <span className="modal-foot-hint">最近 400 条 · 每 2.5 秒刷新 · 敏感字段已脱敏</span>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            关闭
          </button>
        </footer>
      </div>
    </div>
  );
}

import React from 'react';
import { useToasts } from './toast';

export function Toasts() {
  const toasts = useToasts((s) => s.toasts);
  const dismiss = useToasts((s) => s.dismiss);
  return (
    <div className="toast-viewport" role="status" aria-live="polite">
      {toasts.map((t) => (
        <button key={t.id} className="toast glass" onClick={() => dismiss(t.id)} aria-label={t.message}>
          {t.kind === 'success' ? '✓ ' : t.kind === 'warn' ? '⚠︎ ' : t.kind === 'error' ? '✕ ' : 'ℹ '}
          {t.message}
        </button>
      ))}
    </div>
  );
}

export function Skeleton({ style, count = 1 }: { style?: React.CSSProperties; count?: number }) {
  return (
    <>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="skeleton" style={{ height: 64, ...style }} aria-hidden />
      ))}
    </>
  );
}

export function EmptyState({ icon, title, body, actions }: { icon: string; title: string; body: string; actions?: React.ReactNode }) {
  return (
    <div className="card" style={{ padding: 40, textAlign: 'center', maxWidth: 520, margin: '40px auto' }}>
      <div style={{ fontSize: 44 }} aria-hidden>{icon}</div>
      <h2 style={{ margin: '12px 0 6px' }}>{title}</h2>
      <p style={{ color: 'var(--text-2)', margin: '0 0 18px' }}>{body}</p>
      <div style={{ display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>{actions}</div>
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="card" style={{ padding: 32, textAlign: 'center', maxWidth: 520, margin: '40px auto' }} role="alert">
      <div style={{ fontSize: 36 }} aria-hidden>⚠︎</div>
      <p style={{ margin: '12px 0 16px' }}>{message}</p>
      {onRetry && <button className="btn btn-primary" onClick={onRetry}>Retry</button>}
    </div>
  );
}

export function SectionTitle({ title, sub, right }: { title: string; sub?: string; right?: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'end', justifyContent: 'space-between', gap: 12 }}>
      <div>
        <h2 className="section-title" style={{ marginBottom: sub ? 2 : 12 }}>{title}</h2>
        {sub && <p className="section-sub">{sub}</p>}
      </div>
      {right}
    </div>
  );
}

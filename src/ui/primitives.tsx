import React from 'react';
import { Icon, Glyph } from './icons';
import { useToasts } from './toast';

export function Toasts() {
  const toasts = useToasts((s) => s.toasts);
  const dismiss = useToasts((s) => s.dismiss);
  return (
    <div className="toast-viewport" role="status" aria-live="polite">
      {toasts.map((t) => (
        <button key={t.id} className={`toast toast-${t.kind} glass`} onClick={() => dismiss(t.id)} aria-label={t.message}>
          <Icon name={t.kind === 'success' ? 'check' : t.kind === 'warn' ? 'warn' : t.kind === 'error' ? 'close' : 'info'} size={13} />{' '}
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
      <div style={{ color: 'var(--text-2)' }} aria-hidden><Glyph char={icon} size={44} /></div>
      <h2 style={{ margin: '12px 0 6px' }}>{title}</h2>
      <p style={{ color: 'var(--text-2)', margin: '0 0 18px' }}>{body}</p>
      <div style={{ display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>{actions}</div>
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="card" style={{ padding: 32, textAlign: 'center', maxWidth: 520, margin: '40px auto' }} role="alert">
      <div style={{ color: 'var(--text-2)' }} aria-hidden><Icon name="warn" size={36} /></div>
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

export interface KnoxSelectOption<T extends string = string> {
  value: T;
  label: string;
}

export function KnoxSelect<T extends string = string>({
  value,
  options,
  onChange,
  ariaLabel,
  style,
  className = '',
}: {
  value: T;
  options: KnoxSelectOption<T>[];
  onChange: (value: T) => void;
  ariaLabel?: string;
  style?: React.CSSProperties;
  className?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const current = options.find((o) => o.value === value) ?? options[0];

  React.useEffect(() => {
    if (!open) return;
    const onDocDown = (e: MouseEvent | TouchEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocDown);
    document.addEventListener('touchstart', onDocDown, { passive: true });
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocDown);
      document.removeEventListener('touchstart', onDocDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div
      ref={rootRef}
      className={`knox-select-wrap ${open ? 'is-open' : ''} ${className}`.trim()}
      style={style}
      data-no-swipe="true"
    >
      <button
        type="button"
        className="knox-select-trigger"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="knox-select-label">{current?.label ?? String(value)}</span>
        <span className={`knox-select-caret ${open ? 'is-open' : ''}`} aria-hidden>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </span>
      </button>
      {open && (
        <div className="knox-select-menu" role="listbox" aria-label={ariaLabel}>
          {options.map((opt) => {
            const selected = opt.value === value;
            return (
              <button
                key={opt.value}
                type="button"
                role="option"
                aria-selected={selected}
                className={`knox-select-option ${selected ? 'is-selected' : ''}`}
                onClick={() => {
                  onChange(opt.value);
                  setOpen(false);
                }}
              >
                <span className="knox-select-option-text">{opt.label}</span>
                {selected && <Icon name="check" size={13} />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}


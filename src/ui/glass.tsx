// KNOX liquid-glass primitives — the ONLY place glass CSS classnames are
// composed. Feature components must use these instead of duplicating glass
// styles. Each keeps native semantics (button/input/select) for keyboard and
// screen-reader accessibility.

import React from 'react';

type DivProps = React.HTMLAttributes<HTMLDivElement>;

export function GlassPanel({ className = '', ...rest }: DivProps) {
  return <div className={`card ${className}`} {...rest} />;
}

export function GlassCard({ className = '', style, ...rest }: DivProps & { style?: React.CSSProperties }) {
  return <div className={`card ${className}`} style={{ padding: 18, ...style }} {...rest} />;
}

interface GlassButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'primary';
}

export function GlassButton({ variant = 'default', className = '', type = 'button', ...rest }: GlassButtonProps) {
  return (
    <button
      type={type}
      className={`btn${variant === 'primary' ? ' btn-primary' : ''} ${className}`}
      {...rest}
    />
  );
}

export function GlassIconButton({ className = '', type = 'button', ...rest }: GlassButtonProps) {
  return <button type={type} className={`icon-btn ${className}`} {...rest} />;
}

interface GlassInputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
}

export function GlassInput({ label, id, className = '', ...rest }: GlassInputProps) {
  const input = <input id={id} className={`text-input ${className}`} {...rest} />;
  if (!label) return input;
  return (
    <label className="lbl" htmlFor={id}>
      {label}
      <span style={{ display: 'block', marginTop: 6 }}>{input}</span>
    </label>
  );
}

interface GlassDropdownProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  options: { value: string; label: string }[];
}

/** Glass-styled native select — keeps keyboard/screen-reader semantics. */
export function GlassDropdown({ label, id, options, className = '', ...rest }: GlassDropdownProps) {
  const select = (
    <select id={id} className={className} {...rest}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
  if (!label) return select;
  return (
    <label className="lbl" htmlFor={id}>
      {label}
      <span style={{ display: 'block', marginTop: 6 }}>{select}</span>
    </label>
  );
}

interface GlassTabsProps<T extends string> {
  options: { id: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  label: string;
}

export function GlassTabs<T extends string>({ options, value, onChange, label }: GlassTabsProps<T>) {
  return (
    <div className="chips" role="tablist" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.id}
          role="tab"
          aria-selected={value === o.id}
          className={`chip${value === o.id ? ' active' : ''}`}
          onClick={() => onChange(o.id)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

interface GlassModalProps {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}

/** Centered glass dialog with backdrop. Keeps role=dialog + escape to close. */
export function GlassModal({ title, onClose, children }: GlassModalProps) {
  React.useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onClose]);
  return (
    <div className="now-playing" role="dialog" aria-label={title} onClick={onClose}>
      <div className="now-playing-card" style={{ textAlign: 'left' }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <strong>{title}</strong>
          <button className="icon-btn" onClick={onClose} aria-label={`Close ${title}`}>
            ✕
          </button>
        </div>
        <div style={{ marginTop: 12 }}>{children}</div>
      </div>
    </div>
  );
}

/** Subtle info/tooltip text with an accessible label. */
export function GlassTooltip({ text, label }: { text: string; label?: string }) {
  return (
    <span style={{ fontSize: 12, color: 'var(--text-2)' }} title={text} aria-label={label ?? text}>
      {text}
    </span>
  );
}

/** Compact glass status banner (provider failures, hints). Not an error box. */
export function StatusBanner({
  children,
  tone = 'info',
  onRetry,
}: {
  children: React.ReactNode;
  tone?: 'info' | 'warn';
  onRetry?: () => void;
}) {
  return (
    <div
      className={tone === 'warn' ? 'provider-banner' : 'card'}
      role="status"
      style={tone === 'info' ? { padding: '10px 16px', fontSize: 13 } : undefined}
    >
      <span style={{ flex: 1, minWidth: 0 }}>{children}</span>
      {onRetry && (
        <button className="btn" style={{ padding: '6px 14px', fontSize: 12.5 }} onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

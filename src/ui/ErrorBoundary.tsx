import React from 'react';
import { logger } from '../core/logger';

interface Props {
  children: React.ReactNode;
  /** Label used in logs so the failing area is identifiable. */
  area?: string;
  /** Optional custom fallback (defaults to the KNOX rendering-error card). */
  fallback?: React.ReactNode;
}

interface State {
  error: Error | null;
  componentStack: string | null;
}

/**
 * Production-safe React error boundary.
 *
 * A render exception must NEVER blank the entire WebView again (the black-
 * screen incident was an uncaught Rules-of-Hooks crash with no boundary, so
 * React unmounted the whole root while audio kept playing). Boundaries
 * isolate the failure to the affected area, keep navigation/audio alive, and
 * log the component stack + message + stack trace for diagnosis.
 */
export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null, componentStack: null };

  static getDerivedStateFromError(error: Error): State {
    return { error, componentStack: null };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    this.setState({ componentStack: info.componentStack ?? null });
    try {
      logger.error(
        'ui',
        `rendering error in ${this.props.area ?? 'app'}: ${error.message}`,
        `${error.stack ?? String(error)}\nComponent stack:${info.componentStack ?? ' (unavailable)'}`,
      );
    } catch {
      /* logging must never throw */
    }
    if (typeof console !== 'undefined' && typeof console.error === 'function') {
      console.error(`[KNOX DEBUG] Rendering error in ${this.props.area ?? 'app'}:`, error, info.componentStack);
    }
  }

  private handleRetry = (): void => {
    this.setState({ error: null, componentStack: null });
  };

  render(): React.ReactNode {
    if (!this.state.error) return this.props.children;
    if (this.props.fallback) return this.props.fallback;
    return (
      <div
        role="alert"
        className="card"
        style={{ padding: '18px 20px', margin: '16px auto', maxWidth: 560, textAlign: 'left' }}
      >
        <div style={{ fontSize: 15, fontWeight: 800, marginBottom: 6 }}>
          KNOX Music encountered a rendering error
        </div>
        <div style={{ fontSize: 13, color: 'var(--text-2)', marginBottom: 8 }}>
          The rest of the app (including playback) keeps running. You can retry
          this view{this.props.area ? ` (${this.props.area})` : ''} or navigate elsewhere.
        </div>
        <details style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 12, whiteSpace: 'pre-wrap' }}>
          <summary style={{ cursor: 'pointer' }}>Error details</summary>
          <div style={{ marginTop: 6 }}>{this.state.error.message}</div>
          {this.state.componentStack && (
            <div style={{ marginTop: 6, maxHeight: 160, overflow: 'auto' }}>{this.state.componentStack}</div>
          )}
        </details>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-primary" onClick={this.handleRetry}>
            Retry this view
          </button>
        </div>
      </div>
    );
  }
}

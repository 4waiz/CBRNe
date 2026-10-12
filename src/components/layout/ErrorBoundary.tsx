import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallback?: (error: Error, reset: () => void) => ReactNode;
  label?: string;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[BRIDGE] ${this.props.label ?? 'component'} failed`, error, info.componentStack);
  }

  reset = () => this.setState({ error: null });

  render() {
    if (this.state.error) {
      if (this.props.fallback) return this.props.fallback(this.state.error, this.reset);
      return (
        <div className="flex h-full w-full items-center justify-center p-6">
          <div className="max-w-[360px] rounded-[8px] border border-line-strong bg-surface-1 p-4 text-center">
            <div className="font-cond text-[12px] font-semibold uppercase tracking-[0.1em] text-amber">{this.props.label ?? 'View'} unavailable</div>
            <p className="mt-1.5 text-[11.5px] text-ink-2">{this.state.error.message}</p>
            <button type="button" className="ctl mt-3" onClick={this.reset}>
              Retry
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

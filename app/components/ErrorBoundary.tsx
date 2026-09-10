"use client";

import { Component, type ErrorInfo, type ReactNode } from "react";
import { describeError } from "../lib/clientError";
import { reportClientError } from "./ClientErrorBeacon";

type ErrorBoundaryState = { error: unknown | null };

export class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    reportClientError(error);
    console.error("iTrack render error", error, info.componentStack);
  }

  render() {
    if (this.state.error === null) return this.props.children;
    return <ErrorFallback error={this.state.error} />;
  }
}

export function ErrorFallback({ error, onReset }: { error: unknown; onReset?: () => void }) {
  const details = describeError(error);
  const copyDetails = () => {
    const text = `${details.message}\n${details.stack}\n${window.location.href}\n${new Date().toISOString()}`;
    void window.navigator.clipboard?.writeText(text).catch(() => {});
  };
  return (
    <section className="error-fallback" role="alert">
      <h1>Something broke on our side</h1>
      <p>Your data is safe on the server. Reload to pick up where you left off.</p>
      <div className="error-fallback-actions">
        <button className="button button-primary" type="button" onClick={() => window.location.reload()}>
          Reload
        </button>
        <button className="button button-outline" type="button" onClick={copyDetails}>
          Copy details
        </button>
        {onReset ? (
          <button className="button button-outline" type="button" onClick={onReset}>
            Try again
          </button>
        ) : null}
      </div>
    </section>
  );
}

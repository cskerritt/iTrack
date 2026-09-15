"use client";

import { Component, type ErrorInfo, type ReactNode } from "react";
import { describeError } from "../lib/clientError";
import { Button } from "./Button";
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
        <Button variant="primary" onClick={() => window.location.reload()}>
          Reload
        </Button>
        <Button variant="secondary" onClick={copyDetails}>
          Copy details
        </Button>
        {onReset ? (
          <Button variant="secondary" onClick={onReset}>
            Try again
          </Button>
        ) : null}
      </div>
    </section>
  );
}

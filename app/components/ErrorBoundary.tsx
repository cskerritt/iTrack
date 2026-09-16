"use client";

import { Component, type ErrorInfo, type ReactNode } from "react";
import { describeError } from "../lib/clientError";
import { reportClientError } from "./ClientErrorBeacon";
import { Button } from "./Button";

type ErrorBoundaryState = { error: unknown | null };
type ErrorBoundaryProps = {
  children: ReactNode;
  // Changing the key (the shell passes the current path) clears a caught
  // error, so a crashed screen recovers on the next navigation.
  resetKey?: string;
  fallback?: (error: unknown, reset: () => void) => ReactNode;
};

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    reportClientError(error);
    console.error("iTrack render error", error, info.componentStack);
  }

  componentDidUpdate(previous: ErrorBoundaryProps) {
    if (this.state.error !== null && previous.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  reset = () => this.setState({ error: null });

  render() {
    if (this.state.error === null) return this.props.children;
    if (this.props.fallback) return this.props.fallback(this.state.error, this.reset);
    return <ErrorFallback error={this.state.error} onReset={this.reset} />;
  }
}

// The crash surface for the boundary, app/error.tsx and the styleguide
// sample. The raw message is rendered only inside the disclosure; the
// visible copy stays the two sentences Wave 1 shipped.
export function ErrorFallback({
  error,
  onReset,
  title = "Something broke on our side",
  body = "Your data is safe on the server. Reload to pick up where you left off.",
}: {
  error: unknown;
  onReset?: () => void;
  title?: string;
  body?: string;
}) {
  const details = describeError(error);
  const copyDetails = () => {
    const text = `${details.message}\n${details.stack}\n${window.location.href}\n${new Date().toISOString()}`;
    void window.navigator.clipboard?.writeText(text).catch(() => {});
  };
  return (
    <section className="error-fallback" role="alert">
      <h1 className="page-title">{title}</h1>
      <p>{body}</p>
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
      <details className="error-fallback-details">
        <summary>Technical details</summary>
        <pre>{details.message}</pre>
      </details>
    </section>
  );
}

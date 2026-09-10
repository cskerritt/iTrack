"use client";

import { useEffect } from "react";
import { reportClientError } from "./components/ClientErrorBeacon";
import { ErrorFallback } from "./components/ErrorBoundary";

export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    reportClientError(error);
  }, [error]);
  return <ErrorFallback error={error} onReset={reset} />;
}

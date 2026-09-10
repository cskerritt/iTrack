"use client";

import { useEffect } from "react";
import {
  CLIENT_ERROR_ENDPOINT,
  ClientErrorThrottle,
  buildClientErrorReport,
} from "../lib/clientError";

const throttle = new ClientErrorThrottle();

export function reportClientError(input: unknown): void {
  if (typeof window === "undefined") return;
  if (!throttle.allow(Date.now())) return;
  const report = buildClientErrorReport(input, {
    route: `${window.location.pathname}${window.location.search}`,
    userAgent: window.navigator.userAgent,
    at: new Date().toISOString(),
  });
  try {
    void fetch(CLIENT_ERROR_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(report),
      keepalive: true,
    }).catch(() => {});
  } catch {
    // A beacon must never throw into the page it is reporting on.
  }
}

// Mounted once in the root layout: turns window-level errors and
// unhandled rejections into one POST each (throttled).
export function ClientErrorBeacon() {
  useEffect(() => {
    const onError = (event: ErrorEvent) => reportClientError(event.error ?? event.message);
    const onRejection = (event: PromiseRejectionEvent) => reportClientError(event.reason);
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);
  return null;
}

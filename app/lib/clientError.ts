// Pure helpers for the client error beacon: no window access here so the
// module compiles and tests under plain node.
export const CLIENT_ERROR_ENDPOINT = "/api/client-error";
export const STACK_LIMIT = 2048;
const MESSAGE_LIMIT = 500;

export type ClientErrorReport = {
  message: string;
  stack: string;
  route: string;
  userAgent: string;
  at: string;
};

export function describeError(input: unknown): { message: string; stack: string } {
  if (input instanceof Error) {
    return { message: input.message || input.name || "Unknown error", stack: input.stack ?? "" };
  }
  if (typeof input === "string" && input.length > 0) return { message: input, stack: "" };
  return { message: "Unknown error", stack: "" };
}

export function buildClientErrorReport(
  input: unknown,
  context: { route: string; userAgent: string; at: string },
): ClientErrorReport {
  const { message, stack } = describeError(input);
  return {
    message: message.slice(0, MESSAGE_LIMIT),
    stack: stack.slice(0, STACK_LIMIT),
    route: context.route.slice(0, 200),
    userAgent: context.userAgent.slice(0, 300),
    at: context.at,
  };
}

// Mirrors the gateway's 10/min per-session limit so a render loop cannot
// flood the network from the client side either.
export class ClientErrorThrottle {
  private readonly limit: number;
  private readonly windowMs: number;
  private windowStart = 0;
  private count = 0;

  constructor(limit = 10, windowMs = 60_000) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  allow(nowMs: number): boolean {
    if (nowMs - this.windowStart >= this.windowMs) {
      this.windowStart = nowMs;
      this.count = 0;
    }
    this.count += 1;
    return this.count <= this.limit;
  }
}

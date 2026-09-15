/**
 * The pure half of the Toast primitive (spec §5.2 "persistent aria-live region
 * mounted once"; audit a11y-08). One visible slot, a queue behind it, and a
 * pause flag:
 *
 * - `show` REPLACES the current toast when that toast carries no action. That
 *   is the single-slot behaviour the app relies on today: four flows post
 *   runAction's plain success message and immediately overwrite it with an
 *   Undo toast, and the log sheet posts "N credits added…" then "N credits
 *   and proof saved." A first-in-first-out queue would show the stale message
 *   for six seconds.
 * - `show` QUEUES behind a toast that carries an action: an Undo on screen is
 *   never yanked away.
 * - `expire` is ignored while paused (hovered or focused) or for a stale id;
 *   `dismiss` works on the current toast or on a queued one.
 * - Whenever a different toast becomes current, `paused` resets. The pause
 *   belongs to the card the pointer or focus was on, and a removed element
 *   fires no blur or pointerleave for the provider to hear.
 *
 * Ids are assigned by the caller (`ToastProvider` owns the counter) so the
 * reducer stays a pure function of (state, event) for
 * tests/toast-queue.test.mjs. Dependency-free and DOM-free: `npm run
 * build:lib-test` compiles it standalone.
 */
export type ToastTone = "info" | "success" | "error";
export type ToastAction = { label: string; onClick: () => void };
export type ToastInput = {
  message: string;
  tone?: ToastTone;
  duration?: number;
  action?: ToastAction;
};
export type ToastItem = {
  id: number;
  message: string;
  tone: ToastTone;
  duration: number;
  action: ToastAction | null;
};
export type ToastQueueState = {
  current: ToastItem | null;
  pending: ToastItem[];
  paused: boolean;
};
export type ToastEvent =
  | { type: "show"; item: ToastItem }
  | { type: "dismiss"; id: number }
  | { type: "expire"; id: number }
  | { type: "pause" }
  | { type: "resume" };

/** A plain confirmation: long enough to read, short enough not to linger. */
export const TOAST_DURATION = 6000;
/** A toast with an action (Undo): the longer window a11y-08 asks for (WCAG 2.2.1). */
export const TOAST_ACTION_DURATION = 10000;

export const INITIAL_TOAST_STATE: ToastQueueState = {
  current: null,
  pending: [],
  paused: false,
};

/** An explicit `duration` wins (0 = sticky); otherwise 10 s with an action, 6 s without. */
export function durationFor(input: ToastInput): number {
  return input.duration ?? (input.action ? TOAST_ACTION_DURATION : TOAST_DURATION);
}

export function toToastItem(input: ToastInput, id: number): ToastItem {
  return {
    id,
    message: input.message,
    tone: input.tone ?? "info",
    duration: durationFor(input),
    action: input.action ?? null,
  };
}

/** Errors go to the assertive slot (role="alert"); everything else is polite. */
export function isAssertive(item: ToastItem): boolean {
  return item.tone === "error";
}

function promote(state: ToastQueueState): ToastQueueState {
  const [next, ...rest] = state.pending;
  return { current: next ?? null, pending: rest, paused: false };
}

export function toastReducer(state: ToastQueueState, event: ToastEvent): ToastQueueState {
  switch (event.type) {
    case "show":
      // A plain confirmation may be overwritten (today's single slot); an
      // actionable one — an Undo on screen — is never yanked away.
      if (state.current === null || state.current.action === null) {
        return { ...state, current: event.item, paused: false };
      }
      return { ...state, pending: [...state.pending, event.item] };
    case "expire":
      if (state.paused || state.current === null || state.current.id !== event.id) return state;
      return promote(state);
    case "dismiss":
      if (state.current !== null && state.current.id === event.id) return promote(state);
      return { ...state, pending: state.pending.filter((item) => item.id !== event.id) };
    case "pause":
      return state.paused ? state : { ...state, paused: true };
    case "resume":
      return state.paused ? { ...state, paused: false } : state;
  }
}

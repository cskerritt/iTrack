"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from "react";
import {
  INITIAL_TOAST_STATE,
  isAssertive,
  toToastItem,
  toastReducer,
  type ToastInput,
  type ToastItem,
} from "../lib/toastQueue";
import { Icon } from "./Icon";

// The Toast primitive (spec §5.2): ONE live region, mounted by app/layout.tsx
// from first paint and never unmounted, outside every `[data-app-root]` so a
// dialog's inert can never cover it (a11y-08 — the old status div was a
// sibling of the modal backdrops and went inert with the rest of the shell,
// so confirmations posted while a sheet was open were never announced). Two
// slots: a polite `role="status"` for confirmations and an assertive
// `role="alert"` for `tone: "error"`. The queue rules live in
// app/lib/toastQueue.ts; this file owns ids, the timer and the DOM. Focus
// never moves into a toast and Escape is not handled here (the Modal owns
// Escape); there is no enter or leave animation — a toast is not one of the
// three motion moments.

export type ToastApi = {
  show(input: ToastInput): number;
  dismiss(id: number): void;
};

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error("useToast() needs a ToastProvider");
  return api;
}

function ToastCard({
  item,
  onDismiss,
  onPause,
  onResume,
}: {
  item: ToastItem;
  onDismiss: () => void;
  onPause: () => void;
  onResume: () => void;
}) {
  // React's onFocus/onBlur are focusin/focusout, so focusing the Undo or
  // Dismiss button pauses the timer exactly like hovering the card does.
  return (
    <div
      className="toast"
      data-tone={item.tone}
      onPointerEnter={onPause}
      onPointerLeave={onResume}
      onFocus={onPause}
      onBlur={onResume}
    >
      <p className="toast-message">{item.message}</p>
      {item.action ? (
        <button
          type="button"
          className="toast-action"
          onClick={() => {
            item.action?.onClick();
            onDismiss();
          }}
        >
          {item.action.label}
        </button>
      ) : null}
      <button
        type="button"
        className="toast-close"
        aria-label="Dismiss notification"
        onClick={onDismiss}
      >
        <Icon name="close" size={16} />
      </button>
    </div>
  );
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(toastReducer, INITIAL_TOAST_STATE);
  // Ids live here, not in the reducer, so the reducer stays pure.
  const nextId = useRef(1);
  // Timer bookkeeping for the pause: how much of the current toast's
  // duration is left, when the running stretch started, and which toast it
  // belongs to. Written only inside the effect below, its cleanup and the
  // event handlers — never during render (react-hooks/refs).
  const remaining = useRef(0);
  const startedAt = useRef(0);
  const trackedId = useRef<number | null>(null);

  const api = useMemo<ToastApi>(
    () => ({
      show(input) {
        const id = nextId.current;
        nextId.current += 1;
        dispatch({ type: "show", item: toToastItem(input, id) });
        return id;
      },
      dismiss(id) {
        dispatch({ type: "dismiss", id });
      },
    }),
    [],
  );

  // Destructured once: the reducer's slot is named `current`, which
  // react-hooks/exhaustive-deps would otherwise read as a ref's mutable field
  // and refuse as a dependency. `item` and `paused` are plain values.
  const { current: item, paused } = state;

  useEffect(() => {
    if (item === null) {
      trackedId.current = null;
      return;
    }
    if (trackedId.current !== item.id) {
      trackedId.current = item.id;
      remaining.current = item.duration;
    }
    // Sticky (duration 0) or held by hover/focus: nothing is armed.
    if (item.duration === 0 || paused) return;
    startedAt.current = Date.now();
    const timeout = window.setTimeout(
      () => dispatch({ type: "expire", id: item.id }),
      remaining.current,
    );
    return () => {
      window.clearTimeout(timeout);
      remaining.current = Math.max(
        0,
        remaining.current - (Date.now() - startedAt.current),
      );
    };
  }, [item, paused]);

  // Keyed by id: a new toast is a fresh DOM node, so a pointer already over
  // the region gets a new pointerenter and aria-atomic announces the whole
  // card.
  const card = item ? (
    <ToastCard
      key={item.id}
      item={item}
      onDismiss={() => api.dismiss(item.id)}
      onPause={() => dispatch({ type: "pause" })}
      onResume={() => dispatch({ type: "resume" })}
    />
  ) : null;

  return (
    <ToastContext value={api}>
      {children}
      <div className="toast-region">
        <div className="toast-slot" role="status" aria-live="polite" aria-atomic="true">
          {item && !isAssertive(item) ? card : null}
        </div>
        <div className="toast-slot" role="alert" aria-atomic="true">
          {item && isAssertive(item) ? card : null}
        </div>
      </div>
    </ToastContext>
  );
}

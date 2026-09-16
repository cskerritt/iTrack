"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { createModalStack } from "../lib/modalStack";
import { Icon } from "./Icon";
import { usePublishedHeight } from "./usePublishedHeight";

// The one dialog shell (spec §5.2 Modal; Sheet is its presentation below
// 540px, CSS only — see the MODAL / SHEET section of app/styles/primitives.css).
//
// What it owns, and why it is not left to the caller:
// - The opener. React implements `autoFocus` by calling .focus() in the
//   commit phase, before any effect runs, so an effect that reads
//   document.activeElement records the field React just focused — the old
//   Modal did exactly that and 18/18 focus-return cases ended on <body>
//   (a11y-02). The opener is read in a lazy useState initializer instead: it
//   runs during the first render, before any child commits.
// - Inertness. Every element carrying `data-app-root` (the app shell, the
//   styleguide root) and every lower dialog's backdrop is inert while a dialog
//   is up; nothing else is. The toast region is mounted outside every app
//   root, so it keeps announcing (a11y-08). The old Modal inerted "every
//   sibling of the backdrop", which silenced the toast and stops being
//   correct at all once a screen renders its own dialog.
// - Escape (a11y-07, architecture-10). One document listener per dialog; only
//   the top-most one acts, and never when something inside already consumed
//   the key (a native date or select popup) or an IME is composing.
// - The backdrop (app-ux-23). A press that both starts and ends on the
//   backdrop closes a clean form; a dirty one stays. Dirtiness is a FormData
//   snapshot of the dialog's first <form>, taken after mount, unless the
//   owner hands in `isDirty`.
// - The header's clearance (WCAG 2.2 2.4.11). The header is sticky inside the
//   card, and the card is what scrolls, so the card's scroll-padding-top
//   (primitives.css) has to clear the header's rendered height; that height
//   is published on the card as --modal-header-height.
// - Its accessible name: aria-labelledby points at a useId()-based id, one per
//   instance (architecture-14).
// Nothing here holds "closing" state: `onClose` may refuse (the log sheet
// stays open when its draft cannot be persisted) and the dialog simply stays.

export type ModalProps = {
  title: string;
  eyebrow?: string;
  onClose: () => void;
  children: ReactNode;
  size?: "md" | "lg";
  // Backdrop-press guard only; absent = the dialog's first <form> is compared
  // against a FormData snapshot taken when it opened.
  isDirty?: () => boolean;
  closeLabel?: string;
};

const stack = createModalStack<HTMLElement>();
// Body scroll is locked while any dialog is open; the value it had before the
// first one opened is what the last one restores.
let priorBodyOverflow = "";
// An opener whose own dialog was still up when its dialog closed — a parent
// that closed both at once — waits here for the last cleanup, which is the
// first moment it can take focus again.
let deferredFocus: HTMLElement | null = null;

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

const appRoots = () =>
  Array.from(document.querySelectorAll<HTMLElement>("[data-app-root]"));

// FormData reads live values, so this works the same for controlled and
// uncontrolled forms; a file input contributes its file name.
function serializeForm(form: HTMLFormElement): string {
  return JSON.stringify(
    Array.from(new FormData(form).entries()).map(([name, value]) => [
      name,
      typeof value === "string" ? value : value.name,
    ]),
  );
}

export function Modal({
  title,
  eyebrow,
  onClose,
  children,
  size = "md",
  isDirty,
  closeLabel = "Close dialog",
}: ModalProps) {
  const id = useId();
  const titleId = `${id}-title`;
  const backdropRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const headerRef = useRef<HTMLElement>(null);
  const pressTarget = useRef<EventTarget | null>(null);
  const snapshot = useRef<string | null>(null);
  const onCloseRef = useRef(onClose);
  const isDirtyRef = useRef(isDirty);
  // Captured in the first render, before any child's autoFocus commits, so it
  // is the control that opened the dialog and not the field React focused.
  const [opener] = useState<HTMLElement | null>(() =>
    typeof document !== "undefined" &&
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  );

  // A field reached by Shift+Tab, or an error summary scrolled into view,
  // must never land behind the sticky header: the card's scroll padding reads
  // the height published here.
  usePublishedHeight(headerRef, "--modal-header-height", dialogRef);

  // Read through refs so the mount effect attaches its listeners once and
  // still calls the owner's latest closure (the pattern the old drag hook
  // used; react-hooks/refs forbids writing a ref during render).
  useEffect(() => {
    onCloseRef.current = onClose;
    isDirtyRef.current = isDirty;
  });

  useEffect(() => {
    const backdrop = backdropRef.current;
    const dialog = dialogRef.current;
    if (!backdrop || !dialog) return;

    if (stack.size() === 0) {
      priorBodyOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
    }
    stack.open(id, backdrop);
    stack.sync(appRoots());

    // React's autoFocus has already run; only take focus when it did not.
    if (!dialog.contains(document.activeElement)) {
      (
        dialog.querySelector<HTMLElement>("[data-autofocus],[autofocus]") ??
        dialog
      ).focus({ preventScroll: true });
    }
    const form = dialog.querySelector("form");
    snapshot.current = form ? serializeForm(form) : null;

    const focusable = () =>
      Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (element) =>
          !element.hasAttribute("hidden") &&
          element.getAttribute("aria-hidden") !== "true",
      );
    const keepFocusInside = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const focusableElements = focusable();
      if (focusableElements.length === 0) {
        event.preventDefault();
        dialog.focus({ preventScroll: true });
        return;
      }
      const first = focusableElements[0];
      const last = focusableElements[focusableElements.length - 1];
      const activeElement =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;

      if (
        event.shiftKey &&
        (activeElement === first ||
          activeElement === dialog ||
          !activeElement ||
          !dialog.contains(activeElement))
      ) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (activeElement === last ||
          activeElement === dialog ||
          !activeElement ||
          !dialog.contains(activeElement))
      ) {
        event.preventDefault();
        first.focus();
      }
    };
    // On the document, not the dialog: it must work when focus fell to <body>
    // after a backdrop press or a control that unmounted.
    const onEscape = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        event.defaultPrevented ||
        event.isComposing
      ) {
        return;
      }
      if (!stack.isTop(id)) return;
      event.preventDefault();
      onCloseRef.current();
    };

    dialog.addEventListener("keydown", keepFocusInside);
    document.addEventListener("keydown", onEscape);
    return () => {
      dialog.removeEventListener("keydown", keepFocusInside);
      document.removeEventListener("keydown", onEscape);
      stack.close(id);
      stack.sync(appRoots());
      if (stack.size() === 0) document.body.style.overflow = priorBodyOverflow;
      // Un-inerted first, then focused: a lower dialog's control can take
      // focus again only once its backdrop is no longer inert.
      const target = opener?.isConnected ? opener : null;
      if (target && target.closest("[inert]") === null) {
        target.focus({ preventScroll: true });
      } else if (target) {
        deferredFocus = target;
      }
      if (stack.size() === 0 && deferredFocus) {
        if (deferredFocus.isConnected) {
          deferredFocus.focus({ preventScroll: true });
        }
        deferredFocus = null;
      }
    };
  }, [id, opener]);

  const dirty = () => {
    if (isDirtyRef.current) return isDirtyRef.current();
    const form = dialogRef.current?.querySelector("form");
    return Boolean(
      form &&
        snapshot.current !== null &&
        serializeForm(form) !== snapshot.current,
    );
  };
  const onBackdropPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    pressTarget.current = event.target;
  };
  // Both the press and the release have to land on the backdrop itself: a
  // selection dragged out of the card, or a click that bubbles up from inside
  // it (a nested dialog is a React child of this one), never dismisses.
  const onBackdropClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (
      event.target !== event.currentTarget ||
      pressTarget.current !== event.currentTarget
    ) {
      return;
    }
    if (dirty()) return;
    onClose();
  };

  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      className="modal-backdrop"
      ref={backdropRef}
      onPointerDown={onBackdropPointerDown}
      onClick={onBackdropClick}
    >
      <section
        className="modal-card"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        data-size={size}
      >
        <header ref={headerRef} className="modal-header">
          <div>
            {eyebrow ? <span className="modal-eyebrow">{eyebrow}</span> : null}
            <h2 id={titleId} className="modal-title">
              {title}
            </h2>
          </div>
          <button
            className="modal-close"
            type="button"
            aria-label={closeLabel}
            onClick={onClose}
          >
            <Icon name="close" size={18} />
          </button>
        </header>
        <div className="modal-body">{children}</div>
      </section>
    </div>,
    document.body,
  );
}

// The phone presentation of Modal is CSS only (bottom-anchored below 540px);
// the spec's word is kept as an alias so a caller may say what it means.
export const Sheet = Modal;

"use client";

import type { ComponentPropsWithoutRef, MouseEvent, ReactNode } from "react";
import { buttonClassName, type ButtonSize, type ButtonVariant } from "../lib/buttonClass";

// spec §5.2 Button: primary / secondary / quiet / destructive, one boolean for
// the pending state. Pending keeps focus on the control (aria-disabled +
// aria-busy with a click guard, never `disabled`) while the write is on the
// wire, so a keyboard or screen-reader user is not thrown to <body> the
// moment they press Save; the owning form guards implicit submission itself
// (`if (pending) return;` first in its onSubmit). `type` defaults to "button"
// so a Button inside a form never submits by accident; submits say so.
export type ButtonProps = Omit<ComponentPropsWithoutRef<"button">, "type"> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  pending?: boolean;
  pendingLabel?: ReactNode;
  type?: "button" | "submit" | "reset";
  icon?: ReactNode;
};

export function Button({
  variant = "secondary",
  size = "md",
  pending = false,
  pendingLabel,
  type = "button",
  disabled,
  icon,
  className,
  children,
  onClick,
  ...rest
}: ButtonProps) {
  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    if (pending) {
      event.preventDefault();
      return;
    }
    onClick?.(event);
  };

  return (
    <button
      type={type}
      className={buttonClassName(variant, size, className)}
      disabled={disabled}
      aria-disabled={pending || undefined}
      aria-busy={pending || undefined}
      data-pending={pending || undefined}
      onClick={handleClick}
      {...rest}
    >
      {pending ? (
        <>
          <span className="btn-spinner" aria-hidden="true" />
          {pendingLabel ?? children}
        </>
      ) : (
        <>
          {icon}
          {children}
        </>
      )}
    </button>
  );
}

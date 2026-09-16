"use client";

import { useEffect, type RefObject } from "react";

// Publishes an element's rendered height as a CSS custom property on a host
// element — <html> unless a host ref is given — and keeps it current while
// the element resizes; unmounting removes the property, so a page without
// the element publishes nothing. The two sticky bars use it so a scroll
// container's scroll-padding can clear a bar whose height follows its
// content (WCAG 2.2 2.4.11 Focus Not Obscured): PageHeader writes
// --app-bar-height on <html> for the root's scroll-padding-top (shell.css,
// phone), Modal writes --modal-header-height on its card for the card's own
// (primitives.css). CSS cannot read a sibling's size, so the mirror is
// measured here; the consumer stylesheet decides what, if anything, to do
// with it.
export function usePublishedHeight(
  ref: RefObject<HTMLElement | null>,
  property: string,
  hostRef?: RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    const element = ref.current;
    const host = hostRef ? hostRef.current : document.documentElement;
    if (!element || !host) return;
    const publish = () => {
      host.style.setProperty(
        property,
        `${element.getBoundingClientRect().height}px`,
      );
    };
    publish();
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(publish);
    observer?.observe(element);
    return () => {
      observer?.disconnect();
      host.style.removeProperty(property);
    };
  }, [ref, property, hostRef]);
}

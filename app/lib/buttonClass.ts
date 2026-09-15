// The class list a Button renders (spec §5.2 Button). Pure and DOM-free so a
// server component (app/not-found.tsx) can dress a <Link> exactly like the
// client <Button> in app/components/Button.tsx, and so it unit-tests
// build-free through build:lib-test (tests/button-class.test.mjs).
export type ButtonVariant = "primary" | "secondary" | "quiet" | "destructive";
export type ButtonSize = "md" | "sm";

export function buttonClassName(
  variant: ButtonVariant = "secondary",
  size: ButtonSize = "md",
  extra?: string,
): string {
  const extraClass = extra?.trim();
  return ["btn", `btn-${variant}`, size === "sm" ? "btn-sm" : null, extraClass || null]
    .filter(Boolean)
    .join(" ");
}

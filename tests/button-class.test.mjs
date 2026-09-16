import assert from "node:assert/strict";
import test from "node:test";
import { buttonClassName } from "../.test-build/buttonClass.js";

// spec §5.2 Button: one class list for the four variants and two sizes,
// shared by the client <Button> (app/components/Button.tsx) and by server
// components that dress a <Link> the same way (app/not-found.tsx). Pure, so
// it runs build-free after `npm run build:lib-test`.

test("buttonClassName defaults to the secondary, medium button", () => {
  assert.equal(buttonClassName(), "btn btn-secondary");
  assert.equal(buttonClassName(undefined, undefined, undefined), "btn btn-secondary");
});

test("every variant maps to its own modifier class", () => {
  assert.equal(buttonClassName("primary"), "btn btn-primary");
  assert.equal(buttonClassName("secondary"), "btn btn-secondary");
  assert.equal(buttonClassName("quiet"), "btn btn-quiet");
  assert.equal(buttonClassName("destructive"), "btn btn-destructive");
});

test("the small size appends btn-sm and the medium size appends nothing", () => {
  assert.equal(buttonClassName("quiet", "sm"), "btn btn-quiet btn-sm");
  assert.equal(buttonClassName("primary", "md"), "btn btn-primary");
});

test("an extra class rides at the end, trimmed, and a blank extra is dropped", () => {
  assert.equal(buttonClassName("destructive", "md", "rail-log"), "btn btn-destructive rail-log");
  assert.equal(buttonClassName("primary", "sm", "  desktop-only  "), "btn btn-primary btn-sm desktop-only");
  assert.equal(buttonClassName("primary", "md", "  "), "btn btn-primary");
  assert.equal(buttonClassName("primary", "md", ""), "btn btn-primary");
});

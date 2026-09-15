// `app/lib/modalStack.ts` is the DOM-free model behind app/components/Modal.tsx:
// which dialogs are open, in mount order, and what must be inert while the
// top-most is up — every page root the component hands in and every lower
// dialog's backdrop. Pure, so it is tested here against the ESM that
// `npm run build:lib-test` emits, exactly like tests/cycles.test.mjs. Escape
// and the backdrop press consult isTop (a11y-07, app-ux-23); the install-help
// sheet is one more entry like any other (architecture-10).
import assert from "node:assert/strict";
import test from "node:test";

import { createModalStack } from "../.test-build/modalStack.js";

const host = () => ({ inert: false });

test("dialogs stack in mount order; the top-most is the last opened, and closing out of order keeps the rest", () => {
  const stack = createModalStack();
  const a = host();
  const b = host();
  assert.equal(stack.size(), 0);
  assert.equal(stack.isTop("a"), false);
  stack.open("a", a);
  assert.equal(stack.isTop("a"), true);
  stack.open("b", b);
  assert.equal(stack.isTop("b"), true);
  assert.equal(stack.isTop("a"), false);
  assert.equal(stack.size(), 2);
  stack.close("a");
  assert.equal(stack.isTop("b"), true);
  assert.equal(stack.size(), 1);
  stack.close("b");
  assert.equal(stack.size(), 0);
  assert.equal(stack.isTop("b"), false);
  // Closing an id that is not open is a no-op (a cleanup that runs twice).
  stack.close("b");
  assert.equal(stack.size(), 0);
});

test("sync marks a page root inert while a dialog is open and restores it after the last one closes", () => {
  const stack = createModalStack();
  const root = host();
  const a = host();
  stack.open("a", a);
  stack.sync([root]);
  assert.equal(root.inert, true);
  assert.equal(a.inert, false, "the top-most dialog is never inert");
  stack.close("a");
  stack.sync([root]);
  assert.equal(root.inert, false);
});

test("a root that was already inert before the first dialog is restored to inert, not released", () => {
  const stack = createModalStack();
  const root = { inert: true };
  stack.open("a", host());
  stack.sync([root]);
  assert.equal(root.inert, true);
  stack.close("a");
  stack.sync([root]);
  assert.equal(root.inert, true);
});

test("with two dialogs open only the lower one is inert; closing the top releases it while the root stays inert", () => {
  const stack = createModalStack();
  const root = host();
  const lower = host();
  const upper = host();
  stack.open("lower", lower);
  stack.sync([root]);
  stack.open("upper", upper);
  stack.sync([root]);
  assert.deepEqual([root.inert, lower.inert, upper.inert], [true, true, false]);
  stack.close("upper");
  stack.sync([root]);
  assert.deepEqual([root.inert, lower.inert], [true, false]);
  stack.close("lower");
  stack.sync([root]);
  assert.equal(root.inert, false);
});

test("sync with nothing open leaves a root it never touched alone", () => {
  const stack = createModalStack();
  const untouched = { inert: true };
  const other = host();
  stack.sync([untouched, other]);
  assert.equal(untouched.inert, true);
  assert.equal(other.inert, false);
});

test("the prior state of a root is remembered from the first dialog, not re-read while others open over it", () => {
  // A root the stack itself made inert must not be "remembered" as inert
  // when a second dialog opens over the first — the last close releases it.
  const stack = createModalStack();
  const root = host();
  stack.open("a", host());
  stack.sync([root]);
  stack.open("b", host());
  stack.sync([root]);
  stack.close("b");
  stack.sync([root]);
  assert.equal(root.inert, true);
  stack.close("a");
  stack.sync([root]);
  assert.equal(root.inert, false);
});

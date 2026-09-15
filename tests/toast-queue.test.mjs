// `app/lib/toastQueue.ts` is the pure half of the Toast primitive (spec §5.2,
// a11y-08): one visible slot, a queue behind it, and a pause flag. "show"
// keeps today's replace-a-plain-toast behaviour — the archive/toggle/proof
// flows post two toasts back to back and the second must win — but never
// yanks a toast that carries an action. DOM-free, so it is tested here against
// the ESM `npm run build:lib-test` emits, like tests/cycles.test.mjs; ids are
// handed in by the caller (the provider owns the counter), so every case is a
// fixed object and the reducer is a pure function of (state, event).
import assert from "node:assert/strict";
import test from "node:test";

import {
  INITIAL_TOAST_STATE,
  TOAST_ACTION_DURATION,
  TOAST_DURATION,
  durationFor,
  isAssertive,
  toToastItem,
  toastReducer,
} from "../.test-build/toastQueue.js";

const noop = () => {};
const plain = (id, message = `plain ${id}`) => toToastItem({ message }, id);
const undoable = (id, message = `undo ${id}`) =>
  toToastItem({ message, action: { label: "Undo", onClick: noop } }, id);
const show = (state, item) => toastReducer(state, { type: "show", item });
const ids = (items) => items.map((item) => item.id);

test("durationFor: 6000 by default, 10000 with an action, an explicit duration wins and 0 stays 0 (sticky)", () => {
  assert.equal(TOAST_DURATION, 6000);
  assert.equal(TOAST_ACTION_DURATION, 10000);
  assert.equal(durationFor({ message: "x" }), 6000);
  assert.equal(durationFor({ message: "x", action: { label: "Undo", onClick: noop } }), 10000);
  assert.equal(durationFor({ message: "x", duration: 0 }), 0);
  assert.equal(durationFor({ message: "x", duration: 2500, action: { label: "Undo", onClick: noop } }), 2500);
});

test("toToastItem defaults tone to info and action to null, and keeps the id it is given", () => {
  assert.deepEqual(plain(7, "Saved."), { id: 7, message: "Saved.", tone: "info", duration: 6000, action: null });
  const action = { label: "Undo", onClick: noop };
  assert.deepEqual(toToastItem({ message: "Archived.", tone: "success", action }, 8), {
    id: 8,
    message: "Archived.",
    tone: "success",
    duration: 10000,
    action,
  });
});

test("isAssertive only for tone error", () => {
  assert.equal(isAssertive(plain(1)), false);
  assert.equal(isAssertive(toToastItem({ message: "x", tone: "success" }, 2)), false);
  assert.equal(isAssertive(toToastItem({ message: "x", tone: "error" }, 3)), true);
});

test("show fills an empty slot and a second plain show replaces it (today's single slot)", () => {
  assert.deepEqual(INITIAL_TOAST_STATE, { current: null, pending: [], paused: false });
  const first = show(INITIAL_TOAST_STATE, plain(1, "Learning record archived."));
  assert.equal(first.current.id, 1);
  assert.deepEqual(first.pending, []);
  const second = show(first, plain(2, "2 credits and proof saved."));
  assert.equal(second.current.id, 2);
  assert.deepEqual(second.pending, []);
  assert.equal(INITIAL_TOAST_STATE.current, null, "the reducer never mutates its input");
});

test("a show while an actionable toast is current queues behind it", () => {
  const withUndo = show(INITIAL_TOAST_STATE, undoable(1));
  const queued = show(withUndo, plain(2));
  assert.equal(queued.current.id, 1, "the Undo toast is not yanked away");
  assert.deepEqual(ids(queued.pending), [2]);
  const queuedTwice = show(queued, undoable(3));
  assert.equal(queuedTwice.current.id, 1);
  assert.deepEqual(ids(queuedTwice.pending), [2, 3]);
});

test("expire promotes the next pending item and ignores a stale id", () => {
  const state = show(show(INITIAL_TOAST_STATE, undoable(1)), plain(2));
  const stale = toastReducer(state, { type: "expire", id: 99 });
  assert.equal(stale, state, "an expire for an id that is not current is a no-op (same reference)");
  const promoted = toastReducer(state, { type: "expire", id: 1 });
  assert.equal(promoted.current.id, 2);
  assert.deepEqual(promoted.pending, []);
  const emptied = toastReducer(promoted, { type: "expire", id: 2 });
  assert.equal(emptied.current, null);
  assert.deepEqual(emptied.pending, []);
});

test("expire is ignored while paused; resume flips the flag and the next expire lands", () => {
  const shown = show(INITIAL_TOAST_STATE, plain(1));
  const paused = toastReducer(shown, { type: "pause" });
  assert.equal(paused.paused, true);
  assert.equal(toastReducer(paused, { type: "pause" }), paused, "pause is idempotent");
  const held = toastReducer(paused, { type: "expire", id: 1 });
  assert.equal(held.current.id, 1, "a hovered or focused toast does not expire");
  const resumed = toastReducer(held, { type: "resume" });
  assert.equal(resumed.paused, false);
  assert.equal(toastReducer(resumed, { type: "resume" }), resumed, "resume is idempotent");
  assert.equal(toastReducer(resumed, { type: "expire", id: 1 }).current, null);
});

test("dismiss removes the current (promoting the next) or a pending item by id", () => {
  const state = show(show(show(INITIAL_TOAST_STATE, undoable(1)), plain(2)), plain(3));
  const pendingGone = toastReducer(state, { type: "dismiss", id: 2 });
  assert.equal(pendingGone.current.id, 1);
  assert.deepEqual(ids(pendingGone.pending), [3]);
  const currentGone = toastReducer(state, { type: "dismiss", id: 1 });
  assert.equal(currentGone.current.id, 2);
  assert.deepEqual(ids(currentGone.pending), [3]);
  assert.deepEqual(ids(toastReducer(state, { type: "dismiss", id: 42 }).pending), [2, 3], "an unknown id changes nothing");
});

test("a new current toast always starts unpaused: replacing or promoting clears a stale pause", () => {
  // Clicking Undo focuses the card (pause) and then unmounts it; Chrome fires
  // no blur or pointerleave for a removed element, so the pause would otherwise
  // outlive the toast it belonged to and the next confirmation would never
  // expire.
  const hovered = toastReducer(show(INITIAL_TOAST_STATE, plain(1)), { type: "pause" });
  const replaced = show(hovered, plain(2));
  assert.equal(replaced.current.id, 2);
  assert.equal(replaced.paused, false);
  const held = toastReducer(show(show(INITIAL_TOAST_STATE, undoable(1)), plain(2)), { type: "pause" });
  const promoted = toastReducer(held, { type: "dismiss", id: 1 });
  assert.equal(promoted.current.id, 2);
  assert.equal(promoted.paused, false);
  const pendingOnly = toastReducer(held, { type: "dismiss", id: 2 });
  assert.equal(pendingOnly.current.id, 1);
  assert.equal(pendingOnly.paused, true, "the current toast is still hovered");
});

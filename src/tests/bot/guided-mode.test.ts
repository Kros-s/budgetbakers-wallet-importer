import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  activeQuestion, GUIDED_WINDOW_MS, justExpired, resetGuidedForTest,
  secondsLeft, startGuided, stopGuided,
} from "../../bot/guided-mode.js";

const T0 = 1_787_000_000_000;

beforeEach(() => resetGuidedForTest());

test("no window is open until one is started", () => {
  assert.equal(activeQuestion(1, T0), null);
});

test("the question stays answerable inside the window", () => {
  startGuided(1, 42, T0);
  assert.equal(activeQuestion(1, T0), 42);
  assert.equal(activeQuestion(1, T0 + GUIDED_WINDOW_MS - 1), 42);
});

test("two minutes of silence closes it", () => {
  startGuided(1, 42, T0);
  assert.equal(activeQuestion(1, T0 + GUIDED_WINDOW_MS), null);
  // And it stays closed: a late answer must not land on the question.
  assert.equal(activeQuestion(1, T0 + 1), null);
});

test("an expired window can be reported before it is cleared", () => {
  startGuided(1, 42, T0);
  assert.equal(justExpired(1, T0 + GUIDED_WINDOW_MS + 1), true);
  assert.equal(justExpired(1, T0 + 1000), false);
});

test("windows are per chat", () => {
  startGuided(1, 10, T0);
  startGuided(2, 20, T0);
  assert.equal(activeQuestion(1, T0), 10);
  assert.equal(activeQuestion(2, T0), 20);
  stopGuided(1);
  assert.equal(activeQuestion(1, T0), null);
  assert.equal(activeQuestion(2, T0), 20);
});

test("moving to the next question resets the clock", () => {
  startGuided(1, 10, T0);
  startGuided(1, 11, T0 + GUIDED_WINDOW_MS - 1);
  assert.equal(activeQuestion(1, T0 + GUIDED_WINDOW_MS + 1), 11);
});

test("stop closes it and reports whether anything was open", () => {
  assert.equal(stopGuided(1), false);
  startGuided(1, 5, T0);
  assert.equal(stopGuided(1), true);
  assert.equal(activeQuestion(1, T0), null);
});

test("the countdown shown to the user runs down to zero", () => {
  startGuided(1, 5, T0);
  assert.equal(secondsLeft(1, T0), 120);
  assert.equal(secondsLeft(1, T0 + 60_000), 60);
  assert.equal(secondsLeft(1, T0 + GUIDED_WINDOW_MS + 5000), 0);
});

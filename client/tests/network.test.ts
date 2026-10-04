import test from "node:test";
import assert from "node:assert/strict";
import { snapshotFreshness } from "../network.ts";

test("a rendering stall preserves held controls for one frame without treating stale snapshots as fresh", () => {
  // Reproduces the CI failure: a ~770 ms software-rendered frame runs before
  // pending WebSocket callbacks. E must survive until the next fresh snapshot.
  assert.equal(snapshotFreshness(100, 84, 80), "fresh");
  assert.equal(snapshotFreshness(870, 100, 80), "stalled");
  assert.equal(snapshotFreshness(886, 870, 875), "fresh");
});

test("ordinary connection loss still expires at 750 ms without a grace frame", () => {
  assert.equal(snapshotFreshness(749, 733, 0), "fresh");
  assert.equal(snapshotFreshness(750, 734, 0), "lost");
  assert.equal(snapshotFreshness(900, 884, 0), "lost");
});

test("a stalled connection gets no second grace frame even if rendering remains slow", () => {
  assert.equal(snapshotFreshness(870, 100, 80), "stalled");
  assert.equal(snapshotFreshness(886, 870, 80), "lost");
  assert.equal(snapshotFreshness(1700, 870, 80), "lost");
  assert.equal(snapshotFreshness(2500, 1700, 80), "lost");
});

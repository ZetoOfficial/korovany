import test from "node:test";
import assert from "node:assert/strict";
import cases from "../../internal/game/data/movement_cases.json";
import { move, Prediction, SnapshotBuffer } from "../simulation.ts";
import type { Input, Motion, Player, Snapshot } from "../protocol.ts";

const input = (fields: Partial<Input> = {}): Input => ({
  seq: 1,
  forward: 0,
  strafe: 0,
  yaw: 0,
  pitch: 0,
  jump: false,
  sprint: false,
  attack: false,
  block: false,
  ...fields,
});
const player = (fields: Partial<Player> = {}): Player => ({
  id: "1",
  name: "Боец",
  faction: "elf",
  x: 0,
  y: 0,
  z: 10,
  vy: 0,
  yaw: 0,
  pitch: 0,
  health: 100,
  stamina: 100,
  blocking: false,
  kills: 0,
  deaths: 0,
  ack: 0,
  life: 1,
  attackTick: 0,
  respawnTick: 0,
  shieldTick: 0,
  connected: true,
  ...fields,
});
const snapshot = (tick: number, players: Player[]): Snapshot => ({
  type: "snapshot",
  tick,
  phase: "playing",
  endTick: 1000,
  players,
  events: [],
});

for (const scenario of cases) {
  test(`shared Go/TS contract: ${scenario.name}`, () => {
    const p: Motion = {
      y: 0,
      vy: 0,
      yaw: 0,
      pitch: 0,
      blocking: false,
      ...scenario.start,
    };
    for (const step of scenario.steps)
      for (let n = 0; n < step.count; n++) move(p, input(step.input));
    for (const key of ["x", "y", "z", "stamina"] as const)
      assert.ok(
        Math.abs(p[key] - scenario.expected[key]) < 1e-8,
        `${key}: ${p[key]} vs ${scenario.expected[key]}`,
      );
  });
}

test("server correction replays only unacknowledged input", () => {
  const prediction = new Prediction();
  prediction.reset(player());
  prediction.advance(input({ seq: 1, forward: 1 }), true);
  prediction.advance(input({ seq: 2, forward: 1 }), true);
  prediction.reconcile(player({ ack: 1, x: 1 }), true);
  assert.equal(prediction.player!.x, 1);
  assert.ok(Math.abs(prediction.player!.z - (10 - 5.2 / 60)) < 1e-9);
  assert.deepEqual(
    prediction.pending.map((i) => i.seq),
    [2],
  );
});

test("respawn discards input from the previous life", () => {
  const prediction = new Prediction();
  prediction.reset(player());
  prediction.advance(input({ forward: 1 }), true);
  prediction.reconcile(player({ life: 2, x: 14, z: 20 }), true);
  assert.equal(prediction.player!.z, 20);
  assert.equal(prediction.pending.length, 0);
});

test("remote interpolation ignores reordered snapshots and does not interpolate a respawn", () => {
  const buffer = new SnapshotBuffer();
  buffer.push(snapshot(10, [player({ x: 0 })]));
  buffer.push(snapshot(16, [player({ x: 6 })]));
  buffer.push(snapshot(12, [player({ x: 100 })]));
  assert.equal(buffer.sample(13)[0].x, 3);
  buffer.push(snapshot(19, [player({ x: 20, life: 2 })]));
  assert.equal(buffer.sample(18)[0].x, 20);
  buffer.push(snapshot(22, []));
  assert.equal(buffer.sample(20).length, 0);
});

test("prediction cannot change health or score, and pauses while dead", () => {
  const prediction = new Prediction();
  prediction.reset(player({ health: 0 }));
  prediction.advance(input({ attack: true, forward: 1 }), true);
  assert.equal(prediction.player!.z, 10);
  assert.equal(prediction.player!.health, 0);
  assert.equal(prediction.player!.kills, 0);
});

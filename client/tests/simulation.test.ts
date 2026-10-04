import test from "node:test";
import assert from "node:assert/strict";
import cases from "../../internal/game/data/movement_cases.json";
import {
  AttackFeedback,
  move,
  Prediction,
  SnapshotBuffer,
} from "../simulation.ts";
import type { Input, Motion, Player, Snapshot } from "../protocol.ts";

const input = (fields: Partial<Input> = {}): Input => ({
  weapon: 1,
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

test("attack prediction reconciles resources without spending them twice", () => {
  const prediction = new Prediction();
  prediction.reset(player({ weapon: 2 }), 200);
  const shot = input({ seq: 1, weapon: 2, attack: true });
  assert.equal(prediction.advance(shot, true), true);
  assert.equal(prediction.player!.arrows, 19);
  const stamina = prediction.player!.stamina;
  const cooldown = prediction.player!.nextAttackTick;
  for (let i = 0; i < 3; i++) {
    prediction.reconcile(player({ weapon: 2, ack: 0 }), true, 200);
    assert.equal(prediction.player!.arrows, 19);
    assert.equal(prediction.player!.stamina, stamina);
    assert.equal(prediction.player!.nextAttackTick, cooldown);
  }
  prediction.reconcile(
    player({
      weapon: 2,
      ack: 1,
      arrows: 19,
      stamina,
      nextAttackTick: cooldown,
      lastAttackSeq: 1,
    }),
    true,
    201,
  );
  assert.equal(prediction.player!.arrows, 19);
  assert.equal(prediction.pending.length, 0);
  // A server rejection restores the authoritative ammunition/cooldown.
  prediction.reconcile(player({ weapon: 2, ack: 1, arrows: 20 }), true, 201);
  assert.equal(prediction.player!.arrows, 20);
  assert.equal(prediction.player!.nextAttackTick, 0);
});

test("cooldown spans weapons; unavailable attacks do not animate", () => {
  const prediction = new Prediction();
  prediction.reset(player(), 100);
  assert.equal(prediction.advance(input({ seq: 1, attack: true }), true), true);
  for (let seq = 2; seq <= 32; seq++) {
    assert.equal(
      prediction.advance(input({ seq, attack: true, weapon: 2 }), true),
      false,
    );
  }
  assert.equal(prediction.player!.arrows, 20);
  assert.equal(
    prediction.advance(input({ seq: 33, attack: true, weapon: 2 }), true),
    true,
  );
  assert.equal(prediction.player!.arrows, 19);
  for (const state of [
    { stamina: 0 },
    { health: 0 },
    { weapon: 2 as const, arrows: 0 },
    { nextAttackTick: 999 },
  ]) {
    prediction.reset(player(state), 100);
    assert.equal(
      prediction.advance(
        input({ attack: true, weapon: state.weapon ?? 1 }),
        true,
      ),
      false,
    );
  }
  prediction.reset(player(), 100);
  assert.equal(prediction.advance(input({ attack: true }), true, false), false);
});

test("confirmed and predicted attacks share a deduplicated effect", () => {
  const feedback = new AttackFeedback();
  assert.equal(feedback.take(1, 42), true);
  assert.equal(feedback.take(1, 42), false);
  assert.equal(feedback.take(1, 43), true); // Unpredicted server acceptance.
  assert.equal(feedback.take(1, 43), false);
  assert.equal(feedback.take(2, 42), true); // Reconnect resets sequence numbers.
  assert.equal(feedback.take(2, 0), false);
});

test("view reports the actual clamped snapshot pair and historical defense", () => {
  const buffer = new SnapshotBuffer();
  buffer.push(
    snapshot(100, [
      player({ x: 0, blocking: true, shieldTick: 105, yaw: Math.PI - 0.1 }),
    ]),
  );
  buffer.push(
    snapshot(106, [
      player({ x: 6, blocking: false, shieldTick: 0, yaw: -Math.PI + 0.1 }),
    ]),
  );
  const middle = buffer.sampleView(103);
  assert.deepEqual(middle.view, { tick: 103, from: 100, to: 106 });
  assert.equal(middle.players[0].x, 3);
  assert.equal(middle.players[0].blocking, true);
  assert.equal(middle.players[0].shieldTick, 105);
  assert.ok(Math.abs(middle.players[0].yaw - Math.PI) < 1e-8);
  assert.deepEqual(buffer.sampleView(90).view, {
    tick: 100,
    from: 100,
    to: 100,
  });
  assert.deepEqual(buffer.sampleView(150).view, {
    tick: 106,
    from: 106,
    to: 106,
  });
  assert.equal(buffer.sampleView(106).players[0].blocking, false);
  buffer.push(snapshot(109, [player({ x: 20, life: 2 })]));
  assert.equal(buffer.sampleView(103).players[0].x, 20);
  buffer.clear();
  assert.equal(buffer.sampleView(103).view, undefined);
});
const player = (fields: Partial<Player> = {}): Player => ({
  weapon: 1,
  arrows: 20,
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
  lastAttackSeq: 0,
  nextAttackTick: 0,
  attackWeapon: 0,
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

test("bow predicts ammunition and corrects it from the acknowledged state", () => {
  const prediction = new Prediction();
  prediction.reset(player({ stamina: 80 }));
  prediction.advance(input({ weapon: 2, block: true, attack: true }), true);
  assert.equal(prediction.player!.weapon, 2);
  assert.equal(prediction.player!.blocking, false);
  assert.equal(prediction.player!.arrows, 19);
  prediction.reconcile(
    player({ ack: 1, weapon: 2, arrows: 19, nextAttackTick: 46 }),
    true,
    1,
  );
  assert.equal(prediction.player!.weapon, 2);
  assert.equal(prediction.player!.arrows, 19);
});

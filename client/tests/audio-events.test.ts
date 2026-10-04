import test from "node:test";
import assert from "node:assert/strict";
import { ArenaSoundEvents } from "../audio-events.ts";
import {
  readSoundSettings,
  defaultSoundSettings,
  type SoundCue,
} from "../audio.ts";
import { rules, type Input, type Player, type Snapshot } from "../protocol.ts";

const player = (fields: Partial<Player> = {}): Player => ({
  id: "self",
  name: "Боец",
  faction: "guard",
  x: 0,
  y: 0,
  z: 0,
  vy: 0,
  yaw: 0,
  pitch: 0,
  stamina: 100,
  blocking: false,
  weapon: 1,
  arrows: 20,
  bowDrawTicks: 0,
  health: 100,
  kills: 0,
  deaths: 0,
  ack: 0,
  life: 1,
  attackTick: 0,
  lastAttackSeq: 0,
  nextAttackTick: 0,
  attackWeapon: 1,
  respawnTick: 0,
  shieldTick: 0,
  connected: true,
  ...fields,
});
const snapshot = (tick: number, fields: Partial<Snapshot> = {}): Snapshot => ({
  type: "snapshot",
  tick,
  phase: "playing",
  endTick: 12000,
  players: [player(), player({ id: "opponent" })],
  events: [],
  projectiles: [],
  ...fields,
});
const input = (fields: Partial<Input> = {}): Input => ({
  seq: 1,
  weapon: 1,
  forward: 0,
  strafe: 0,
  yaw: 0,
  pitch: 0,
  jump: false,
  sprint: false,
  attack: true,
  block: false,
  ...fields,
});
function setup() {
  const heard: SoundCue[] = [];
  return { heard, events: new ArenaSoundEvents((cue) => heard.push(cue)) };
}

test("hit, shield and hurt feedback is personal and plays once across repeated snapshots", () => {
  const { events, heard } = setup();
  events.receive(
    snapshot(1, { events: [{ id: 1, type: "kill", actor: "self" }] }),
    "self",
  );
  const update = snapshot(2, {
    events: [
      { id: 1, type: "kill", actor: "self" },
      { id: 2, type: "hit", actor: "self", target: "opponent" },
      { id: 3, type: "hit", actor: "opponent", target: "self", blocked: true },
      { id: 4, type: "hit", actor: "self", target: "opponent", blocked: true },
      { id: 5, type: "hit", actor: "opponent", target: "self" },
      { id: 6, type: "hit", actor: "other", target: "opponent" },
      { id: 7, type: "arrow", actor: "self" },
    ],
  });
  events.receive(update, "self");
  events.receive({ ...update, tick: 3 }, "self");
  events.receive(update, "self");
  assert.deepEqual(heard, ["hit", "shield", "shield", "hurt"]);
});

test("kills and deaths are distinct; reconnect does not replay the event history", () => {
  const { events, heard } = setup();
  events.receive(snapshot(10), "self");
  const next = snapshot(20, {
    events: [
      { id: 1, type: "kill", actor: "self", target: "opponent" },
      { id: 2, type: "kill", actor: "opponent", target: "self" },
    ],
  });
  events.receive(next, "self");
  events.reset();
  events.receive(next, "self");
  events.receive({ ...next, tick: 21 }, "self");
  assert.deepEqual(heard, ["kill", "death"]);
});

test("countdown ticks once per second, starts once, and resets for the next round", () => {
  const { events, heard } = setup();
  events.receive(snapshot(1, { phase: "waiting" }), "self");
  for (let tick = 60; tick <= 239; tick += 3)
    events.receive(
      snapshot(tick, { phase: "countdown", endTick: 240 }),
      "self",
    );
  events.receive(snapshot(240), "self");
  events.receive(snapshot(243), "self");
  assert.deepEqual(heard, ["countdown", "countdown", "countdown", "start"]);
  events.receive(snapshot(300, { phase: "countdown", endTick: 480 }), "self");
  assert.equal(heard.at(-1), "countdown");
  assert.equal(heard.length, 5);
});

test("joining a running or finished match never announces an old start or result", () => {
  for (const phase of ["playing", "finished"] as const) {
    const { events, heard } = setup();
    events.receive(snapshot(10, { phase }), "self");
    events.receive(snapshot(11, { phase }), "self");
    assert.deepEqual(heard, []);
  }
});

test("round results respect ties and surrender, and do not repeat", () => {
  const cases: [Player[], SoundCue | undefined][] = [
    [[player({ kills: 10 }), player({ id: "other", kills: 5 })], "victory"],
    [[player({ kills: 5 }), player({ id: "other", kills: 10 })], "defeat"],
    [[player({ kills: 5 }), player({ id: "other", kills: 5 })], "draw"],
    [
      [
        player({ kills: 1 }),
        player({ id: "other", kills: 2 }),
        player({ id: "third", kills: 2 }),
      ],
      "defeat",
    ],
    [
      [
        player({ kills: 10, forfeited: true }),
        player({ id: "other", kills: 5 }),
      ],
      undefined,
    ],
    [
      [
        player({ kills: 5 }),
        player({ id: "other", kills: 10, forfeited: true }),
      ],
      "victory",
    ],
  ];
  for (const [players, expected] of cases) {
    const { events, heard } = setup();
    events.receive(snapshot(1, { players }), "self");
    events.receive(snapshot(2, { players, phase: "finished" }), "self");
    events.receive(snapshot(3, { players, phase: "finished" }), "self");
    assert.deepEqual(heard, expected ? [expected] : []);
  }
});

test("stamina cue requires a fresh valid attack attempt and does not spam on hold", () => {
  const { events, heard } = setup();
  for (let tick = 1; tick < 120; tick++)
    events.input(input(), player({ stamina: 0 }), tick, true);
  assert.deepEqual(heard, ["stamina"]);
  events.input(input({ attack: false }), player(), 120, true);
  events.input(
    input({ weapon: 2 }),
    player({ stamina: rules.bowCost - 1 }),
    121,
    true,
  );
  assert.deepEqual(heard, ["stamina", "stamina"]);
});

test("no stamina warning for disabled combat, cooldown, injury, death, cancellation or empty bow", () => {
  const cases: [Partial<Player>, Partial<Input>, boolean][] = [
    [{}, {}, false],
    [{ nextAttackTick: 20 }, {}, true],
    [{ health: 0 }, {}, true],
    [{ forfeited: true }, {}, true],
    [{ limbDamage: [0, 50, 0, 0] }, {}, true],
    [{ limbDamage: [50, 0, 0, 0] }, { weapon: 2 }, true],
    [{ arrows: 0 }, { weapon: 2 }, true],
    [{}, { cancelAttack: true }, true],
    [{ stamina: rules.attackCost }, {}, true],
  ];
  for (const [fields, action, playing] of cases) {
    const { events, heard } = setup();
    events.input(input(action), player({ stamina: 0, ...fields }), 1, playing);
    assert.deepEqual(heard, []);
  }
});

test("sound preferences survive valid storage and tolerate corrupt or unavailable storage", () => {
  const read = (value: string | null) =>
    readSoundSettings({ getItem: () => value });
  assert.deepEqual(read('{"enabled":false,"volume":0,"seppuku":false}'), {
    enabled: false,
    volume: 0,
    seppuku: false,
  });
  assert.equal(read('{"volume":4}').volume, 1);
  assert.equal(read('{"volume":-1}').volume, 0);
  for (const value of [
    null,
    "broken",
    '"oops"',
    '{"volume":"loud","enabled":3}',
  ])
    assert.deepEqual(read(value), defaultSoundSettings);
  assert.deepEqual(
    readSoundSettings({
      getItem: () => {
        throw new Error("Storage disabled");
      },
    }),
    defaultSoundSettings,
  );
});

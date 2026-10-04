import test from "node:test";
import assert from "node:assert/strict";
import { roundWinners } from "../results.ts";

test("surrender is a defeat even when the player led the score", () => {
  const leader = { id: "leader", kills: 9, forfeited: true };
  const survivor = { id: "survivor", kills: 0 };
  assert.deepEqual(roundWinners([leader, survivor]), [survivor]);
});

test("ties only include contenders, while ordinary deaths still count", () => {
  const players = [
    { id: "surrender", kills: 3, forfeited: true, health: 0 },
    { id: "dead", kills: 3, health: 0 },
    { id: "alive", kills: 3, health: 100 },
    { id: "runner-up", kills: 2, health: 100 },
  ];
  assert.deepEqual(
    roundWinners(players).map((p) => p.id),
    ["dead", "alive"],
  );
});

test("simultaneous surrender never produces a winner", () => {
  assert.deepEqual(
    roundWinners([
      { kills: 5, forfeited: true },
      { kills: 0, forfeited: true },
    ]),
    [],
  );
  assert.deepEqual(roundWinners([]), []);
});

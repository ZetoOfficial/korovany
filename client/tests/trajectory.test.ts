import test from "node:test";
import assert from "node:assert/strict";
import { rules, stepSeconds } from "../protocol.ts";
import { traceBowTrajectory } from "../trajectory.ts";

const origin = { x: 0, y: 1.8, z: 0 };
const near = (actual: number, expected: number) =>
  assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);

test("trajectory uses the arrow's flight speed and gravity, not player gravity", () => {
  const flight = traceBowTrajectory(origin, 0, 0, rules.bowDrawTicks, []);
  const seconds = 12 * stepSeconds;
  near(flight.points[12].x, 0);
  near(flight.points[12].z, -rules.bowSpeed * seconds);
  near(flight.points[12].y, origin.y - (rules.bowGravity * seconds ** 2) / 2);
  assert.equal(flight.end, "ground");
  near(flight.points.at(-1)!.y, 0);
  assert.ok(flight.points.every((point) => point.y >= -1e-9));
});

test("drawing further lengthens the trajectory; aiming up raises its arc", () => {
  const weak = traceBowTrajectory(origin, 0, 0, rules.bowMinDrawTicks, []);
  const full = traceBowTrajectory(origin, 0, 0, rules.bowDrawTicks, []);
  const raised = traceBowTrajectory(origin, 0, 0.2, rules.bowDrawTicks, []);
  assert.ok(-full.points.at(-1)!.z > -weak.points.at(-1)!.z);
  assert.ok(-raised.points.at(-1)!.z > -full.points.at(-1)!.z);
  assert.ok(raised.points.some((point) => point.y > origin.y));
  const turned = traceBowTrajectory(
    origin,
    Math.PI / 2,
    0,
    rules.bowDrawTicks,
    [],
  );
  near(turned.points.at(-1)!.x, full.points.at(-1)!.z);
  near(turned.points.at(-1)!.z, 0);
});

test("trajectory stops at the nearest thin obstacle even between flight samples", () => {
  const flight = traceBowTrajectory(origin, 0, 0, rules.bowDrawTicks, [
    { x: 0, z: -5, w: 3, d: 1, height: 4 },
    { x: 0, z: -0.2, w: 3, d: 0.001, height: 4 },
  ]);
  assert.equal(flight.end, "wall");
  near(flight.points.at(-1)!.z, -0.1995);
  assert.equal(flight.points.length, 2);
});

test("trajectory clears low cover and does not hit boxes beside the aim", () => {
  const obstacles = [
    { x: 0, z: -5, w: 4, d: 1, height: 1 },
    { x: 3, z: -8, w: 1, d: 1, height: 8 },
  ];
  const flight = traceBowTrajectory(
    origin,
    0,
    0.13,
    rules.bowDrawTicks,
    obstacles,
  );
  assert.equal(flight.end, "ground");
  assert.ok(flight.points.at(-1)!.z < -8);
});

test("range is measured along the curved path and cannot grow beyond full draw", () => {
  const elevated = { x: 0, y: 100, z: 0 };
  const flight = traceBowTrajectory(elevated, 0, 0.4, rules.bowDrawTicks, []);
  assert.equal(flight.end, "range");
  let length = 0;
  for (let i = 1; i < flight.points.length; i++) {
    const a = flight.points[i - 1],
      b = flight.points[i];
    length += Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
  }
  near(length, rules.bowRange);
  assert.deepEqual(
    traceBowTrajectory(elevated, 0, 0.4, rules.bowDrawTicks * 2, []),
    flight,
  );
});

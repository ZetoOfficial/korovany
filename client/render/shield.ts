import * as THREE from "three";
import { combat } from "../combat.ts";
import { box } from "./primitives.ts";

// The face and rim fill exactly the same box used by server collision checks.
export function createShield() {
  const shield = new THREE.Group();
  shield.position.fromArray(combat.shield.center);
  const [width, height, depth] = combat.shield.size;
  const rim = 0.09;
  box(
    shield,
    0,
    0,
    0,
    width - rim * 2,
    height - rim * 2,
    depth - 0.04,
    "#65503a",
  );
  for (const x of [-1, 1])
    box(shield, (x * (width - rim)) / 2, 0, 0, rim, height, depth, "#9b855b");
  for (const y of [-1, 1])
    box(
      shield,
      0,
      (y * (height - rim)) / 2,
      0,
      width - rim * 2,
      rim,
      depth,
      "#9b855b",
    );
  box(
    shield,
    0,
    0,
    -depth / 2 + 0.015,
    width - rim * 2,
    height - rim * 2,
    0.01,
    "#365651",
  );
  box(
    shield,
    0,
    0,
    depth / 2 - 0.015,
    width - rim * 2,
    height - rim * 2,
    0.01,
    "#65503a",
  );
  for (const x of [-0.54, -0.27, 0, 0.27, 0.54])
    box(
      shield,
      x,
      0,
      depth / 2 - 0.005,
      0.015,
      height - rim * 2,
      0.01,
      "#493a2c",
    );
  for (const y of [-height * 0.28, height * 0.28])
    box(
      shield,
      0,
      y,
      depth / 2 - 0.005,
      width - rim * 2,
      0.075,
      0.01,
      "#9b855b",
    );
  box(shield, 0, 0, -depth / 2 + 0.005, 0.09, 1.15, 0.01, "#d4bb7d");
  box(shield, 0, 0.18, -depth / 2 + 0.005, 0.7, 0.09, 0.01, "#d4bb7d");
  shield.visible = false;
  return shield;
}

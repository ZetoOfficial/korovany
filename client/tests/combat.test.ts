import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import cases from "../../internal/game/data/pose_cases.json";
import { combat, bodyYaw, partRotation } from "../combat.ts";
import { createCombatHumanoid } from "../render/combat-character.ts";
import type { Player } from "../protocol.ts";

for (const pose of cases)
  test(`shared Go/Three.js geometry: ${pose.name}`, () => {
    const state = pose.state as unknown as Player;
    const model = createCombatHumanoid("elf");
    model.group.position.set(state.x, state.y, state.z);
    model.group.rotation.y = bodyYaw(state, pose.tick);
    model.parts[pose.part].rotation.set(
      ...partRotation(state, pose.part, pose.tick),
    );
    model.group.updateMatrixWorld(true);
    const point = model.parts[pose.part].localToWorld(
      new THREE.Vector3().fromArray(pose.point),
    );
    assert.ok(
      point.distanceTo(new THREE.Vector3().fromArray(pose.expected)) < 1e-9,
    );
    if (pose.bladeTip) {
      const tip = model.parts.rightArm.localToWorld(
        new THREE.Vector3().fromArray(combat.bladeTip),
      );
      assert.ok(
        tip.distanceTo(new THREE.Vector3().fromArray(pose.bladeTip)) < 1e-9,
      );
    }
  });

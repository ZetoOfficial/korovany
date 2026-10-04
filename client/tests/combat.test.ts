import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import cases from "../../internal/game/data/pose_cases.json";
import shieldCases from "../../internal/game/data/shield_cases.json";
import { combat, bodyYaw, partRotation, shieldActive } from "../combat.ts";
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

for (const yaw of [0, Math.PI / 2, Math.PI, -0.7])
  test(`visible shield and body match server contacts at yaw ${yaw}`, () => {
    const state = {
      x: 4,
      y: 2,
      z: 6,
      yaw,
      pitch: 0.8,
      weapon: 1,
      health: 100,
      blocking: true,
      attackTick: 0,
      attackWeapon: 0,
      bowDrawTicks: 0,
    } as Player;
    const model = createCombatHumanoid("human");
    model.group.position.set(state.x, state.y, state.z);
    model.group.rotation.y = yaw;
    const meshes: THREE.Object3D[] = [];
    for (const part of combat.parts) {
      const joint = model.parts[part.id];
      joint.rotation.set(...partRotation(state, part.id, 200));
      for (const mesh of joint.children.slice(0, part.boxes.length)) {
        mesh.userData.part = part.id;
        meshes.push(mesh);
      }
    }
    model.blockShield.visible = shieldActive(state, 200);
    for (const mesh of model.blockShield.children) {
      mesh.userData.part = "shield";
      meshes.push(mesh);
    }
    model.group.updateMatrixWorld(true);
    const rotation = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 1, 0),
      yaw,
    );
    for (const fixture of shieldCases) {
      const origin = new THREE.Vector3()
        .fromArray(fixture.origin)
        .applyQuaternion(rotation)
        .add(model.group.position);
      const direction = new THREE.Vector3()
        .fromArray(fixture.direction)
        .applyQuaternion(rotation);
      const hit = new THREE.Raycaster(origin, direction, 0, 6).intersectObjects(
        meshes,
        false,
      )[0];
      assert.equal(hit?.object.userData.part ?? "", fixture.part, fixture.name);
    }
  });

test("shield visibility follows weapon, life, arm and attack state", () => {
  const state = {
    weapon: 1,
    health: 100,
    blocking: true,
    attackTick: 0,
  } as Player;
  assert.equal(shieldActive(state, 200), true);
  for (const change of [
    { weapon: 2 },
    { health: 0 },
    { blocking: false },
    { limbDamage: [0, combat.armHealth, 0, 0] },
    { attackTick: 195, attackWeapon: 1 },
  ])
    assert.equal(shieldActive({ ...state, ...change } as Player, 200), false);
});

import * as THREE from "three";
import { combat } from "../combat.ts";
import { createSword } from "./sword.ts";
import { box, shape, coneGeometry } from "./primitives.ts";

import { factionColors } from "./characters.ts";

export function createCombatHumanoid(faction: string, commander = false) {
  const g = new THREE.Group(),
    parts: Record<string, THREE.Object3D> = {};
  const skin = "#c5a079",
    cloth = factionColors[faction] ?? factionColors.elf;
  const materials: Record<string, string> = {
    skin,
    cloth,
    belt: "#514735",
    trousers: "#484e3b",
    boot: "#4d4031",
  };
  for (const part of combat.parts) {
    const joint = new THREE.Group();
    joint.position.fromArray(part.pivot);
    g.add(joint);
    parts[part.id] = joint;
    for (const mesh of part.boxes) {
      box(
        joint,
        mesh.center[0],
        mesh.center[1],
        mesh.center[2],
        mesh.size[0],
        mesh.size[1],
        mesh.size[2],
        materials[mesh.material],
      );
    }
  }
  for (const x of [-0.1, 0.1])
    box(parts.head, x, 0.035, -0.195, 0.06, 0.06, 0.02, "#302f28");
  const sword = createSword();
  parts.rightArm.add(sword);
  const cape = box(
    g,
    0,
    1.24,
    0.24,
    0.7,
    0.9,
    0.08,
    commander ? "#c69859" : cloth,
  );
  cape.rotation.x = 0.12;
  if (faction === "evil")
    for (const x of [-0.26, 0.26])
      shape(g, coneGeometry, x, 2.25, 0, 0.09, 0.39, 0.09, "#c5b69b");
  if (faction === "elf") {
    for (const x of [-0.29, 0.29])
      shape(g, coneGeometry, x, 1.94, 0, 0.1, 0.25, 0.08, skin);
  }
  if (commander)
    shape(g, coneGeometry, 0, 2.28, 0, 0.16, 0.35, 0.16, "#d7b264");
  return { group: g, parts, sword };
}

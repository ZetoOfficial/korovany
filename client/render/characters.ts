import * as THREE from "three";
import { box, shape, coneGeometry } from "./primitives.ts";

export const factionColors: Record<string, string> = {
  elf: "#557c57",
  guard: "#6e919d",
  evil: "#8c5968",
  human: "#af9867",
};

export function createHumanoid(faction: string, commander = false) {
  const g = new THREE.Group(),
    parts: Record<string, THREE.Object3D> = {};
  const skin = "#c5a079",
    cloth = factionColors[faction] ?? factionColors.elf;
  parts.body = box(g, 0, 1.22, 0, 0.65, 0.75, 0.38, cloth);
  box(g, 0, 0.91, 0, 0.69, 0.13, 0.42, "#514735");
  parts.head = box(g, 0, 1.88, 0, 0.4, 0.43, 0.38, skin);
  box(g, 0, 2.1, 0, 0.46, 0.12, 0.44, faction === "guard" ? "#b6b6a4" : cloth);
  for (const x of [-0.1, 0.1])
    box(
      parts.head,
      x / 0.4,
      0.035 / 0.43,
      -0.195 / 0.38,
      0.06 / 0.4,
      0.06 / 0.43,
      0.02 / 0.38,
      "#302f28",
    );
  for (const [name, x] of [
    ["arm", -0.46],
    ["otherArm", 0.46],
  ] as const) {
    const joint = new THREE.Group();
    joint.position.set(x, 1.5, 0);
    g.add(joint);
    box(joint, 0, -0.32, 0, 0.21, 0.65, 0.25, cloth);
    box(joint, 0, -0.67, 0, 0.2, 0.17, 0.2, skin);
    parts[name] = joint;
  }
  for (const [name, x] of [
    ["leg", -0.19],
    ["otherLeg", 0.19],
  ] as const) {
    const joint = new THREE.Group();
    joint.position.set(x, 0.9, 0);
    g.add(joint);
    box(joint, 0, -0.41, 0, 0.24, 0.78, 0.28, "#484e3b");
    box(joint, 0, -0.83, -0.08, 0.28, 0.18, 0.44, "#4d4031");
    parts[name] = joint;
  }
  box(parts.otherArm, 0, -0.73, -0.4, 0.065, 0.065, 0.9, "#ced0b4");
  box(parts.otherArm, 0, -0.73, -0.11, 0.33, 0.08, 0.08, "#b69e61");
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
  return { group: g, parts };
}

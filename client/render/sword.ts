import * as THREE from "three";
import { combat } from "../combat.ts";
import { box } from "./primitives.ts";

const bladeLength = combat.bladeBase[2] - combat.bladeTip[2];
const outline = new THREE.Shape();
outline.moveTo(-0.035, 0);
outline.lineTo(0.035, 0);
outline.lineTo(0.025, -bladeLength + 0.22);
outline.lineTo(0, -bladeLength);
outline.lineTo(-0.025, -bladeLength + 0.22);
outline.closePath();
const bladeGeometry = new THREE.ExtrudeGeometry(outline, {
  depth: 0.012,
  bevelEnabled: true,
  bevelThickness: 0.002,
  bevelSize: 0.002,
  bevelSegments: 1,
  steps: 1,
});
const steel = new THREE.MeshStandardMaterial({
  color: "#d6dccb",
  metalness: 0.65,
  roughness: 0.3,
});

// Mounted on the right shoulder; the blade endpoints also define server hits.
export function createSword() {
  const sword = new THREE.Group();
  const base = combat.bladeBase;
  const blade = new THREE.Mesh(bladeGeometry, steel);
  blade.rotation.x = Math.PI / 2;
  blade.position.set(0, base[1], base[2]);
  blade.castShadow = true;
  sword.add(blade);
  box(sword, 0, base[1], base[2] + 0.04, 0.35, 0.08, 0.09, "#b79c62");
  box(sword, 0, base[1], base[2] + 0.19, 0.075, 0.085, 0.23, "#574430");
  box(sword, 0, base[1], base[2] + 0.33, 0.1, 0.11, 0.09, "#b79c62");
  return sword;
}

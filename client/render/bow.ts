import * as THREE from "three";
import { box } from "./primitives.ts";

const arcGeometry = new THREE.TorusGeometry(0.47, 0.027, 5, 20, Math.PI);
const wood = new THREE.MeshStandardMaterial({ color: "#b18a53" });

export function createBow() {
  const group = new THREE.Group();
  const arc = new THREE.Mesh(arcGeometry, wood);
  arc.rotation.z = -Math.PI / 2;
  group.add(arc);
  box(group, 0, 0, 0, 0.012, 0.94, 0.012, "#eee0b8", false);
  box(group, 0, -0.17, 0.04, 0.16, 0.3, 0.17, "#ad8b62", false);
  const arrow = box(
    group,
    0.04,
    0,
    -0.28,
    0.024,
    0.024,
    0.85,
    "#d9be84",
    false,
  );
  arrow.name = "arrow";
  return group;
}

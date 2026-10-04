import * as THREE from "three";
import { box, coneGeometry } from "./primitives.ts";

const arcGeometry = new THREE.TorusGeometry(0.47, 0.027, 5, 20, Math.PI);
const wood = new THREE.MeshStandardMaterial({ color: "#b18a53" });
const stringMaterial = new THREE.LineBasicMaterial({ color: "#fff0c4" });
const tipMaterial = new THREE.MeshStandardMaterial({ color: "#d9dfd7" });

// The tip points along local -Z, matching the camera and flight direction.
export function createArrow() {
  const group = new THREE.Group();
  box(group, 0, 0, 0, 0.026, 0.026, 0.85, "#e3c88b", false);
  const tip = new THREE.Mesh(coneGeometry, tipMaterial);
  tip.rotation.x = -Math.PI / 2;
  tip.position.z = -0.47;
  tip.scale.set(0.06, 0.16, 0.06);
  group.add(tip);
  box(group, 0, 0, 0.32, 0.13, 0.014, 0.18, "#eee6c9", false);
  box(group, 0, 0, 0.32, 0.014, 0.13, 0.18, "#eee6c9", false);
  return group;
}

export function createBow() {
  const group = new THREE.Group();
  const arc = new THREE.Mesh(arcGeometry, wood);
  arc.rotation.set(0, Math.PI / 2, -Math.PI / 2);
  arc.name = "limbs";
  group.add(arc);
  const string = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, -0.47, 0),
      new THREE.Vector3(),
      new THREE.Vector3(0, 0.47, 0),
    ]),
    stringMaterial,
  );
  string.name = "string";
  group.add(string);
  box(group, 0, -0.17, 0.04, 0.16, 0.3, 0.17, "#ad8b62", false);
  const hand = box(
    group,
    0.04,
    -0.035,
    0.12,
    0.13,
    0.13,
    0.18,
    "#ad8b62",
    false,
  );
  hand.name = "drawHand";
  const arrow = createArrow();
  arrow.name = "arrow";
  arrow.position.set(0.04, 0, -0.3);
  group.add(arrow);
  return group;
}

export function setBowDraw(bow: THREE.Group, charge: number, loaded: boolean) {
  const draw = Math.max(0, Math.min(1, charge));
  const nock = draw * 0.38;
  const tip = 0.47 * (1 - draw * 0.07);
  bow.getObjectByName("limbs")!.scale.set(1 - draw * 0.07, 1 - draw * 0.22, 1);
  const string = bow.getObjectByName("string") as THREE.Line;
  const points = string.geometry.getAttribute("position");
  points.setXYZ(0, 0, -tip, 0);
  points.setXYZ(1, 0.04 * draw, 0, nock);
  points.setXYZ(2, 0, tip, 0);
  points.needsUpdate = true;
  string.geometry.computeBoundingSphere();
  const arrow = bow.getObjectByName("arrow")!;
  arrow.position.z = -0.3 + nock;
  arrow.visible = loaded;
  const hand = bow.getObjectByName("drawHand")!;
  hand.position.z = 0.12 + nock;
  hand.visible = loaded;
}

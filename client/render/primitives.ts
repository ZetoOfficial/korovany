import * as THREE from "three";

const materials = new Map<string, THREE.MeshStandardMaterial>();
export const boxGeometry = new THREE.BoxGeometry(1, 1, 1);
export const coneGeometry = new THREE.ConeGeometry(1, 1, 7);
export const cylinderGeometry = new THREE.CylinderGeometry(1, 1, 1, 8);

export function material(color: string): THREE.MeshStandardMaterial {
  let value = materials.get(color);
  if (!value) {
    value = new THREE.MeshStandardMaterial({
      color,
      roughness: 1,
      flatShading: true,
    });
    materials.set(color, value);
  }
  return value;
}

export function shape(
  parent: THREE.Object3D,
  geometry: THREE.BufferGeometry,
  x: number,
  y: number,
  z: number,
  sx: number,
  sy: number,
  sz: number,
  color: string,
) {
  const mesh = new THREE.Mesh(geometry, material(color));
  mesh.position.set(x, y, z);
  mesh.scale.set(sx, sy, sz);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

export function box(
  parent: THREE.Object3D,
  x: number,
  y: number,
  z: number,
  w: number,
  h: number,
  d: number,
  color: string,
  shadow = true,
) {
  const mesh = shape(parent, boxGeometry, x, y, z, w, h, d, color);
  mesh.castShadow = shadow;
  return mesh;
}

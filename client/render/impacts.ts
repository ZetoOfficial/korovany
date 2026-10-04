import * as THREE from "three";
import { box } from "./primitives.ts";
import type { GameEvent } from "../protocol.ts";

export class Impacts {
  readonly group = new THREE.Group();
  private fragments: {
    mesh: THREE.Object3D;
    velocity: THREE.Vector3;
    spin: THREE.Vector3;
    life: number;
    radius: number;
  }[] = [];

  hit(event: GameEvent, limb?: THREE.Object3D) {
    if (!event.to) return;
    const point = event.to;
    if (limb && event.severed) {
      limb.updateWorldMatrix(true, true);
      const mesh = new THREE.Group();
      for (const child of limb.children)
        if (child instanceof THREE.Mesh) mesh.add(child.clone());
      limb.getWorldPosition(mesh.position);
      limb.getWorldQuaternion(mesh.quaternion);
      mesh.visible = true;
      this.group.add(mesh);
      this.fragments.push({
        mesh,
        velocity: new THREE.Vector3(1.5, 3, 1),
        spin: new THREE.Vector3(3, 1, 4),
        life: 3,
        radius: 0.25,
      });
    }
    for (let i = 0; i < 7; i++) {
      const angle = i * 2.4 + event.id;
      const mesh = box(
        this.group,
        point.x,
        point.y,
        point.z,
        0.035,
        0.035,
        0.09,
        event.blocked ? "#ffe4a0" : "#c7ac7c",
        false,
      );
      this.fragments.push({
        mesh,
        velocity: new THREE.Vector3(
          Math.sin(angle) * 1.5,
          1 + i * 0.22,
          Math.cos(angle) * 1.5,
        ),
        spin: new THREE.Vector3(5, 3, 2),
        life: 0.35 + i * 0.04,
        radius: 0.03,
      });
    }
    while (this.fragments.length > 100)
      this.group.remove(this.fragments.shift()!.mesh);
  }

  update(dt: number) {
    this.fragments = this.fragments.filter((fragment) => {
      fragment.life -= dt;
      if (fragment.life <= 0) {
        this.group.remove(fragment.mesh);
        return false;
      }
      fragment.velocity.y -= 17 * dt;
      fragment.mesh.position.addScaledVector(fragment.velocity, dt);
      fragment.mesh.rotation.x += fragment.spin.x * dt;
      fragment.mesh.rotation.z += fragment.spin.z * dt;
      if (fragment.mesh.position.y < fragment.radius) {
        fragment.mesh.position.y = fragment.radius;
        fragment.velocity.y = Math.abs(fragment.velocity.y) * 0.25;
        fragment.velocity.x *= 0.7;
        fragment.velocity.z *= 0.7;
        fragment.spin.multiplyScalar(0.65);
      }
      return true;
    });
  }

  clear() {
    this.group.clear();
    this.fragments = [];
  }
}

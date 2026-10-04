import * as THREE from "three";
import { createCombatHumanoid } from "./combat-character.ts";
import { box } from "./primitives.ts";
import { combat, limbMissing } from "../combat.ts";
import { factionColors } from "./characters.ts";
import { type Player, world } from "../protocol.ts";

export const seppukuImpact = 2.15;
export const seppukuDuration = 5.4;
export const ease = (start: number, end: number, age: number) => {
  const t = THREE.MathUtils.clamp((age - start) / (end - start), 0, 1);
  return t * t * (3 - 2 * t);
};

const sparkGeometry = new THREE.PlaneGeometry(1, 1);
const ringGeometry = new THREE.RingGeometry(0.96, 1, 80);
const up = new THREE.Vector3(0, 1, 0);

function segment(
  mesh: THREE.Mesh,
  from: THREE.Vector3,
  to: THREE.Vector3,
  width: number,
  depth: number,
) {
  const direction = to.clone().sub(from);
  mesh.position.copy(from).add(to).multiplyScalar(0.5);
  mesh.scale.set(width, direction.length(), depth);
  mesh.quaternion.setFromUnitVectors(up, direction.normalize());
}

// All clients pose the ceremony from the authoritative start tick. No timers
// or accumulated joint rotations: reconnects and dropped frames remain stable.
export class SeppukuActor {
  readonly group = new THREE.Group();
  private model: ReturnType<typeof createCombatHumanoid>;
  private blade = new THREE.Group();
  private limbs: {
    side: number;
    arm: boolean;
    upper: THREE.Mesh;
    lower: THREE.Mesh;
    tip: THREE.Mesh;
  }[] = [];
  private ringMaterial = new THREE.MeshBasicMaterial({
    color: "#d69b74",
    transparent: true,
    opacity: 0,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  private ring = new THREE.Mesh(ringGeometry, this.ringMaterial);
  private sparks = new THREE.InstancedMesh(
    sparkGeometry,
    new THREE.MeshBasicMaterial({
      color: "#ffdaa2",
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
    36,
  );
  private dummy = new THREE.Object3D();

  constructor(player: Player) {
    this.model = createCombatHumanoid(player.faction);
    this.model.sword.visible = this.model.blockShield.visible = false;
    for (const part of combat.parts) {
      if (part.limb < 0) continue;
      this.model.parts[part.id].visible = false;
      const limb = new THREE.Group();
      limb.visible = !limbMissing(player, part.limb);
      this.model.group.add(limb);
      const arm = part.limb < 2;
      const cloth = arm
        ? (factionColors[player.faction] ?? factionColors.elf)
        : "#484e3b";
      this.limbs.push({
        side: part.limb % 2 === 0 ? -1 : 1,
        arm,
        upper: box(limb, 0, 0, 0, 1, 1, 1, cloth),
        lower: box(limb, 0, 0, 0, 1, 1, 1, cloth),
        tip: box(
          limb,
          0,
          0,
          0,
          arm ? 0.19 : 0.28,
          0.17,
          arm ? 0.19 : 0.4,
          arm ? "#c5a079" : "#4d4031",
        ),
      });
    }
    // A short ceremonial blade, held inward, separate from the combat weapon.
    box(this.blade, 0, 0, -0.24, 0.065, 0.025, 0.44, "#e4e4d5");
    box(this.blade, 0, 0, 0, 0.2, 0.06, 0.06, "#cfa969");
    box(this.blade, 0, 0, 0.11, 0.06, 0.06, 0.19, "#463729");
    this.blade.rotation.y = Math.PI;
    this.model.group.add(this.blade);
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.y = 0.018;
    this.sparks.frustumCulled = false;
    this.group.add(this.model.group, this.ring, this.sparks);
  }

  update(player: Player, age: number, reducedMotion: boolean) {
    const kneel = ease(0.15, 1.25, age);
    const prepare = ease(0.85, 1.8, age);
    const strike = ease(seppukuImpact, seppukuImpact + 0.12, age);
    const fall = ease(2.65, 3.9, age);
    const breath = Math.sin(age * 3) * 0.012 * (1 - strike);
    this.group.position.set(player.x, player.y, player.z);
    this.group.rotation.y = player.yaw;
    const model = this.model;
    model.group.position.set(0, -kneel * 0.62 + fall * 0.92, -fall * 0.18);
    model.group.rotation.set(
      -kneel * 0.08 - strike * 0.12 - fall * 1.18,
      0,
      -fall * 0.1,
    );
    model.parts.head.rotation.x =
      -kneel * 0.22 - prepare * 0.15 - strike * 0.18;
    for (const limb of this.limbs) {
      const { side, arm, upper, lower, tip } = limb;
      const joint = new THREE.Vector3(
        side * (arm ? 0.46 : 0.19),
        arm ? 1.5 : 0.9,
        0,
      );
      const bend = arm
        ? new THREE.Vector3(
            side * (0.46 - prepare * 0.06),
            1.16,
            -prepare * 0.22,
          )
        : new THREE.Vector3(side * 0.21, 0.46 + kneel * 0.22, -kneel * 0.35);
      const end = arm
        ? new THREE.Vector3(
            side * (0.46 - prepare * 0.39),
            0.8 + prepare * 0.28 + breath,
            prepare * (-0.6 + strike * 0.32),
          )
        : new THREE.Vector3(side * 0.21, 0.12 + kneel * 0.61, kneel * 0.2);
      segment(upper, joint, bend, arm ? 0.21 : 0.24, arm ? 0.25 : 0.28);
      segment(lower, bend, end, arm ? 0.19 : 0.22, arm ? 0.22 : 0.26);
      tip.position.copy(end);
      if (!arm) tip.position.z -= 0.06 * (1 - kneel);
    }
    const hand = limbMissing(player, 1) ? -1 : 1;
    this.blade.position.set(
      hand * (0.46 - prepare * 0.46),
      0.8 + prepare * 0.28 + breath,
      prepare * (-0.6 + strike * 0.32) + 0.11,
    );
    this.blade.rotation.z = (1 - prepare) * -0.4;
    this.blade.visible =
      age > 0.65 &&
      age < 3.4 &&
      (!limbMissing(player, 0) || !limbMissing(player, 1));
    const burst = Math.max(0, age - seppukuImpact);
    this.ring.visible = !reducedMotion && burst > 0 && burst < 1.1;
    this.ring.scale.setScalar(0.6 + burst * 3.2);
    this.ringMaterial.opacity = Math.max(0, 0.6 * (1 - burst / 1.1));
    this.sparks.visible = !reducedMotion && burst > 0 && burst < 1.25;
    (this.sparks.material as THREE.MeshBasicMaterial).opacity = Math.max(
      0,
      1 - burst / 1.25,
    );
    if (this.sparks.visible) {
      for (let i = 0; i < 36; i++) {
        const angle = i * 2.399963;
        const speed = 0.65 + ((i * 7) % 13) * 0.11;
        this.dummy.position.set(
          Math.sin(angle) * burst * speed,
          0.6 + Math.cos(i * 1.7) * burst * 1.3 + burst * 0.45 - burst * burst,
          -0.35 + Math.cos(angle) * burst * speed,
        );
        this.dummy.rotation.set(angle, angle * 0.7, age * ((i % 3) + 1));
        this.dummy.scale.set(0.016, 0.04 + (i % 4) * 0.025, 1);
        this.dummy.updateMatrix();
        this.sparks.setMatrixAt(i, this.dummy.matrix);
      }
      this.sparks.instanceMatrix.needsUpdate = true;
    }
  }

  dispose() {
    this.group.removeFromParent();
    this.ringMaterial.dispose();
    (this.sparks.material as THREE.Material).dispose();
    this.sparks.dispose();
    // Character geometry and materials are shared by the arena's primitives.
  }
}

// Pull the camera in before a wall/crate rather than letting scenery occlude
// the ceremony. The ground and world bounds use the same arena contract.
export function ceremonyCamera(
  player: Player,
  age: number,
  reducedMotion: boolean,
) {
  const orbit = reducedMotion ? 0.55 : 0.25 + ease(0, 3.8, age) * 0.7;
  const distance = reducedMotion ? 3.5 : 2.8 + ease(0, 2, age) * 1.2;
  const angle = player.yaw + orbit;
  const target = new THREE.Vector3(player.x, player.y + 0.9, player.z);
  const desired = new THREE.Vector3(
    player.x - Math.sin(angle) * distance,
    player.y + 1.5 + (reducedMotion ? 1 : ease(0, 3.8, age)) * 0.35,
    player.z - Math.cos(angle) * distance,
  );
  const direction = desired.clone().sub(target);
  const length = direction.length();
  const ray = new THREE.Ray(target, direction.normalize());
  let clearance = length;
  for (const obstacle of world.obstacles) {
    const bounds = new THREE.Box3(
      new THREE.Vector3(
        obstacle.x - obstacle.w / 2 - 0.18,
        -0.2,
        obstacle.z - obstacle.d / 2 - 0.18,
      ),
      new THREE.Vector3(
        obstacle.x + obstacle.w / 2 + 0.18,
        obstacle.height + 0.18,
        obstacle.z + obstacle.d / 2 + 0.18,
      ),
    );
    const hit = ray.intersectBox(bounds, new THREE.Vector3());
    if (hit)
      clearance = Math.min(
        clearance,
        Math.max(0.1, target.distanceTo(hit) - 0.1),
      );
  }
  return {
    position: target.clone().addScaledVector(direction, clearance),
    target,
  };
}

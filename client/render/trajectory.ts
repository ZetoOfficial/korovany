import { canBow } from "../combat.ts";
import * as THREE from "three";
import { rules, type Player } from "../protocol.ts";
import { traceBowTrajectory } from "../trajectory.ts";

// Optional local aiming aid for playtesting. One reusable mesh draws all dots.
export class BowTrajectory {
  readonly group = new THREE.Group();
  enabled = true;
  private readonly capacity = rules.tickRate * 10;
  private readonly material = new THREE.MeshBasicMaterial({
    color: "#9affed",
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
    toneMapped: false,
    side: THREE.DoubleSide,
  });
  private readonly dots = new THREE.InstancedMesh(
    new THREE.SphereGeometry(1, 6, 4),
    this.material,
    this.capacity,
  );
  private readonly marker = new THREE.Mesh(
    new THREE.RingGeometry(0.7, 1, 28),
    this.material,
  );
  private readonly transform = new THREE.Object3D();

  constructor() {
    this.dots.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.dots.frustumCulled = false;
    this.group.add(this.dots, this.marker);
    this.group.visible = false;
  }

  update(
    player: Player | null,
    yaw: number,
    pitch: number,
    camera: THREE.Camera,
    aiming: boolean,
  ) {
    this.group.visible = !!(
      this.enabled &&
      aiming &&
      player &&
      player.health > 0 &&
      player.weapon === 2 &&
      canBow(player) &&
      player.arrows > 0 &&
      player.stamina >= rules.bowCost &&
      player.bowDrawTicks >= rules.bowMinDrawTicks
    );
    if (!this.group.visible || !player) return;

    const trajectory = traceBowTrajectory(
      { x: player.x, y: player.y + 1.8, z: player.z },
      yaw,
      pitch,
      player.bowDrawTicks,
    );
    let count = 0;
    for (
      let i = 2;
      i < trajectory.points.length - 1 && count < this.capacity;
      i += 3
    ) {
      const point = trajectory.points[i];
      this.transform.position.set(point.x, point.y, point.z);
      const distance = this.transform.position.distanceTo(camera.position);
      this.transform.scale.setScalar(Math.max(0.002, distance * 0.0025));
      this.transform.updateMatrix();
      this.dots.setMatrixAt(count++, this.transform.matrix);
    }
    this.dots.count = count;
    this.dots.instanceMatrix.needsUpdate = true;
    const end = trajectory.points[trajectory.points.length - 1];
    this.marker.position.set(end.x, end.y, end.z);
    const distance = this.marker.position.distanceTo(camera.position);
    // Lay the ring on the actual hit surface without sinking it into the floor.
    if (trajectory.normal) {
      const normal = new THREE.Vector3(
        trajectory.normal.x,
        trajectory.normal.y,
        trajectory.normal.z,
      );
      this.marker.position.addScaledVector(normal, 0.04);
      this.marker.quaternion.setFromUnitVectors(
        new THREE.Vector3(0, 0, 1),
        normal,
      );
    } else this.marker.quaternion.copy(camera.quaternion);
    this.marker.scale.setScalar(Math.max(0.12, distance * 0.008));
  }
}

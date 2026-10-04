import * as THREE from "three";
import { createCombatHumanoid as createHumanoid } from "./combat-character.ts";
import { box, shape, coneGeometry, cylinderGeometry } from "./primitives.ts";
import {
  rules,
  world,
  type Player,
  type Projectile,
  type GameEvent,
} from "../protocol.ts";
import { createArrow, createBow, setBowDraw } from "./bow.ts";
import {
  combat,
  canBow,
  limbMissing,
  partRotation,
  swordRotation,
  bodyYaw,
  shieldActive,
} from "../combat.ts";
import { createSword } from "./sword.ts";
import { createShield } from "./shield.ts";
import { Impacts } from "./impacts.ts";
import { BowTrajectory } from "./trajectory.ts";
import {
  SeppukuActor,
  ceremonyCamera,
  ease,
  seppukuImpact,
} from "./seppuku.ts";

type Avatar = ReturnType<typeof createHumanoid> & {
  label: THREE.Sprite;
  shield: THREE.Mesh;
  bow: THREE.Group;
};

export class ArenaView {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(70, 1, 0.08, 260);
  private avatars = new Map<string, Avatar>();
  private weapon = new THREE.Group();
  private blockShield = new THREE.Group();
  private bow = createBow();
  private trajectory = new BowTrajectory();
  private shotStart = -10;
  private arrows = new Map<number, THREE.Group>();
  private swingStart = -10;
  private impacts = new Impacts();
  private recoilStart = -10;
  private lookReady = false;
  private smoothPosition = new THREE.Vector3();
  private localLife = 0;
  private ceremonies = new Map<string, SeppukuActor>();
  private ceremonyTick = -1;
  private ceremonyStart = new THREE.Vector3();
  private motion = matchMedia("(prefers-reduced-motion: reduce)");

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.3;
    this.scene.background = new THREE.Color("#b7c4a7");
    this.scene.fog = new THREE.FogExp2("#b7c4a7", 0.012);
    this.scene.add(new THREE.HemisphereLight("#e9ead0", "#344e3d", 2.5));
    const sun = new THREE.DirectionalLight("#ffe0ab", 3);
    sun.position.set(-30, 70, -25);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    Object.assign(sun.shadow.camera, {
      left: -40,
      right: 40,
      top: 40,
      bottom: -40,
      near: 1,
      far: 160,
    });
    sun.shadow.normalBias = 0.05;
    this.scene.add(sun);
    const ground = box(this.scene, 0, -0.2, 0, 400, 0.4, 400, "#667b55", false);
    ground.receiveShadow = true;
    box(this.scene, 0, 0.015, 0, 7, 0.03, 60, "#b29d73", false);
    box(this.scene, 0, 0.014, 0, 48, 0.025, 6, "#a6976e", false);
    for (const obstacle of world.obstacles) {
      if (obstacle.kind === "tower") {
        shape(
          this.scene,
          cylinderGeometry,
          obstacle.x,
          4,
          obstacle.z,
          2.5,
          8,
          2.5,
          "#919781",
        );
        shape(
          this.scene,
          coneGeometry,
          obstacle.x,
          9.5,
          obstacle.z,
          3.3,
          4,
          3.3,
          "#456a5b",
        );
        continue;
      }
      box(
        this.scene,
        obstacle.x,
        obstacle.height / 2,
        obstacle.z,
        obstacle.w,
        obstacle.height,
        obstacle.d,
        obstacle.color,
      );
      if (obstacle.kind === "wall") {
        const horizontal = obstacle.w > obstacle.d;
        const length = horizontal ? obstacle.w : obstacle.d;
        for (let offset = -length / 2 + 1; offset < length / 2; offset += 3) {
          box(
            this.scene,
            obstacle.x + (horizontal ? offset : 0),
            4.4,
            obstacle.z + (horizontal ? 0 : offset),
            1.4,
            0.8,
            1.4,
            "#929982",
          );
        }
      } else if (obstacle.kind === "crate") {
        for (const dz of [-obstacle.d / 2 - 0.02, obstacle.d / 2 + 0.02]) {
          for (const dx of [-obstacle.w / 2 + 0.3, obstacle.w / 2 - 0.3]) {
            box(
              this.scene,
              obstacle.x + dx,
              obstacle.height / 2,
              obstacle.z + dz,
              0.15,
              obstacle.height,
              0.08,
              "#c0a06b",
            );
          }
        }
      } else if (obstacle.kind === "cart") {
        box(this.scene, obstacle.x, 3.18, obstacle.z, 4.2, 0.4, 7.2, "#d5bc85");
        for (const dx of [-2.05, 2.05])
          for (const dz of [-2.3, 2.3]) {
            const wheel = shape(
              this.scene,
              cylinderGeometry,
              obstacle.x + dx,
              0.85,
              obstacle.z + dz,
              0.85,
              0.28,
              0.85,
              "#574c38",
            );
            wheel.rotation.z = Math.PI / 2;
          }
      }
    }
    for (const z of [-29, 29]) {
      shape(this.scene, cylinderGeometry, -4, 3.7, z, 0.1, 7.4, 0.1, "#67573c");
      box(
        this.scene,
        -2.6,
        6.4,
        z,
        2.8,
        1.8,
        0.07,
        z < 0 ? "#8c5968" : "#557c57",
      );
    }
    // Decorative trees are outside the playable bounds; all gameplay blockers come from arena.json.
    const count = 130;
    const trunks = new THREE.InstancedMesh(
      cylinderGeometry,
      new THREE.MeshStandardMaterial({ color: "#675740" }),
      count,
    );
    const crowns = new THREE.InstancedMesh(
      coneGeometry,
      new THREE.MeshStandardMaterial({ color: "#365f4b", flatShading: true }),
      count * 2,
    );
    const dummy = new THREE.Object3D();
    let seed = 6032026;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    for (let i = 0; i < count; i++) {
      const angle = random() * Math.PI * 2,
        radius = 44 + random() * 55,
        h = 8 + random() * 9;
      const x = Math.sin(angle) * radius,
        z = Math.cos(angle) * radius;
      dummy.position.set(x, h / 3, z);
      dummy.scale.set(0.4, h * 0.66, 0.4);
      dummy.updateMatrix();
      trunks.setMatrixAt(i, dummy.matrix);
      for (let j = 0; j < 2; j++) {
        dummy.position.set(x, h * (0.6 + j * 0.2), z);
        dummy.scale.set(h * (0.26 - j * 0.08), h * 0.65, h * (0.26 - j * 0.08));
        dummy.updateMatrix();
        crowns.setMatrixAt(i * 2 + j, dummy.matrix);
      }
    }
    this.scene.add(trunks, crowns);
    this.camera.rotation.order = "YXZ";
    this.scene.add(this.camera, this.impacts.group);
    this.scene.add(this.trajectory.group);
    this.blockShield.add(createShield());
    this.blockShield.children[0].visible = true;
    this.blockShield.visible = false;
    this.scene.add(this.blockShield);
    this.camera.add(this.weapon);
    this.weapon.position.set(0.34, 0, -0.45);
    this.weapon.scale.setScalar(0.75);
    box(this.weapon, 0, -0.56, 0, 0.14, 0.28, 0.16, "#557c57", false);
    box(this.weapon, 0, -0.7, 0, 0.16, 0.16, 0.17, "#ad8b62", false);
    this.weapon.add(createSword());
    this.weapon.visible = false;
    this.bow.position.set(0.26, -0.17, -0.9);
    this.bow.scale.setScalar(0.75);
    this.bow.visible = false;
    this.camera.add(this.bow);
    window.addEventListener("resize", () => this.resize());
    this.resize();
  }

  private resize() {
    this.renderer.setSize(innerWidth, innerHeight);
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
  }

  attack(weapon: number, now: number) {
    if (weapon === 2) this.shotStart = now;
    else this.swingStart = now;
  }
  resetAttack() {
    this.swingStart = this.shotStart = this.recoilStart = -10;
    this.impacts.clear();
    this.ceremonyTick = -1;
    for (const ceremony of this.ceremonies.values()) ceremony.dispose();
    this.ceremonies.clear();
  }
  impact(event: GameEvent, self: string, now: number) {
    const avatar = event.target ? this.avatars.get(event.target) : undefined;
    this.impacts.hit(event, event.part ? avatar?.parts[event.part] : undefined);
    if (event.target === self) this.recoilStart = now;
  }
  setQuality(low: boolean) {
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, low ? 0.85 : 1.5));
    this.renderer.shadowMap.enabled = !low;
  }

  setTrajectoryPreview(enabled: boolean) {
    this.trajectory.enabled = enabled;
  }

  private avatar(player: Player) {
    const model = createHumanoid(player.faction);
    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 64;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "rgba(20,35,28,.78)";
    ctx.fillRect(0, 0, 256, 64);
    ctx.font = "26px sans-serif";
    ctx.textAlign = "center";
    ctx.fillStyle = "#f4e6be";
    ctx.fillText(player.name, 128, 42, 245);
    const label = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: new THREE.CanvasTexture(canvas),
        depthTest: true,
      }),
    );
    label.scale.set(2.6, 0.65, 1);
    label.position.y = 2.8;
    model.group.add(label);
    const shield = new THREE.Mesh(
      new THREE.SphereGeometry(1.35, 12, 8),
      new THREE.MeshBasicMaterial({
        color: "#d5d99b",
        transparent: true,
        opacity: 0.16,
        depthWrite: false,
      }),
    );
    shield.position.y = 1.1;
    model.group.add(shield);
    this.scene.add(model.group);
    const bow = createBow();
    bow.position.set(0, -0.65, -0.2);
    bow.rotation.x = -1.15;
    model.parts.leftArm.add(bow);
    const avatar = { ...model, label, shield, bow };
    this.avatars.set(player.id, avatar);
    return avatar;
  }

  render(
    local: Player | null,
    remotes: Player[],
    projectiles: Projectile[],
    id: string,
    tick: number,
    yaw: number,
    pitch: number,
    dt: number,
    now: number,
    aiming: boolean,
    localTick = tick,
    stateTick = localTick,
  ) {
    if (local?.forfeited && this.ceremonyTick !== local.seppukuTick) {
      this.ceremonyTick = local.seppukuTick ?? 0;
      this.ceremonyStart.copy(this.camera.position);
    }
    const flying = new Set(projectiles.map((arrow) => arrow.id));
    for (const [key, mesh] of this.arrows) {
      if (!local || !flying.has(key)) {
        this.scene.remove(mesh);
        this.arrows.delete(key);
      }
    }
    if (local)
      for (const arrow of projectiles) {
        let mesh = this.arrows.get(arrow.id);
        if (!mesh) {
          mesh = createArrow();
          // A short tail keeps a moving arrow readable against the scenery.
          box(mesh, 0, 0, 0.8, 0.018, 0.018, 0.65, "#ffe2a2", false);
          this.scene.add(mesh);
          this.arrows.set(arrow.id, mesh);
        }
        mesh.position.set(arrow.position.x, arrow.position.y, arrow.position.z);
        mesh.quaternion.setFromUnitVectors(
          new THREE.Vector3(0, 0, -1),
          new THREE.Vector3(
            arrow.velocity.x,
            arrow.velocity.y,
            arrow.velocity.z,
          ).normalize(),
        );
      }
    const present = new Set(
      remotes.filter((p) => p.id !== id).map((p) => p.id),
    );
    for (const [key, avatar] of this.avatars) {
      if (!present.has(key)) {
        this.scene.remove(avatar.group);
        avatar.label.material.map?.dispose();
        avatar.label.material.dispose();
        (avatar.bow.getObjectByName("string") as THREE.Line).geometry.dispose();
        avatar.shield.geometry.dispose();
        (avatar.shield.material as THREE.Material).dispose();
        this.avatars.delete(key);
      }
    }
    for (const player of remotes) {
      if (player.id === id) continue;
      const avatar = this.avatars.get(player.id) ?? this.avatar(player);
      avatar.group.visible = !player.forfeited;
      if (player.forfeited) continue;
      avatar.group.position.set(
        player.x,
        player.y + (player.health <= 0 ? 0.3 : 0),
        player.z,
      );
      avatar.group.rotation.set(
        0,
        bodyYaw(player, tick),
        player.health <= 0 ? Math.PI / 2 : 0,
      );
      for (const part of combat.parts) {
        avatar.parts[part.id].visible =
          part.limb < 0 || !limbMissing(player, part.limb);
        avatar.parts[part.id].rotation.set(
          ...partRotation(player, part.id, tick),
        );
      }
      avatar.sword.visible =
        player.weapon === 1 && !player.dummy && !limbMissing(player, 1);
      avatar.blockShield.visible = shieldActive(player, tick);
      avatar.bow.visible = player.weapon === 2 && canBow(player);
      if (avatar.bow.visible)
        setBowDraw(
          avatar.bow,
          player.bowDrawTicks / rules.bowDrawTicks,
          player.arrows > 0,
        );
      avatar.label.visible = player.health > 0;
      avatar.shield.visible = tick < player.shieldTick && player.health > 0;
    }
    if (local) {
      const target = new THREE.Vector3(
        local.x,
        local.y + (local.health > 0 ? 1.8 : 0.6),
        local.z,
      );
      const snap =
        !this.lookReady ||
        this.localLife !== local.life ||
        this.smoothPosition.distanceTo(target) > 3;
      if (snap) this.smoothPosition.copy(target);
      else this.smoothPosition.lerp(target, 1 - Math.exp(-35 * dt));
      this.lookReady = true;
      this.localLife = local.life;
      this.camera.position.copy(this.smoothPosition);
      // Local prediction runs ahead of the interpolated remote-player timeline.
      this.blockShield.visible = shieldActive(local, localTick);
      this.blockShield.position.copy(this.smoothPosition);
      this.blockShield.position.y -= 1.8;
      this.blockShield.rotation.y = yaw;
      const recoil = Math.max(0, 1 - (now - this.recoilStart) * 5);
      this.camera.rotation.set(
        pitch + Math.sin(recoil * Math.PI) * 0.035,
        yaw,
        recoil * 0.025,
      );
      this.weapon.visible =
        local.health > 0 &&
        local.weapon === 1 &&
        !limbMissing(local, 1) &&
        !this.blockShield.visible;
      this.bow.visible =
        local.health > 0 && local.weapon === 2 && canBow(local);
      this.bow.position.z =
        -0.9 + Math.max(0, 1 - (now - this.shotStart) * 5) * 0.13;
      const charge = local.bowDrawTicks / rules.bowDrawTicks;
      this.bow.position.x = 0.26 - charge * 0.07;
      this.bow.rotation.z = -charge * 0.07;
      setBowDraw(
        this.bow,
        charge,
        local.arrows > 0 && now - this.shotStart > 0.18,
      );
      const age = (now - this.swingStart) * rules.tickRate;
      const rotation = swordRotation(age);
      if (local.blocking && age >= rules.attackTicks)
        this.weapon.rotation.set(1.2, 0, -0.8);
      else this.weapon.rotation.set(...rotation);
      // The camera can turn during a committed strike; the blade retains its aim.
      if (age < rules.attackTicks) {
        this.weapon.rotation.x += (local.attackPitch ?? pitch) - pitch;
        this.weapon.rotation.y += (local.attackYaw ?? yaw) - yaw;
      }
    } else {
      this.lookReady = false;
      this.weapon.visible = false;
      this.blockShield.visible = false;
      this.bow.visible = false;
      this.camera.position.set(Math.sin(now * 0.035) * 14, 15, 25);
      this.camera.lookAt(0, 0, 0);
    }
    this.impacts.update(dt);
    this.trajectory.update(local, yaw, pitch, this.camera, aiming);
    const participants = local
      ? [local, ...remotes.filter((p) => p.id !== id)]
      : [];
    const surrendered = new Set(
      participants.filter((p) => p.forfeited).map((p) => p.id),
    );
    for (const [key, ceremony] of this.ceremonies) {
      if (!surrendered.has(key)) {
        ceremony.dispose();
        this.ceremonies.delete(key);
      }
    }
    for (const player of participants) {
      if (!player.forfeited) continue;
      let ceremony = this.ceremonies.get(player.id);
      if (!ceremony) {
        ceremony = new SeppukuActor(player);
        this.ceremonies.set(player.id, ceremony);
        this.scene.add(ceremony.group);
      }
      const age = Math.max(
        0,
        (stateTick - (player.seppukuTick ?? 0)) / rules.tickRate,
      );
      ceremony.update(player, age, this.motion.matches);
    }
    let fov = 70,
      exposure = 1.3;
    if (local?.forfeited) {
      const age = Math.max(
        0,
        (stateTick - (local.seppukuTick ?? 0)) / rules.tickRate,
      );
      const shot = ceremonyCamera(local, age, this.motion.matches);
      this.camera.position.copy(shot.position);
      if (!this.motion.matches && age < 0.8)
        this.camera.position.lerp(this.ceremonyStart, 1 - ease(0, 0.8, age));
      this.camera.lookAt(shot.target);
      if (!this.motion.matches) {
        const impact = Math.max(0, 1 - (age - seppukuImpact) / 0.45);
        if (age > seppukuImpact)
          this.camera.rotation.z +=
            Math.sin((age - seppukuImpact) * 48) * impact * 0.022;
      }
      fov = this.motion.matches ? 54 : 70 - ease(0, 1.8, age) * 16;
      exposure = 1.3 - ease(0, 1.8, age) * 0.42;
      this.weapon.visible = this.bow.visible = this.blockShield.visible = false;
    } else this.ceremonyTick = -1;
    if (this.camera.fov !== fov) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
    this.renderer.toneMappingExposure = exposure;
    this.renderer.render(this.scene, this.camera);
  }
}

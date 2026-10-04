import data from "../internal/game/data/combat.json";
import { rules, type Motion, type Player } from "./protocol.ts";

export const combat = data;
export type BodyPart =
  "head" | "torso" | "leftArm" | "rightArm" | "leftLeg" | "rightLeg";
export const partNames: Record<BodyPart, string> = {
  head: "Голова",
  torso: "Корпус",
  leftArm: "Левая рука",
  rightArm: "Правая рука",
  leftLeg: "Левая нога",
  rightLeg: "Правая нога",
};
export const limbMissing = (p: Motion, index: number) =>
  (p.limbDamage?.[index] ?? 0) >=
  (index < 2 ? combat.armHealth : combat.legHealth);
export const canBow = (p: Motion) => !limbMissing(p, 0) && !limbMissing(p, 1);
export const canWalk = (p: Motion) => !limbMissing(p, 2) && !limbMissing(p, 3);
export const swordActive = (p: Player, tick: number) =>
  p.weapon === 1 &&
  p.attackWeapon === 1 &&
  p.attackTick > 0 &&
  tick >= p.attackTick &&
  tick - p.attackTick < rules.attackTicks;
export const bodyYaw = (p: Player, tick: number) =>
  swordActive(p, tick) ? (p.attackYaw ?? p.yaw) : p.yaw;

export function swordRotation(age: number): [number, number, number] {
  const t = Math.max(0, Math.min(1, age / rules.attackTicks));
  for (let i = 1; i < combat.swing.length; i++) {
    const a = combat.swing[i - 1],
      b = combat.swing[i];
    if (t <= b.time) {
      let f = (t - a.time) / (b.time - a.time);
      f = f * f * (3 - 2 * f);
      return a.rotation.map((v, axis) => v + (b.rotation[axis] - v) * f) as [
        number,
        number,
        number,
      ];
    }
  }
  return [...combat.swing.at(-1)!.rotation] as [number, number, number];
}

// Mirrored in anatomy.go; the same joint poses drive visible meshes and hits.
export function partRotation(
  p: Player,
  part: string,
  tick: number,
): [number, number, number] {
  const walk = Math.sin(p.gait ?? 0) * 0.5;
  if (part === "leftLeg") return [walk, 0, 0];
  if (part === "rightLeg") return [-walk, 0, 0];
  if (part !== "leftArm" && part !== "rightArm") return [0, 0, 0];
  if (p.weapon === 2 && canBow(p))
    return [
      1.15 + p.pitch + (p.bowDrawTicks / rules.bowDrawTicks) * 0.25,
      0,
      0,
    ];
  if (part === "rightArm" && !p.dummy) {
    if (swordActive(p, tick)) {
      const rotation = swordRotation(tick - p.attackTick);
      rotation[0] += p.attackPitch ?? p.pitch;
      return rotation;
    }
    if (p.blocking) return [1.2, 0, -0.8];
    return [0.45 + p.pitch, 0, 0];
  }
  return [-walk * 0.5, 0, 0];
}

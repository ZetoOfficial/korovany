import { combat, canBow, canWalk, limbMissing, swordActive } from "./combat.ts";
import {
  rules,
  stepSeconds,
  world,
  type Input,
  type Motion,
  type Player,
  type Snapshot,
  type Projectile,
  type ViewTime,
} from "./protocol.ts";

export const clamp = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(v, hi));
export const wrapAngle = (angle: number) =>
  Math.atan2(Math.sin(angle), Math.cos(angle));

export function blocked(x: number, z: number) {
  return world.obstacles.some(
    (o) =>
      Math.abs(x - o.x) < o.w / 2 + rules.radius &&
      Math.abs(z - o.z) < o.d / 2 + rules.radius,
  );
}

// Health, hits, score and respawns always come from Go.
export function move(p: Motion, input: Input): void {
  const dt = stepSeconds;
  p.yaw = input.yaw;
  p.pitch = input.pitch;
  p.blocking =
    input.block && input.weapon !== 2 && p.stamina > 5 && !limbMissing(p, 1);
  let { forward, strafe } = input;
  if (!canWalk(p)) forward = strafe = 0;
  const length = Math.hypot(forward, strafe);
  if (length > 1) {
    forward /= length;
    strafe /= length;
  }
  const running = input.sprint && !p.blocking && p.stamina > 5 && length > 0;
  const injury =
    Math.max(p.limbDamage?.[2] ?? 0, p.limbDamage?.[3] ?? 0) / combat.legHealth;
  const speed =
    (running ? rules.runSpeed : rules.walkSpeed) *
    (1 - 0.45 * clamp(injury, 0, 1));
  p.gait = length > 0 ? (p.gait ?? 0) + speed * dt * 1.9 : 0;
  const nx = clamp(
    p.x +
      ((-Math.sin(p.yaw) * forward + Math.cos(p.yaw) * strafe) * speed +
        (p.impulseX ?? 0)) *
        dt,
    -world.bounds.x + rules.radius,
    world.bounds.x - rules.radius,
  );
  const nz = clamp(
    p.z +
      ((-Math.cos(p.yaw) * forward - Math.sin(p.yaw) * strafe) * speed +
        (p.impulseZ ?? 0)) *
        dt,
    -world.bounds.z + rules.radius,
    world.bounds.z - rules.radius,
  );
  if (!blocked(nx, p.z)) p.x = nx;
  if (!blocked(p.x, nz)) p.z = nz;
  p.impulseX = (p.impulseX ?? 0) * Math.exp(-10 * dt);
  p.impulseZ = (p.impulseZ ?? 0) * Math.exp(-10 * dt);
  if (Math.abs(p.impulseX) < 0.001) p.impulseX = 0;
  if (Math.abs(p.impulseZ) < 0.001) p.impulseZ = 0;
  if (input.jump && canWalk(p) && p.y === 0 && p.stamina >= rules.jumpCost) {
    p.vy = rules.jumpSpeed;
    p.stamina -= rules.jumpCost;
  }
  p.vy -= rules.gravity * dt;
  p.y = Math.max(0, p.y + p.vy * dt);
  if (p.y === 0) p.vy = 0;
  p.stamina = clamp(
    p.stamina +
      dt *
        (running
          ? -rules.runDrain
          : p.blocking
            ? rules.blockRegen
            : rules.staminaRegen),
    0,
    100,
  );
}

export class Prediction {
  player: Player | null = null;
  pending: Input[] = [];
  private tick = 0;

  reset(player: Player, tick = 0) {
    this.player = { ...player };
    this.pending = [];
    this.tick = tick;
  }

  private step(input: Input, active: boolean, combat: boolean): boolean {
    this.tick++;
    const p = this.player;
    if (!p) return false;
    if (!active || p.health <= 0) {
      p.bowDrawTicks = 0;
      return false;
    }
    p.weapon = input.weapon;
    move(p, swordActive(p, this.tick) ? { ...input, block: false } : input);
    const cost = p.weapon === 2 ? rules.bowCost : rules.attackCost;
    const available =
      combat &&
      (p.weapon === 2 ? canBow(p) : !limbMissing(p, 1)) &&
      this.tick >= p.nextAttackTick &&
      p.stamina >= cost;
    let fire = input.attack;
    if (p.weapon === 2) {
      const draw = p.bowDrawTicks;
      if (!available || input.cancelAttack || p.arrows <= 0) {
        p.bowDrawTicks = 0;
        return false;
      }
      if (input.attack) {
        p.bowDrawTicks = Math.min(rules.bowDrawTicks, draw + 1);
        return false;
      }
      p.bowDrawTicks = 0;
      fire = draw >= rules.bowMinDrawTicks;
    } else p.bowDrawTicks = 0;
    if (!available || !fire) return false;
    p.stamina -= cost;
    if (p.weapon === 2) p.arrows--;
    p.attackTick = this.tick;
    p.lastAttackSeq = input.seq;
    p.attackWeapon = p.weapon;
    p.attackPitch = p.pitch;
    p.attackYaw = p.yaw;
    p.blocking = false;
    p.nextAttackTick =
      this.tick + (p.weapon === 2 ? rules.bowTicks : rules.attackTicks);
    p.shieldTick = 0;
    return true;
  }

  advance(input: Input, active: boolean, combat = active): boolean {
    if (!this.player) return false;
    this.pending.push(input);
    // Bound memory and visual speculation if the server stops responding.
    if (this.pending.length > 120) this.pending.shift();
    return this.step(input, active, combat);
  }

  reconcile(player: Player, active: boolean, tick = 0, combat = active) {
    if (!this.player || player.life !== this.player.life) {
      this.reset(player, tick);
      return;
    }
    this.pending = this.pending.filter((input) => input.seq > player.ack);
    this.player = { ...player };
    this.tick = tick;
    // Replay changes predicted resources, but never emits visual effects.
    for (const input of this.pending) this.step(input, active, combat);
  }
}

// Both local prediction and authoritative confirmation use this bounded ledger.
export class AttackFeedback {
  private life = -1;
  private seen = new Set<number>();

  take(life: number, seq: number): boolean {
    if (life !== this.life) {
      this.life = life;
      this.seen.clear();
    }
    if (!seq || this.seen.has(seq)) return false;
    this.seen.add(seq);
    if (this.seen.size > 128)
      this.seen.delete(this.seen.values().next().value!);
    return true;
  }
}

export class SnapshotBuffer {
  private samples: Snapshot[] = [];

  clear() {
    this.samples = [];
  }
  push(snapshot: Snapshot) {
    if (this.samples.length && snapshot.tick <= this.samples.at(-1)!.tick)
      return;
    this.samples.push(snapshot);
    if (this.samples.length > 12) this.samples.shift();
  }

  sample(tick: number): Player[] {
    return this.sampleView(tick).players;
  }

  sampleView(tick: number): {
    players: Player[];
    projectiles: Projectile[];
    view?: ViewTime;
  } {
    if (!this.samples.length) return { players: [], projectiles: [] };
    tick = clamp(tick, this.samples[0].tick, this.samples.at(-1)!.tick);
    let before = this.samples[0],
      after = this.samples.at(-1)!;
    for (const s of this.samples) {
      if (s.tick <= tick) before = s;
      if (s.tick >= tick) {
        after = s;
        break;
      }
    }
    const t =
      before.tick === after.tick
        ? 1
        : clamp((tick - before.tick) / (after.tick - before.tick), 0, 1);
    // Membership comes from the newest state; departed players disappear immediately.
    const players = this.samples.at(-1)!.players.map((latest) => {
      const a = before.players.find((p) => p.id === latest.id);
      const b = after.players.find((p) => p.id === latest.id);
      if (
        !a ||
        !b ||
        a.life !== b.life ||
        a.life !== latest.life ||
        latest.health === 0 ||
        a.health === 0 ||
        b.health === 0
      )
        return { ...latest };
      return {
        ...latest,
        blocking: a.blocking,
        shieldTick: a.shieldTick,
        weapon: a.weapon,
        attackTick: a.attackTick,
        attackWeapon: a.attackWeapon,
        attackPitch: a.attackPitch,
        attackYaw: a.attackYaw,
        limbDamage: a.limbDamage,
        gait: (a.gait ?? 0) + ((b.gait ?? 0) - (a.gait ?? 0)) * t,
        pitch: a.pitch + (b.pitch - a.pitch) * t,
        bowDrawTicks:
          a.bowDrawTicks > 0 && b.bowDrawTicks > 0
            ? a.bowDrawTicks + (b.bowDrawTicks - a.bowDrawTicks) * t
            : a.bowDrawTicks,
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
        z: a.z + (b.z - a.z) * t,
        yaw: a.yaw + wrapAngle(b.yaw - a.yaw) * t,
      };
    });
    // Arrows and opponents share the same render time. Integrate the last
    // known velocity analytically so a curved flight stays smooth at 20 Hz.
    const dt = (tick - before.tick) / rules.tickRate;
    const projectiles = before.projectiles.map((arrow) => ({
      ...arrow,
      position: {
        x: arrow.position.x + arrow.velocity.x * dt,
        y:
          arrow.position.y +
          arrow.velocity.y * dt -
          (rules.bowGravity * dt * dt) / 2,
        z: arrow.position.z + arrow.velocity.z * dt,
      },
      velocity: {
        ...arrow.velocity,
        y: arrow.velocity.y - rules.bowGravity * dt,
      },
    }));
    return {
      players,
      projectiles,
      view: { tick, from: before.tick, to: after.tick },
    };
  }
}

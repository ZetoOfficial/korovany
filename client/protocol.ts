import arena from "../internal/game/data/arena.json";

export const world = arena;
export const rules = arena.rules;
export const protocolVersion = 6;
export const stepSeconds = 1 / rules.tickRate;
export const interpolationTicks = rules.tickRate * 0.1;

export type DummyAction = "add_dummy" | "remove_dummies";

export interface ViewTime {
  tick: number;
  from: number;
  to: number;
}

export interface Input {
  life?: number;
  view?: ViewTime;
  weapon: 1 | 2;
  seq: number;
  forward: number;
  strafe: number;
  yaw: number;
  pitch: number;
  jump: boolean;
  sprint: boolean;
  attack: boolean;
  cancelAttack?: boolean;
  block: boolean;
}

export interface Motion {
  x: number;
  y: number;
  z: number;
  vy: number;
  yaw: number;
  pitch: number;
  stamina: number;
  blocking: boolean;
  limbDamage?: [number, number, number, number];
  gait?: number;
  impulseX?: number;
  impulseZ?: number;
}

export interface Player extends Motion {
  lastCombat?: {
    tick: number;
    seq: number;
    outcome: "rejected" | "miss" | "hit" | "flying" | "swing";
    reason: string;
    part?: import("./combat.ts").HitPart;
    commandAgeMs: number;
    queueMs: number;
    rewindMs: number;
  };
  weapon: 1 | 2;
  arrows: number;
  bowDrawTicks: number;
  id: string;
  name: string;
  faction: string;
  health: number;
  kills: number;
  deaths: number;
  ack: number;
  life: number;
  attackTick: number;
  lastAttackSeq: number;
  nextAttackTick: number;
  attackWeapon: number;
  attackPitch?: number;
  attackYaw?: number;
  respawnTick: number;
  shieldTick: number;
  connected: boolean;
  dummy?: boolean;
}

export interface GameEvent {
  id: number;
  type: "hit" | "kill" | "end" | "arrow";
  actor: string;
  target?: string;
  damage?: number;
  part?: import("./combat.ts").HitPart;
  severed?: boolean;
  blocked?: boolean;
  seq?: number;
  life?: number;
  from?: { x: number; y: number; z: number };
  to?: { x: number; y: number; z: number };
}
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}
export interface Projectile {
  id: number;
  actor: string;
  life: number;
  seq: number;
  launchTick: number;
  position: Vec3;
  velocity: Vec3;
}
export interface Snapshot {
  type: "snapshot";
  tick: number;
  phase: "waiting" | "countdown" | "playing" | "finished";
  endTick: number;
  players: Player[];
  events: GameEvent[];
  projectiles: Projectile[];
}

export interface Welcome {
  type: "welcome";
  id: string;
  token: string;
  room: string;
  mapVersion: string;
  snapshot: Snapshot;
}
export type ServerMessage =
  | Welcome
  | Snapshot
  | { type: "dummy_result"; message: string }
  | { type: "pong"; time: number }
  | { type: "probe"; probe: string };

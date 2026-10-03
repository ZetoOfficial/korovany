import arena from "../internal/game/data/arena.json";

export const world = arena;
export const rules = arena.rules;
export const protocolVersion = 2;
export const stepSeconds = 1 / rules.tickRate;

export interface Input {
  weapon: 1 | 2;
  seq: number;
  forward: number;
  strafe: number;
  yaw: number;
  pitch: number;
  jump: boolean;
  sprint: boolean;
  attack: boolean;
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
}

export interface Player extends Motion {
  weapon: 1 | 2;
  arrows: number;
  id: string;
  name: string;
  faction: string;
  health: number;
  kills: number;
  deaths: number;
  ack: number;
  life: number;
  attackTick: number;
  respawnTick: number;
  shieldTick: number;
  connected: boolean;
}

export interface GameEvent {
  id: number;
  type: "hit" | "kill" | "end" | "arrow";
  actor: string;
  target?: string;
  damage?: number;
  from?: { x: number; y: number; z: number };
  to?: { x: number; y: number; z: number };
}
export interface Snapshot {
  type: "snapshot";
  tick: number;
  phase: "waiting" | "countdown" | "playing" | "finished";
  endTick: number;
  players: Player[];
  events: GameEvent[];
}

export interface Welcome {
  type: "welcome";
  id: string;
  token: string;
  room: string;
  mapVersion: string;
  snapshot: Snapshot;
}
export type ServerMessage = Welcome | Snapshot | { type: "pong"; time: number };

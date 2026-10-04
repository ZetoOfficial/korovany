import { canBow, limbMissing } from "./combat.ts";
import type { SoundCue } from "./audio.ts";
import { rules, type Input, type Player, type Snapshot } from "./protocol.ts";
import { roundWinners } from "./results.ts";

/** Authoritative events are retained across snapshots; only new ones make sound. */
export class ArenaSoundEvents {
  private previous?: Snapshot;
  private lastEvent = 0;
  private countdown = 0;
  private attacking = false;

  constructor(private play: (cue: SoundCue) => void) {}

  reset() {
    this.previous = undefined;
    this.lastEvent = this.countdown = 0;
    this.attacking = false;
  }

  receive(next: Snapshot, self: string) {
    const previous = this.previous;
    if (previous && next.tick <= previous.tick) return;
    this.previous = next;
    const seconds = Math.max(
      0,
      Math.ceil((next.endTick - next.tick) / rules.tickRate),
    );
    // Joining/reconnecting establishes a baseline, never replays old hits/results.
    if (!previous) {
      this.lastEvent = Math.max(0, ...next.events.map((event) => event.id));
      this.countdown = next.phase === "countdown" ? seconds : 0;
      return;
    }
    for (const event of next.events) {
      if (event.id <= this.lastEvent) continue;
      this.lastEvent = event.id;
      if (event.type === "hit") {
        if (event.actor !== self && event.target !== self) continue;
        this.play(
          event.blocked ? "shield" : event.target === self ? "hurt" : "hit",
        );
      } else if (event.type === "kill") {
        if (event.target === self) this.play("death");
        else if (event.actor === self) this.play("kill");
      }
    }
    if (next.phase === "countdown") {
      if (
        seconds > 0 &&
        seconds <= rules.countdownSeconds &&
        seconds !== this.countdown
      )
        this.play("countdown");
      this.countdown = seconds;
    } else this.countdown = 0;
    if (next.phase === "playing" && previous.phase === "countdown")
      this.play("start");
    if (next.phase === "finished" && previous.phase !== "finished") {
      const player = next.players.find((p) => p.id === self);
      // The surrender ceremony already has its own defeat sound.
      if (!player || player.forfeited) return;
      const winners = roundWinners(next.players);
      this.play(
        winners.some((p) => p.id === self)
          ? winners.length > 1
            ? "draw"
            : "victory"
          : "defeat",
      );
    }
  }

  input(input: Input, player: Player, tick: number, playing: boolean) {
    const pressed = input.attack && !this.attacking;
    this.attacking = input.attack;
    if (
      !playing ||
      !pressed ||
      input.cancelAttack ||
      player.health <= 0 ||
      player.forfeited ||
      tick < player.nextAttackTick
    )
      return;
    const bow = input.weapon === 2;
    if (bow ? !canBow(player) || player.arrows <= 0 : limbMissing(player, 1))
      return;
    if (player.stamina < (bow ? rules.bowCost : rules.attackCost))
      this.play("stamina");
  }
}

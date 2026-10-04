import { ArenaView } from "../client/render/arena.ts";
import { rules, type Player } from "../client/protocol.ts";
import { combat } from "../client/combat.ts";
const view = new ArenaView(
  document.querySelector<HTMLCanvasElement>("canvas")!,
);
const age = document.querySelector<HTMLInputElement>("#age")!;
const injury = document.querySelector<HTMLSelectElement>("#injury")!;
const player: Player = {
  id: "self",
  name: "Путник",
  faction: "elf",
  x: 0,
  y: 0,
  z: 0,
  vy: 0,
  yaw: 0,
  pitch: 0,
  stamina: 100,
  blocking: false,
  health: 100,
  weapon: 1,
  arrows: 20,
  bowDrawTicks: 0,
  kills: 0,
  deaths: 0,
  ack: 0,
  life: 1,
  attackTick: 100,
  lastAttackSeq: 1,
  nextAttackTick: 132,
  attackWeapon: 1,
  attackPitch: 0,
  attackYaw: 0,
  respawnTick: 0,
  shieldTick: 0,
  connected: true,
};
let playing = false,
  last = performance.now(),
  fired = false;
document.querySelector<HTMLButtonElement>("#play")!.onclick = () => {
  playing = true;
  age.value = "0";
  fired = false;
  view.resetAttack();
};
function frame(now: number) {
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;
  if (playing) {
    age.value = String(Math.min(32, Number(age.value) + dt * 60));
    if (Number(age.value) >= 32) playing = false;
  }
  const t = Number(age.value);
  document.querySelector("#phase")!.textContent =
    t < combat.windupTicks
      ? "Замах · урона ещё нет"
      : t < combat.windupTicks + combat.strikeTicks
        ? "Удар · клинок проверяет столкновения"
        : "Восстановление";
  const target: Player = {
    ...player,
    id: "target",
    name: "Соперник",
    faction: "guard",
    z: -2.5,
    yaw: Math.PI,
    attackYaw: Math.PI,
    attackTick: 0,
    attackWeapon: 0,
    limbDamage: [0, 0, 0, 0],
  };
  if (injury.value === "arm") target.limbDamage![0] = combat.armHealth;
  if (injury.value === "leg") target.limbDamage![2] = combat.legHealth;
  if (injury.value === "bow") {
    target.weapon = 2;
    target.bowDrawTicks = 60;
  }
  view.attack(1, 0);
  view.render(
    player,
    [target],
    [],
    "self",
    100 + t,
    0,
    0,
    dt,
    t / rules.tickRate,
    true,
  );
  if (playing && !fired && t >= 14) {
    fired = true;
    view.impact(
      {
        id: 1,
        type: "hit",
        actor: "self",
        target: "target",
        part: "torso",
        damage: 35,
        to: { x: 0, y: 1.3, z: -2.3 },
      },
      "self",
      t / 60,
    );
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

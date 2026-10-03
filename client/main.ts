import "./style.css";
import { ArenaView } from "./render/arena.ts";
import { Controls } from "./input.ts";
import { MatchConnection, createRoom } from "./network.ts";
import { Prediction, SnapshotBuffer } from "./simulation.ts";
import { rules, stepSeconds, type Snapshot, type Welcome } from "./protocol.ts";

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing UI element: ${id}`);
  return element as T;
}

const canvas = el<HTMLCanvasElement>("world");
const lobby = el("lobby"),
  hud = el("hud"),
  pause = el("pause");
const createButton = el<HTMLButtonElement>("create"),
  joinButton = el<HTMLButtonElement>("join");
const prediction = new Prediction(),
  snapshots = new SnapshotBuffer();
let connection: MatchConnection | null = null;
let snapshot: Snapshot | null = null;
let self = "",
  room = "",
  online = false,
  menuOpen = false,
  seq = 0;
let lastSnapshot = 0,
  lastEvent = 0,
  hitUntil = 0,
  damageUntil = 0;
let view: ArenaView;
const feed: { text: string; until: number }[] = [];

const controls = new Controls(canvas, () => setMenu(!menuOpen));

function setMenu(open: boolean) {
  if (!self) return;
  menuOpen = open;
  pause.hidden = !open;
  controls.setEnabled(!open && online);
  if (open) {
    document.exitPointerLock?.();
    el("resume").focus();
  } else void controls.capture();
}

function lobbyStatus(message: string, error = false) {
  el("lobby-status").textContent = message;
  el("lobby-status").classList.toggle("error", error);
}

function leave(message = "Создай комнату или введи код приглашения.") {
  connection?.close();
  connection = null;
  self = "";
  online = false;
  snapshot = null;
  prediction.player = null;
  prediction.pending = [];
  snapshots.clear();
  feed.length = 0;
  menuOpen = false;
  room = "";
  el<HTMLInputElement>("room-code").value = "";
  history.replaceState(null, "", `${import.meta.env.BASE_URL}arena/`);
  pause.hidden = true;
  lobby.hidden = false;
  hud.hidden = true;
  controls.setEnabled(false);
  document.exitPointerLock?.();
  createButton.disabled = false;
  joinButton.disabled = false;
  lobbyStatus(message);
}

function receive(next: Snapshot) {
  if (snapshot && next.tick <= snapshot.tick) return;
  snapshot = next;
  lastSnapshot = performance.now();
  snapshots.push(next);
  const player = next.players.find((p) => p.id === self);
  if (player) {
    const newLife =
      !prediction.player || player.life !== prediction.player.life;
    prediction.reconcile(
      player,
      next.phase === "playing" || next.phase === "waiting",
    );
    if (newLife) {
      controls.yaw = player.yaw;
      controls.pitch = player.pitch;
      controls.weapon = player.weapon;
      controls.clear();
    }
  }
  for (const event of next.events) {
    if (event.id <= lastEvent) continue;
    lastEvent = event.id;
    if (event.type === "arrow") view.shot(event, self);
    if (event.type === "hit") {
      if (event.actor === self) hitUntil = performance.now() + 170;
      if (event.target === self) damageUntil = performance.now() + 300;
    }
    if (event.type === "kill") {
      const actor =
        next.players.find((p) => p.id === event.actor)?.name ?? "Боец";
      const target =
        next.players.find((p) => p.id === event.target)?.name ?? "Боец";
      feed.push({
        text: `${actor} ⚔ ${target}`,
        until: performance.now() + 4500,
      });
      if (feed.length > 3) feed.shift();
    }
  }
}

function welcome(message: Welcome) {
  self = message.id;
  room = message.room;
  seq = 0;
  snapshot = null;
  snapshots.clear();
  prediction.player = null;
  lastEvent = message.snapshot.events.at(-1)?.id ?? 0;
  receive(message.snapshot);
  lobby.hidden = true;
  hud.hidden = false;
  el("room-label").textContent = room;
  el<HTMLInputElement>("room-code").value = room;
  el("copy-status").textContent = "Пригласи друзей по коду";
  history.replaceState(
    null,
    "",
    `${import.meta.env.BASE_URL}arena/?room=${room}`,
  );
  controls.setEnabled(!menuOpen);
}

async function join(makeRoom: boolean) {
  const nameInput = el<HTMLInputElement>("name");
  const name = nameInput.value.trim();
  if (!name || [...name].length > 24) {
    lobbyStatus("Имя должно содержать от 1 до 24 символов.", true);
    nameInput.focus();
    return;
  }
  let code = el<HTMLInputElement>("room-code").value.trim().toUpperCase();
  if (!makeRoom && !/^[A-F0-9]{6}$/.test(code)) {
    lobbyStatus("Введи шестизначный код комнаты.", true);
    return;
  }
  createButton.disabled = true;
  joinButton.disabled = true;
  lobbyStatus(makeRoom ? "Создаём комнату…" : "Ищем комнату…");
  try {
    if (makeRoom) code = await createRoom();
    connection?.close();
    connection = new MatchConnection(code, name, {
      welcome,
      snapshot: receive,
      status(message, connected) {
        online = connected;
        el("connection").textContent = message;
        controls.setEnabled(connected && !menuOpen);
        if (!connected) controls.clear();
        if (!self) lobbyStatus(message);
      },
      failed(message) {
        leave();
        lobbyStatus(message, true);
      },
      ping(milliseconds) {
        el("ping").textContent = `${milliseconds} мс`;
      },
    });
  } catch (error) {
    createButton.disabled = false;
    joinButton.disabled = false;
    lobbyStatus(
      error instanceof Error ? error.message : "Сервер недоступен.",
      true,
    );
  }
}

createButton.addEventListener("click", () => void join(true));
el<HTMLFormElement>("join-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void join(false);
});
el("menu-button").addEventListener("click", () => setMenu(true));
for (const [id, weapon] of [
  ["weapon-sword", 1],
  ["weapon-bow", 2],
] as const) {
  el(id).addEventListener("click", () => {
    if (controls.enabled) controls.weapon = weapon;
    el(id).blur();
  });
}
el("resume").addEventListener("click", () => setMenu(false));
el("leave").addEventListener("click", () => leave());
el<HTMLInputElement>("low-quality").addEventListener("change", (event) =>
  view.setQuality((event.target as HTMLInputElement).checked),
);
el("copy-room").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(
      new URL(`${import.meta.env.BASE_URL}arena/?room=${room}`, location.href)
        .href,
    );
    el("copy-status").textContent = "Приглашение скопировано";
  } catch {
    el("copy-status").textContent = `Передай друзьям код ${room}`;
  }
});
window.addEventListener("pagehide", () => connection?.close());
// Keep keyboard focus inside the menu while it is open.
pause.addEventListener("keydown", (event) => {
  if (event.key === "Escape" || event.code === "KeyP") {
    event.preventDefault();
    event.stopPropagation();
    setMenu(false);
    return;
  }
  if (event.key !== "Tab") return;
  const items = [...pause.querySelectorAll<HTMLElement>("button, input")];
  if (event.shiftKey && document.activeElement === items[0]) {
    event.preventDefault();
    items.at(-1)?.focus();
  } else if (!event.shiftKey && document.activeElement === items.at(-1)) {
    event.preventDefault();
    items[0].focus();
  }
});

function updateHUD(now: number) {
  if (!snapshot || !prediction.player) return;
  const player = snapshot.players.find((p) => p.id === self);
  if (!player) return;
  el("health-text").textContent = `${player.health}`;
  el("health-bar").style.width = `${player.health}%`;
  el("stamina-bar").style.width = `${prediction.player.stamina}%`;
  const bow = prediction.player.weapon === 2;
  el("weapon-name").textContent = bow ? "ЛУК" : "КЛИНОК";
  el("weapon-number").textContent = bow ? "02" : "01";
  el("weapon-hint").textContent = bow
    ? "ЛКМ / F · выстрел · 1 — клинок и блок"
    : "ЛКМ / F · удар · ПКМ / B · блок";
  el("ammo").textContent =
    `Стрелы: ${player.arrows} / ${rules.arrows}${bow && player.arrows === 0 ? " · возьми клинок: 1" : ""}`;
  el("weapon-sword").setAttribute("aria-pressed", String(!bow));
  el("weapon-bow").setAttribute("aria-pressed", String(bow));
  el("player-count").textContent =
    `${snapshot.players.length} / ${rules.maxPlayers}`;
  const phaseLabel = {
    waiting: "Ждём соперника",
    countdown: "Клинки наготове",
    playing: "Каждый сам за себя",
    finished: "Схватка окончена",
  };
  el("phase").textContent = phaseLabel[snapshot.phase];
  const tick =
    snapshot.tick +
    Math.min((now - lastSnapshot) / 1000, 0.25) * rules.tickRate;
  const seconds = Math.max(
    0,
    Math.ceil((snapshot.endTick - tick) / rules.tickRate),
  );
  el("timer").textContent =
    snapshot.phase === "waiting"
      ? "2–8 игроков"
      : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  let notice = "";
  if (!online || now - lastSnapshot > 750) notice = "Ждём связь с сервером…";
  else if (snapshot.phase === "waiting")
    notice = "Пригласи соперника по коду комнаты";
  else if (snapshot.phase === "countdown") notice = `${seconds || 1}`;
  else if (snapshot.phase === "finished") {
    const ranked = [...snapshot.players].sort((a, b) => b.kills - a.kills);
    const winners = ranked.filter((p) => p.kills === ranked[0]?.kills);
    notice = `${winners.length > 1 ? "Ничья" : `${winners[0]?.name} побеждает`}\nСледующая схватка через ${seconds} с`;
  } else if (player.health <= 0)
    notice = `Ты пал\nВозрождение через ${Math.max(1, Math.ceil((player.respawnTick - tick) / rules.tickRate))} с`;
  el("center-notice").textContent = notice;
  el("shield-status").textContent =
    player.health > 0 && tick < player.shieldTick
      ? "Защита после появления · исчезнет при атаке"
      : "";
  const list = el("players");
  const rows = [...snapshot.players]
    .sort((a, b) => b.kills - a.kills || a.id.localeCompare(b.id))
    .map((p) => {
      const row = document.createElement("li");
      row.classList.toggle("you", p.id === self);
      row.classList.toggle("offline", !p.connected);
      const name = document.createElement("span"),
        score = document.createElement("small");
      name.textContent = `${p.name}${p.id === self ? " · ты" : ""}${!p.connected ? " · нет связи" : ""}`;
      score.textContent = `${p.kills} / ${p.deaths}`;
      row.append(name, score);
      return row;
    });
  list.replaceChildren(...rows);
  while (feed[0]?.until < now) feed.shift();
  el("feed").replaceChildren(
    ...feed.map((item) => {
      const p = document.createElement("p");
      p.textContent = item.text;
      return p;
    }),
  );
}

let last = performance.now(),
  accumulator = 0,
  uiTimer = 0,
  fpsTimer = 0,
  frames = 0;
function frame(now: number) {
  const elapsed = Math.min((now - last) / 1000, 0.25);
  last = now;
  accumulator = Math.min(accumulator + elapsed, 5 * stepSeconds);
  const healthy = online && now - lastSnapshot < 750;
  const active = snapshot?.phase === "playing" || snapshot?.phase === "waiting";
  controls.setEnabled(
    healthy && !menuOpen && !!active && (prediction.player?.health ?? 0) > 0,
  );
  while (accumulator >= stepSeconds) {
    if (healthy && connection && prediction.player) {
      const input = controls.sample(++seq);
      if (connection.send(input)) {
        prediction.advance(input, active);
        if (input.attack && input.weapon === 1 && snapshot?.phase === "playing")
          view.swing(now / 1000);
      }
    }
    accumulator -= stepSeconds;
  }
  const tick = snapshot
    ? snapshot.tick +
      Math.min((now - lastSnapshot) / 1000, 0.25) * rules.tickRate
    : 0;
  view.render(
    prediction.player,
    snapshots.sample(tick - 6),
    self,
    tick,
    controls.yaw,
    controls.pitch,
    elapsed,
    now / 1000,
  );
  el("hit-marker").hidden = now > hitUntil;
  el("damage").style.opacity = now < damageUntil ? "0.6" : "0";
  uiTimer += elapsed;
  fpsTimer += elapsed;
  frames++;
  if (uiTimer >= 0.1) {
    updateHUD(now);
    uiTimer = 0;
  }
  if (fpsTimer >= 1) {
    el("fps").textContent = `${Math.round(frames / fpsTimer)} FPS`;
    fpsTimer = 0;
    frames = 0;
  }
  requestAnimationFrame(frame);
}

try {
  view = new ArenaView(canvas);
  createButton.disabled = false;
  joinButton.disabled = false;
  createButton.textContent = "СОЗДАТЬ КОМНАТУ →";
  const invitation = new URLSearchParams(location.search).get("room");
  if (invitation && /^[A-Fa-f0-9]{6}$/.test(invitation))
    el<HTMLInputElement>("room-code").value = invitation.toUpperCase();
  lobbyStatus(
    invitation
      ? "Введи имя и присоединяйся к друзьям."
      : "Создай комнату и поделись её кодом.",
  );
  requestAnimationFrame(frame);
} catch (error) {
  createButton.textContent = "АРЕНА НЕДОСТУПНА";
  lobbyStatus(
    "Не удалось запустить 3D. Проверь поддержку WebGL в браузере.",
    true,
  );
  console.error(error);
}

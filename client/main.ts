import { canBow, canWalk, limbMissing, combat, partNames } from "./combat.ts";
import "./style.css";
import { ArenaView } from "./render/arena.ts";
import { Controls } from "./input.ts";
import { MatchConnection, createRoom } from "./network.ts";
import {
  AttackFeedback,
  InputPacer,
  Prediction,
  SnapshotBuffer,
} from "./simulation.ts";
import { SeppukuPresentation } from "./seppuku.ts";
import { roundWinners } from "./results.ts";
import { ArenaAudio } from "./audio.ts";
import { ArenaSoundEvents } from "./audio-events.ts";
import {
  interpolationTicks,
  rules,
  stepSeconds,
  type DummyAction,
  type Snapshot,
  type Welcome,
  type ViewTime,
} from "./protocol.ts";

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
const addDummyButton = el<HTMLButtonElement>("add-dummy"),
  removeDummiesButton = el<HTMLButtonElement>("remove-dummies");
let dummyPending = false;
const prediction = new Prediction(),
  inputPacer = new InputPacer(),
  snapshots = new SnapshotBuffer();
let feedback = new AttackFeedback();
let displayedView: ViewTime | undefined;
const audio = new ArenaAudio();
const soundEvents = new ArenaSoundEvents((cue) => audio.play(cue));
const seppuku = new SeppukuPresentation(audio);
let seppukuPending = false;

function animateAttack(
  life: number,
  seq: number,
  weapon: number,
  now: number,
  audible = true,
) {
  if (feedback.take(life, seq)) {
    view.attack(weapon, now);
    if (audible) {
      audio.setBowDraw(0);
      audio.play(weapon === 2 ? "shot" : "swing");
    }
  }
}
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

const controls = new Controls(
  canvas,
  () => setMenu(!menuOpen),
  openSeppukuConfirm,
);

function setMenu(open: boolean) {
  if (!self) return;
  menuOpen = open;
  pause.hidden = !open;
  closeSeppukuConfirm();
  controls.setEnabled(!open && online);
  if (open) {
    audio.setBowDraw(0);
    document.exitPointerLock?.();
    el("resume").focus();
  } else if ((prediction.player?.health ?? 0) > 0) void controls.capture();
}

function closeSeppukuConfirm() {
  el("seppuku-confirm").hidden = true;
  el("seppuku").setAttribute("aria-expanded", "false");
}

function openSeppukuConfirm() {
  updateSeppukuControls();
  if (
    el<HTMLButtonElement>("seppuku").disabled ||
    performance.now() - lastSnapshot > 750
  )
    return;
  if (!menuOpen) setMenu(true);
  el("seppuku-confirm").hidden = false;
  el("seppuku").setAttribute("aria-expanded", "true");
  el("seppuku-cancel").focus();
}

function updateSeppukuControls() {
  const player = snapshot?.players.find((p) => p.id === self);
  const available =
    online &&
    snapshot?.phase === "playing" &&
    !!player &&
    player.health > 0 &&
    !player.forfeited;
  el<HTMLButtonElement>("seppuku").disabled = !available || seppukuPending;
  el<HTMLButtonElement>("seppuku-accept").disabled =
    !available || seppukuPending;
  el("seppuku-hint").textContent = player?.forfeited
    ? "Раунд сдан. Ты вернёшься в следующей схватке."
    : snapshot?.phase !== "playing"
      ? "Доступно после начала схватки."
      : (player?.health ?? 0) <= 0
        ? "Доступно после возрождения."
        : "Автоматическое поражение без возрождения в этом раунде.";
  if (!available) closeSeppukuConfirm();
}

function lobbyStatus(message: string, error = false) {
  el("lobby-status").textContent = message;
  el("lobby-status").classList.toggle("error", error);
}

function updateDummyControls() {
  const count = snapshot?.players.filter((p) => p.dummy).length ?? 0;
  el("dummy-count").textContent = String(count);
  addDummyButton.disabled =
    !online ||
    dummyPending ||
    !snapshot ||
    snapshot.players.length >= rules.maxPlayers;
  removeDummiesButton.disabled = !online || dummyPending || count === 0;
}

function manageDummies(action: DummyAction) {
  dummyPending = connection?.manageDummies(action) ?? false;
  el("dummy-status").textContent = dummyPending
    ? "Ждём ответ сервера…"
    : "Нет связи с сервером. Попробуй после подключения.";
  updateDummyControls();
}

function leave(message = "Создай комнату или введи код приглашения.") {
  audio.stop();
  soundEvents.reset();
  connection?.close();
  connection = null;
  self = "";
  online = false;
  snapshot = null;
  dummyPending = false;
  seppukuPending = false;
  seppuku.reset();
  el("seppuku-status").textContent = "";
  closeSeppukuConfirm();
  el("dummy-status").textContent = "";
  updateDummyControls();
  updateSeppukuControls();
  prediction.player = null;
  prediction.pending = [];
  snapshots.clear();
  feed.length = 0;
  view.resetAttack();
  hitUntil = damageUntil = 0;
  el("hit-detail").dataset.until = "0";
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
  const initial = !snapshot;
  soundEvents.receive(next, self);
  snapshot = next;
  updateDummyControls();
  lastSnapshot = performance.now();
  snapshots.push(next);
  const player = next.players.find((p) => p.id === self);
  updateSeppukuControls();
  if (player) {
    const wasForfeited = prediction.player?.forfeited;
    const newLife =
      !prediction.player || player.life !== prediction.player.life;
    if (newLife) inputPacer.reset();
    inputPacer.observe(player, seq);
    prediction.reconcile(
      player,
      next.phase === "playing" || next.phase === "waiting",
      next.tick,
      next.phase === "playing",
    );
    if (newLife) {
      controls.yaw = player.yaw;
      controls.pitch = player.pitch;
      controls.weapon = player.weapon;
      controls.clear();
      displayedView = undefined;
      view.resetAttack();
      seppuku.reset();
      seppukuPending = false;
      el("seppuku-status").textContent = "";
    }
    if (player.forfeited && !wasForfeited) {
      if (menuOpen) setMenu(false);
      controls.clear();
      document.exitPointerLock?.();
    }
    if (
      player.lastAttackSeq &&
      next.tick - player.attackTick < rules.tickRate * 0.35
    )
      animateAttack(
        player.life,
        player.lastAttackSeq,
        player.attackWeapon,
        performance.now() / 1000,
        !initial,
      );
  }
  for (const event of next.events) {
    if (event.id <= lastEvent) continue;
    lastEvent = event.id;
    if (event.type === "seppuku") {
      const actor =
        next.players.find((p) => p.id === event.actor)?.name ?? "Боец";
      feed.push({
        text: `${actor} · сэппуку · раунд сдан`,
        until: performance.now() + 6000,
      });
      if (feed.length > 3) feed.shift();
    }
    if (event.type === "hit") {
      view.impact(event, self, performance.now() / 1000);
      if (event.actor === self && event.part) {
        el("hit-detail").textContent = event.blocked
          ? "Щит · удар заблокирован"
          : `${partNames[event.part]} · −${event.damage}${event.severed ? " · потеря конечности" : ""}`;
        el("hit-detail").classList.toggle("critical", event.part === "head");
        el("hit-detail").dataset.until = String(performance.now() + 1300);
      }
      if (event.actor === self) hitUntil = performance.now() + 170;
      if (event.target === self && !event.blocked)
        damageUntil = performance.now() + 300;
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
  audio.stop();
  soundEvents.reset();
  dummyPending = false;
  el("dummy-status").textContent = "";
  self = message.id;
  room = message.room;
  seq = 0;
  snapshot = null;
  snapshots.clear();
  displayedView = undefined;
  feedback = new AttackFeedback();
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
        if (!connected) {
          audio.stop();
          dummyPending = false;
          seppukuPending = false;
        }
        updateDummyControls();
        updateSeppukuControls();
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
      dummyResult(message) {
        dummyPending = false;
        el("dummy-status").textContent = message;
        updateDummyControls();
      },
      seppukuResult(accepted, message) {
        seppukuPending = false;
        el("seppuku-status").textContent = message;
        if (accepted) closeSeppukuConfirm();
        updateSeppukuControls();
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
el("seppuku").addEventListener("click", openSeppukuConfirm);
el("seppuku-cancel").addEventListener("click", () => {
  closeSeppukuConfirm();
  el("seppuku").focus();
});
el("seppuku-accept").addEventListener("click", () => {
  const player = snapshot?.players.find((p) => p.id === self);
  if (!player || seppukuPending) return;
  audio.unlock();
  seppukuPending = connection?.seppuku(player.life) ?? false;
  el("seppuku-status").textContent = seppukuPending
    ? "Ждём ответ сервера…"
    : "Нет связи с сервером. Попробуй после подключения.";
  updateSeppukuControls();
});
el("leave").addEventListener("click", () => leave());
addDummyButton.addEventListener("click", () => manageDummies("add_dummy"));
removeDummiesButton.addEventListener("click", () =>
  manageDummies("remove_dummies"),
);
el<HTMLInputElement>("low-quality").addEventListener("change", (event) =>
  view.setQuality((event.target as HTMLInputElement).checked),
);
el<HTMLInputElement>("trajectory-preview").addEventListener("change", (event) =>
  view.setTrajectoryPreview((event.target as HTMLInputElement).checked),
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
const soundEnabled = el<HTMLInputElement>("sound-enabled");
const soundVolume = el<HTMLInputElement>("sound-volume");
const ceremonySound = el<HTMLInputElement>("seppuku-sound");
function syncSoundSettings() {
  soundEnabled.checked = audio.settings.enabled;
  soundVolume.value = String(Math.round(audio.settings.volume * 100));
  el("sound-volume-value").textContent = `${soundVolume.value}%`;
  soundVolume.disabled = !audio.settings.enabled;
  ceremonySound.checked = audio.settings.seppuku;
}
syncSoundSettings();
soundEnabled.addEventListener("change", () => {
  audio.configure({ enabled: soundEnabled.checked });
  audio.unlock();
  syncSoundSettings();
});
soundVolume.addEventListener("input", () => {
  audio.configure({ volume: Number(soundVolume.value) / 100 });
  syncSoundSettings();
});
soundVolume.addEventListener("change", () => audio.play("countdown"));
ceremonySound.addEventListener("change", () =>
  audio.configure({ seppuku: ceremonySound.checked }),
);
// AudioContext must be unlocked directly by a user gesture, before network awaits.
window.addEventListener("pointerdown", () => audio.unlock(), { capture: true });
window.addEventListener("keydown", () => audio.unlock(), { capture: true });
window.addEventListener("blur", () => audio.setFocused(false));
window.addEventListener("focus", () => audio.setFocused(!document.hidden));
document.addEventListener("visibilitychange", () =>
  audio.setFocused(!document.hidden && document.hasFocus()),
);
window.addEventListener("pagehide", () => {
  audio.stop();
  connection?.close();
});
// Keep keyboard focus inside the menu while it is open.
pause.addEventListener("keydown", (event) => {
  if (event.key === "Escape" || event.code === "KeyP") {
    event.preventDefault();
    event.stopPropagation();
    setMenu(false);
    return;
  }
  if (event.key !== "Tab") return;
  const items = [
    ...pause.querySelectorAll<HTMLElement>(
      "button:not(:disabled), input:not(:disabled)",
    ),
  ].filter((element) => element.getClientRects().length > 0);
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
    ? "Зажми ЛКМ / E · отпусти — выстрел · ПКМ / Q — отмена"
    : "ЛКМ / E · удар · ПКМ / Q · щит";
  el("ammo").textContent =
    `Стрелы: ${player.arrows} / ${rules.arrows}${bow && player.arrows === 0 ? " · возьми клинок: 1" : ""}`;
  const injuries = combat.parts.filter(
    (part) => part.limb >= 0 && (player.limbDamage?.[part.limb] ?? 0) > 0,
  );
  el("injury-status").textContent = injuries
    .map(
      (part) =>
        `${partNames[part.id as keyof typeof partNames]}: ${limbMissing(player, part.limb) ? "потеряна" : "ранена"}`,
    )
    .join(" · ");
  const restrictions = [
    !canBow(player) ? "Для лука нужны обе руки" : "",
    limbMissing(player, 1) ? "Клинок и блок недоступны" : "",
    !canWalk(player) ? "Движение и прыжки недоступны" : "",
  ].filter(Boolean);
  el("injury-effects").textContent = restrictions.join(" · ");
  if ((bow && !canBow(player)) || (!bow && limbMissing(player, 1)))
    el("weapon-hint").textContent = "Оружие недоступно из-за травмы";
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
  else if (player.forfeited && snapshot.phase !== "finished")
    notice = "Поражение · сэппуку\nТы вернёшься в следующей схватке";
  else if (snapshot.phase === "waiting")
    notice = "Пригласи соперника или добавь манекена: меню · P";
  else if (snapshot.phase === "countdown") notice = `${seconds || 1}`;
  else if (snapshot.phase === "finished") {
    const winners = roundWinners(snapshot.players);
    const result =
      winners.length === 0
        ? "Схватка окончена"
        : winners.length > 1
          ? "Ничья"
          : `${winners[0].name} побеждает`;
    notice = `${player.forfeited ? "Поражение · сэппуку\n" : ""}${result}\nСледующая схватка через ${seconds} с`;
  } else if (player.health <= 0)
    notice = `Ты пал\nВозрождение через ${Math.max(1, Math.ceil((player.respawnTick - tick) / rules.tickRate))} с`;
  el("center-notice").textContent = notice;
  el("shield-status").textContent =
    player.health > 0 && tick < player.shieldTick
      ? "Защита после появления · исчезнет при атаке"
      : "";
  const list = el("players");
  const rows = [...snapshot.players]
    .sort(
      (a, b) =>
        Number(!!a.forfeited) - Number(!!b.forfeited) ||
        b.kills - a.kills ||
        a.id.localeCompare(b.id),
    )
    .map((p) => {
      const row = document.createElement("li");
      row.classList.toggle("you", p.id === self);
      row.classList.toggle("offline", !p.connected);
      row.classList.toggle("forfeited", !!p.forfeited);
      const name = document.createElement("span"),
        score = document.createElement("small");
      name.textContent = `${p.name}${p.dummy ? ` · ${p.health} HP` : ""}${p.id === self ? " · ты" : ""}${!p.connected ? " · нет связи" : ""}`;
      score.textContent = p.forfeited ? "СДАЛСЯ" : `${p.kills} / ${p.deaths}`;
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
  // Late snapshots pause sending below, but must not erase physical key state.
  // Transport loss, menu, death and focus changes still clear controls.
  controls.setEnabled(
    online && !menuOpen && !!active && (prediction.player?.health ?? 0) > 0,
  );
  while (accumulator >= stepSeconds) {
    if (healthy && connection && prediction.player && inputPacer.advance(seq)) {
      const input = controls.sample(++seq);
      input.life = prediction.player.life;
      input.view = displayedView;
      if (connection.send(input)) {
        soundEvents.input(
          input,
          prediction.player,
          prediction.currentTick + 1,
          controls.enabled && snapshot?.phase === "playing",
        );
        if (prediction.advance(input, !!active, snapshot?.phase === "playing"))
          animateAttack(
            prediction.player.life,
            input.seq,
            input.weapon,
            now / 1000,
          );
      }
    }
    accumulator -= stepSeconds;
  }
  const tick = snapshot
    ? snapshot.tick +
      Math.min((now - lastSnapshot) / 1000, 0.25) * rules.tickRate
    : 0;
  const rendered = snapshots.sampleView(tick - interpolationTicks);
  const surrendered = prediction.player?.forfeited;
  seppuku.update(
    surrendered ? prediction.player?.seppukuTick : undefined,
    (tick - (prediction.player?.seppukuTick ?? 0)) / rules.tickRate,
    el<HTMLInputElement>("seppuku-sound").checked,
  );
  displayedView = rendered.view;
  view.render(
    prediction.player,
    rendered.players,
    rendered.projectiles,
    self,
    rendered.view?.tick ?? tick,
    controls.yaw,
    controls.pitch,
    elapsed,
    now / 1000,
    controls.enabled && snapshot?.phase === "playing",
    prediction.currentTick,
    tick,
  );
  const draw = prediction.player?.bowDrawTicks ?? 0;
  audio.setBowDraw(
    healthy &&
      controls.enabled &&
      snapshot?.phase === "playing" &&
      prediction.player?.weapon === 2 &&
      canBow(prediction.player)
      ? draw / rules.bowDrawTicks
      : 0,
  );
  el("bow-charge").hidden =
    !healthy ||
    menuOpen ||
    prediction.player?.weapon !== 2 ||
    prediction.player.health <= 0 ||
    !canBow(prediction.player) ||
    snapshot?.phase !== "playing";
  el("bow-charge-fill").style.transform =
    `scaleX(${draw / rules.bowDrawTicks})`;
  el("bow-charge").classList.toggle("ready", draw >= rules.bowMinDrawTicks);
  el("bow-charge-text").textContent =
    draw >= rules.bowDrawTicks
      ? "Полное натяжение"
      : draw > 0
        ? `Натяжение ${Math.round((draw / rules.bowDrawTicks) * 100)}%`
        : "Зажми ЛКМ / E";
  el("hit-detail").hidden = now > Number(el("hit-detail").dataset.until ?? 0);
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

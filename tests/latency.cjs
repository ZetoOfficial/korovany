/* Real UI input and public snapshots only. The observer replays prediction
 * to aim at the displayed world; it cannot change either player's state. */
const assert = require("node:assert/strict");
const { chromium } = require("playwright");
const { Prediction } = require("../client/simulation.ts");
const url = process.env.ASTRA_URL || "http://127.0.0.1:8080/";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

async function until(condition, label, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (condition()) return;
    await sleep(20);
  }
  throw new Error(`Timed out: ${label}`);
}

// TCP/WebSocket keeps messages in order, including during jitter.
function delivery(delay, jitter, send) {
  let due = 0,
    count = 0,
    stopped = false;
  const timers = new Set();
  return {
    push(payload) {
      due = Math.max(
        due,
        Date.now() + delay + jitter * Math.sin(++count * 1.7),
      );
      const timer = setTimeout(
        () => {
          timers.delete(timer);
          if (!stopped) send(payload);
        },
        Math.max(0, due - Date.now()),
      );
      timers.add(timer);
    },
    stop() {
      stopped = true;
      for (const timer of timers) clearTimeout(timer);
    },
  };
}

async function client(browser, name, rtt, jitter, errors) {
  const context = await browser.newContext({
    viewport: { width: 640, height: 480 },
  });
  await context.addInitScript(() => {
    HTMLCanvasElement.prototype.requestPointerLock = () =>
      Promise.reject(new DOMException("Test drag look", "NotSupportedError"));
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  const wire = {
    id: "",
    state: null,
    raw: null,
    frames: new Map(),
    input: null,
    attacks: new Map(),
    events: new Map(),
    prediction: new Prediction(),
  };
  await page.routeWebSocket("**/ws/*", (socket) => {
    const server = socket.connectToServer();
    const incoming = delivery(rtt / 2, jitter, (payload) => {
      const message = JSON.parse(payload.toString());
      if (message.type === "welcome") wire.id = message.id;
      const state =
        message.type === "welcome"
          ? message.snapshot
          : message.type === "snapshot"
            ? message
            : null;
      if (state) {
        wire.state = state;
        wire.frames.set(state.tick, state);
        if (wire.frames.size > 64)
          wire.frames.delete(wire.frames.keys().next().value);
        wire.prediction.reconcile(
          state.players.find((p) => p.id === wire.id),
          ["playing", "waiting"].includes(state.phase),
          state.tick,
          state.phase === "playing",
        );
        for (const event of state.events) wire.events.set(event.id, event);
      }
      socket.send(payload);
    });
    const outgoing = delivery(rtt / 2, jitter, (payload) => {
      const message = JSON.parse(payload.toString());
      if (message.type === "input" && message.input.attack) {
        const record = wire.attacks.get(message.input.seq);
        if (record) record.atReceipt = wire.raw;
      }
      server.send(payload);
    });
    server.onMessage((payload) => {
      const message = JSON.parse(payload.toString());
      if (message.type === "snapshot") wire.raw = message;
      incoming.push(payload);
    });
    socket.onMessage((payload) => {
      const message = JSON.parse(payload.toString());
      if (message.type === "input") {
        wire.input = message.input;
        if (wire.state)
          wire.prediction.advance(
            message.input,
            ["playing", "waiting"].includes(wire.state.phase),
            wire.state.phase === "playing",
          );
        if (message.input.attack)
          wire.attacks.set(message.input.seq, {
            input: message.input,
            from: wire.frames.get(message.input.view?.from),
            to: wire.frames.get(message.input.view?.to),
          });
      }
      outgoing.push(payload);
    });
    socket.onClose((code, reason) => {
      incoming.stop();
      outgoing.stop();
      void server.close({ code, reason });
    });
    server.onClose((code, reason) => {
      incoming.stop();
      outgoing.stop();
      void socket.close({ code, reason });
    });
  });
  await page.goto(new URL("arena/", url).href);
  await page.locator("#name").fill(name);
  return { page, context, wire };
}

function displayed(wire, targetID, record) {
  const view = record?.input.view ?? wire.input?.view;
  const a = (record?.from ?? wire.frames.get(view?.from))?.players.find(
    (p) => p.id === targetID,
  );
  const b = (record?.to ?? wire.frames.get(view?.to))?.players.find(
    (p) => p.id === targetID,
  );
  if (!a || !b || a.life !== b.life) return null;
  const t =
    view.from === view.to ? 0 : (view.tick - view.from) / (view.to - view.from);
  return {
    ...a,
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    z: a.z + (b.z - a.z) * t,
  };
}

async function turn(client, yaw) {
  const current = client.wire.input?.yaw ?? client.wire.prediction.player.yaw;
  await client.page.mouse.move(320, 240);
  await client.page.mouse.down({ button: "right" });
  await client.page.mouse.move(320 + wrap(current - yaw) / 0.0022, 240);
  await client.page.mouse.up({ button: "right" });
}

async function aim(a, b) {
  const target = displayed(a.wire, b.wire.id),
    self = a.wire.prediction.player;
  if (target && self)
    await turn(a, Math.atan2(self.x - target.x, self.z - target.z));
}

const stateOf = (client, id) =>
  client.wire.state?.players.find((p) => p.id === id);
const hits = (a, b) =>
  [...a.wire.events.values()].filter(
    (e) => e.type === "hit" && e.actor === a.wire.id && e.target === b.wire.id,
  );

async function scenario(browser, targetRTT, jitter) {
  const errors = [];
  const a = await client(browser, "Лучник", 200, jitter, errors);
  const b = await client(browser, "Бегущий", targetRTT, jitter, errors);
  try {
    await a.page.locator("#create").click();
    await a.page.locator("#hud").waitFor({ state: "visible" });
    await b.page
      .locator("#room-code")
      .fill(await a.page.locator("#room-label").textContent());
    await b.page.locator("#join").click();
    await until(
      () =>
        a.wire.state?.phase === "playing" &&
        b.wire.state?.phase === "playing" &&
        a.wire.input?.view,
      "round and rendered timeline",
    );
    for (const c of [a, b]) {
      await c.page.locator("#menu-button").click();
      await c.page.locator("#low-quality").check();
      await c.page.locator("#resume").click();
    }
    await sleep(1600);
    console.log(
      "Latency test clients",
      await a.page.locator("#ping").textContent(),
      await a.page.locator("#fps").textContent(),
      await b.page.locator("#fps").textContent(),
    );
    await a.page.keyboard.press("2");
    await aim(a, b);
    await until(() => stateOf(a, a.wire.id).weapon === 2, "bow equipped");
    const p = b.wire.prediction.player,
      q = a.wire.prediction.player;
    await turn(b, Math.atan2(p.x - q.x, p.z - q.z));
    await b.page.keyboard.down("Shift");
    await b.page.keyboard.down("d");
    await sleep(350);
    await aim(a, b);
    await a.page.keyboard.down("f");
    const deadline = Date.now() + 3500;
    while (!hits(a, b).length && Date.now() < deadline) {
      await aim(a, b);
      await sleep(35);
    }
    await a.page.keyboard.up("f");
    await b.page.keyboard.up("d");
    await b.page.keyboard.up("Shift");
    assert.ok(
      hits(a, b).length,
      `moving bow target missed: ${JSON.stringify(stateOf(a, a.wire.id).lastCombat)}`,
    );
    const hit = hits(a, b)[0],
      record = a.wire.attacks.get(hit.seq);
    assert.ok(
      record?.input.view && record.atReceipt,
      "hit linked to observed input",
    );
    const seen = displayed(a.wire, b.wire.id, record),
      actual = record.atReceipt.players.find((p) => p.id === b.wire.id);
    assert.ok(
      Math.hypot(seen.x - actual.x, seen.z - actual.z) > 0.6,
      "target moved beyond its hitbox during delivery",
    );
    await sleep(600);
    assert.equal(stateOf(a, b.wire.id).health, stateOf(b, b.wire.id).health);
    assert.equal(stateOf(a, a.wire.id).arrows, stateOf(b, a.wire.id).arrows);
    assert.ok(stateOf(a, a.wire.id).arrows < 20);
    console.log(
      `PASS moving bow target at RTT 200/${targetRTT} ms, jitter ±${jitter} ms`,
    );

    await a.page.keyboard.press("1");
    await aim(a, b);
    await sleep(200);
    const distance = () => {
      const self = a.wire.prediction.player,
        target = displayed(a.wire, b.wire.id);
      return target
        ? Math.hypot(self.x - target.x, self.z - target.z)
        : Infinity;
    };
    await a.page.keyboard.down("Shift");
    await a.page.keyboard.down("w");
    const walkDeadline = Date.now() + 18000;
    while (distance() > 5 && Date.now() < walkDeadline) {
      await aim(a, b);
      await sleep(60);
    }
    await a.page.keyboard.up("Shift");
    await until(() => distance() < 2.4, "walking into sword range", 7000);
    await a.page.keyboard.up("w");
    await sleep(500);
    await aim(a, b);
    const self = a.wire.prediction.player,
      target = b.wire.prediction.player;
    await turn(b, Math.atan2(self.x - target.x, self.z - target.z));
    await sleep(300);
    const previousHits = hits(a, b).length;
    await b.page.keyboard.down("Shift");
    await b.page.keyboard.down("w");
    await sleep(180);
    await a.page.keyboard.press("f");
    await until(
      () => hits(a, b).length > previousHits,
      "sword hits displayed fleeing opponent",
      3000,
    );
    await b.page.keyboard.up("w");
    await b.page.keyboard.up("Shift");
    await sleep(500);
    assert.equal(stateOf(a, b.wire.id).health, stateOf(b, b.wire.id).health);
    assert.equal(stateOf(a, a.wire.id).kills, stateOf(b, a.wire.id).kills);
    assert.deepEqual(errors, []);
    console.log(
      `PASS fleeing sword target at RTT 200/${targetRTT} ms; both clients agree`,
    );
  } catch (error) {
    console.error(
      "Latency combat state",
      JSON.stringify({ a: a.wire.state, b: b.wire.state, input: a.wire.input }),
    );
    throw error;
  } finally {
    await a.context.close();
    await b.context.close();
  }
}

(async () => {
  const browser = await chromium.launch({
    headless: true,
    channel: "chromium",
    args:
      process.platform === "darwin"
        ? ["--use-angle=metal"]
        : ["--enable-unsafe-swiftshader"],
  });
  try {
    await scenario(browser, 200, 0);
    await scenario(browser, 100, 8);
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

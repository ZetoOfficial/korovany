/* Two browser clients use only real UI input and the public network protocol. */
const assert = require("node:assert/strict");
const { chromium } = require("playwright");
const url = process.env.ASTRA_URL || "http://127.0.0.1:8080/";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ballisticPitch = (a, b) => {
  const distance = Math.hypot(a.x - b.x, a.z - b.z);
  const rise = b.y + 1.2 - (a.y + 1.8),
    speed = 28,
    gravity = 12;
  return Math.atan(
    (speed ** 2 -
      Math.sqrt(
        speed ** 4 -
          gravity * (gravity * distance ** 2 + 2 * rise * speed ** 2),
      )) /
      (gravity * distance),
  );
};
async function chargedShot(client, mouse = false) {
  if (mouse) await client.page.mouse.down();
  else await client.page.keyboard.down("e");
  await until(
    () =>
      client.wire.state.players.find((p) => p.id === client.wire.id)
        .bowDrawTicks === 60,
    "full bow draw",
  );
  if (process.env.KOROVANY_SCREENSHOT)
    await client.page.screenshot({ path: process.env.KOROVANY_SCREENSHOT });
  if (mouse) await client.page.mouse.up();
  else await client.page.keyboard.up("e");
}

async function until(condition, label, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (condition()) return;
    await sleep(25);
  }
  throw new Error(`Timed out: ${label}`);
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
    const errors = [];
    async function client(name) {
      const context = await browser.newContext({
        viewport: { width: 960, height: 720 },
      });
      // Exercise the supported drag-look fallback consistently across headless
      // platforms. Pointer-lock acquisition changes synthetic mouse deltas on
      // Linux; gameplay and input still go through the actual UI and server.
      await context.addInitScript(() => {
        HTMLCanvasElement.prototype.requestPointerLock = () =>
          Promise.reject(
            new DOMException(
              "Pointer lock unavailable in this test",
              "NotSupportedError",
            ),
          );
      });
      const page = await context.newPage();
      const wire = { id: "", state: null, welcomes: 0, server: null };
      page.on("pageerror", (error) => errors.push(error.message));
      await page.routeWebSocket("**/ws/*", (socket) => {
        const server = (wire.server = socket.connectToServer());
        server.onMessage((payload) => {
          const message = JSON.parse(payload.toString());
          if (message.type === "welcome") {
            wire.id = message.id;
            wire.state = message.snapshot;
            wire.welcomes++;
          }
          if (message.type === "snapshot") wire.state = message;
          socket.send(payload);
        });
      });
      await page.goto(new URL("arena/", url).href);
      assert.equal(
        await page.locator("a").first().getAttribute("href"),
        new URL(url).pathname,
      );
      await page.locator("#name").fill(name);
      return { context, page, wire };
    }

    const a = await client("Эльф"),
      b = await client("Страж");
    await a.page.locator("#create").click();
    await a.page.locator("#hud").waitFor({ state: "visible" });
    const room = await a.page.locator("#room-label").textContent();
    assert.equal(
      new URL(a.page.url()).pathname,
      new URL("arena/", url).pathname,
    );
    await b.page.locator("#room-code").fill(room);
    await b.page.locator("#join").click();
    await until(
      () =>
        a.wire.state?.phase === "playing" && b.wire.state?.phase === "playing",
      "round starts for both clients",
    );
    assert.equal(await a.page.locator("#player-count").textContent(), "2 / 8");
    for (const client of [a, b]) {
      await client.page.locator("#menu-button").click();
      await client.page.locator("#low-quality").check();
      await client.page.locator("#resume").click();
    }
    console.log("PASS two browsers join a room and start the same match");

    // Aim through real mouse input using the public positions. Spawn headings
    // point down the courtyard but are not exact enough for an arrow at 50 m.
    await a.page.bringToFront();
    await a.page.keyboard.press("2");
    await until(
      () => a.wire.state.players.find((p) => p.id === a.wire.id).weapon === 2,
      "bow equipped",
    );
    await a.page.locator("#weapon-name").filter({ hasText: "ЛУК" }).waitFor();
    await a.page.mouse.move(480, 360);
    await a.page.mouse.down({ button: "right" });
    const archer = a.wire.state.players.find((p) => p.id === a.wire.id);
    const mark = a.wire.state.players.find((p) => p.id === b.wire.id);
    const aimYaw = Math.atan2(archer.x - mark.x, archer.z - mark.z);
    const yawDelta = Math.atan2(
      Math.sin(archer.yaw - aimYaw),
      Math.cos(archer.yaw - aimYaw),
    );
    await a.page.mouse.move(
      480 + Math.round(yawDelta / 0.0022),
      360 - Math.round((ballisticPitch(archer, mark) - archer.pitch) / 0.0022),
    );
    await a.page.mouse.up({ button: "right" });
    await until(
      () =>
        Math.abs(
          a.wire.state.players.find((p) => p.id === a.wire.id).yaw - aimYaw,
        ) < 0.004,
      "mouse aim reaches the server",
    );
    if (process.env.KOROVANY_SCREENSHOT)
      await a.page.screenshot({ path: process.env.KOROVANY_SCREENSHOT });
    // A tap must not spend ammo; a held button must not auto-fire.
    await a.page.mouse.click(480, 360);
    await sleep(250);
    assert.equal(
      a.wire.state.players.find((p) => p.id === a.wire.id).arrows,
      20,
    );
    await a.page.keyboard.down("e");
    await until(
      () =>
        a.wire.state.players.find((p) => p.id === a.wire.id).bowDrawTicks >= 20,
      "draw before menu",
    );
    await a.page.keyboard.press("p");
    await a.page.keyboard.up("e");
    await a.page.locator("#pause").waitFor({ state: "visible" });
    await until(
      () =>
        a.wire.state.players.find((p) => p.id === a.wire.id).bowDrawTicks === 0,
      "menu cancels draw",
    );
    assert.equal(
      a.wire.state.players.find((p) => p.id === a.wire.id).arrows,
      20,
    );
    await a.page.locator("#resume").click();
    await chargedShot(a, true);
    await until(
      () =>
        b.wire.state.players.find((p) => p.id === b.wire.id).health === 66 &&
        a.wire.state.players.find((p) => p.id === a.wire.id).arrows === 19,
      "ranged hit reaches the other browser",
    ).catch((error) => {
      console.error(
        "Ranged combat state:",
        JSON.stringify(a.wire.state.players),
      );
      throw error;
    });
    assert.equal(
      a.wire.state.players.find((p) => p.id === a.wire.id).arrows,
      19,
    );
    assert.ok(
      a.wire.state.events.some(
        (event) => event.type === "arrow" && event.actor === a.wire.id,
      ),
    );
    await a.page.keyboard.press("1");
    await until(
      () => a.wire.state.players.find((p) => p.id === a.wire.id).weapon === 1,
      "sword re-equipped",
    );
    console.log(
      "PASS bow switches with 2, fires with the mouse and spends one arrow for a ranged hit",
    );

    // Observe public snapshots to stop the actual keyboard movement in melee range.
    // The two spawn headings point across the open diagonal of the courtyard.
    const fighters = () => [
      a.wire.state.players.find((p) => p.id === a.wire.id),
      a.wire.state.players.find((p) => p.id === b.wire.id),
    ];
    const distance = () => {
      const [p, q] = fighters();
      return Math.hypot(p.x - q.x, p.z - q.z);
    };
    const angleError = () => {
      const [p, q] = fighters();
      const angle = Math.atan2(p.x - q.x, p.z - q.z) - p.yaw;
      return Math.atan2(Math.sin(angle), Math.cos(angle));
    };
    await a.page.bringToFront();
    await a.page.keyboard.down("Shift");
    await a.page.keyboard.down("w");
    await until(
      () => distance() < 5,
      "player reaches opponent through real keyboard input",
      15000,
    );
    await a.page.keyboard.up("Shift");
    await until(() => distance() < 2.7, "walking into melee range");
    await a.page.keyboard.up("w");
    await sleep(300); // Allow already-sent movement commands to be acknowledged.
    if (Math.abs(angleError()) > 0.12) {
      const turn = angleError() > 0 ? "ArrowLeft" : "ArrowRight";
      await a.page.keyboard.down(turn);
      await until(
        () => Math.abs(angleError()) < 0.12,
        "turning toward the opponent",
        4000,
      );
      await a.page.keyboard.up(turn);
      await sleep(250);
    }
    assert.ok(
      distance() < 3.2 && Math.abs(angleError()) < 0.85,
      `not aimed at opponent: distance=${distance()}, angle=${angleError()}`,
    );
    await a.page.keyboard.down("e");
    await until(
      () => a.wire.state.players.find((p) => p.id === a.wire.id).kills === 1,
      "server confirms a melee kill",
      5000,
    ).catch((error) => {
      console.error("Combat state:", fighters());
      throw error;
    });
    await a.page.keyboard.up("e");
    await until(
      () => b.wire.state.players.find((p) => p.id === b.wire.id).health === 0,
      "victim receives authoritative death",
    );
    console.log("PASS movement, melee damage and kill agree across browsers");

    await a.page.keyboard.press("p");
    await a.page.locator("#pause").waitFor({ state: "visible" });
    const pausedTick = a.wire.state.tick;
    await until(
      () => a.wire.state.tick > pausedTick + 30,
      "menu leaves server running",
    );
    await until(
      () => b.wire.state.players.find((p) => p.id === b.wire.id).health === 100,
      "victim respawns",
      5000,
    );
    await a.page.keyboard.press("p");
    await a.page.locator("#pause").waitFor({ state: "hidden" });
    console.log(
      "PASS menu does not pause the match; death and respawn continue",
    );

    const id = b.wire.id;
    // Offline emulation does not consistently interrupt established WebSockets.
    // Close the actual upstream connection; the browser must recover on its own.
    await b.wire.server.close({
      code: 3001,
      reason: "Temporary test disconnect",
    });
    await until(() => b.wire.welcomes >= 2, "client reconnects", 12000);
    assert.equal(b.wire.id, id);
    assert.equal(b.wire.state.players.length, 2);
    console.log("PASS connection recovery keeps the same player and room");
    await a.page.keyboard.press("p");
    await a.page.locator("#leave").click();
    await a.page.locator("#lobby").waitFor({ state: "visible" });
    assert.equal(new URL(a.page.url()).search, "");
    assert.equal(
      new URL(a.page.url()).pathname,
      new URL("arena/", url).pathname,
    );
    assert.equal(await a.page.locator("#room-code").inputValue(), "");
    console.log("PASS leaving a room returns to a clean lobby");

    await a.page.locator("#create").click();
    await a.page.locator("#hud").waitFor({ state: "visible" });
    const trainingRoom = await a.page.locator("#room-label").textContent();
    await a.page.locator("#menu-button").click();
    assert.equal(await a.page.locator("#remove-dummies").isEnabled(), false);
    await a.page.locator("#add-dummy").click();
    await until(
      () =>
        a.wire.state?.phase === "playing" &&
        a.wire.state.players.some((p) => p.dummy),
      "a dummy starts a solo match",
    );
    await a.page.locator("#dummy-count").filter({ hasText: /^1$/ }).waitFor();
    const dummy = a.wire.state.players.find((p) => p.dummy);
    const dummyState = () =>
      a.wire.state.players.find((p) => p.id === dummy.id);
    await a.page.locator("#resume").click();
    await a.page.bringToFront();
    await a.page.keyboard.press("2");
    await until(
      () => a.wire.state.players.find((p) => p.id === a.wire.id).weapon === 2,
      "bow equipped for dummy practice",
    );
    const trainee = a.wire.state.players.find((p) => p.id === a.wire.id);
    const dummyYaw = Math.atan2(trainee.x - dummy.x, trainee.z - dummy.z);
    const turnToDummy = Math.atan2(
      Math.sin(trainee.yaw - dummyYaw),
      Math.cos(trainee.yaw - dummyYaw),
    );
    await a.page.mouse.move(480, 360);
    await a.page.mouse.down({ button: "right" });
    await a.page.mouse.move(
      480 + Math.round(turnToDummy / 0.0022),
      360 -
        Math.round((ballisticPitch(trainee, dummy) - trainee.pitch) / 0.0022),
    );
    await a.page.mouse.up({ button: "right" });
    await until(
      () =>
        Math.abs(
          a.wire.state.players.find((p) => p.id === a.wire.id).yaw - dummyYaw,
        ) < 0.004,
      "aim reaches the dummy",
    );
    await chargedShot(a, true);
    await until(() => dummyState().health === 66, "dummy receives bow damage");
    await a.page.locator("#players").filter({ hasText: "66 HP" }).waitFor();
    assert.equal(dummyState().x, dummy.x);
    assert.equal(dummyState().z, dummy.z);
    await chargedShot(a);
    await until(() => dummyState().health === 32, "second charged arrow hits");
    await chargedShot(a);
    await until(
      () =>
        dummyState().health === 0 &&
        a.wire.state.players.find((p) => p.id === a.wire.id).kills === 1,
      "dummy death counts as a kill",
    );
    await until(() => dummyState().health === 100, "dummy respawns");
    assert.equal(dummyState().x, dummy.x);
    assert.equal(dummyState().z, dummy.z);
    assert.equal(dummyState().life, dummy.life + 1);
    assert.equal(dummyState().attackTick, 0);
    console.log(
      "PASS solo dummy practice, visible health, bow damage, death and fixed respawn",
    );

    await b.page.locator("#menu-button").click();
    await b.page.locator("#leave").click();
    await b.page.locator("#room-code").fill(trainingRoom);
    await b.page.locator("#join").click();
    await until(
      () => b.wire.state.players.some((p) => p.id === dummy.id && p.dummy),
      "joining friend sees the existing dummy",
    );
    await a.page.locator("#menu-button").click();
    for (let count = 4; count <= 8; count++) {
      await a.page.locator("#add-dummy").click();
      await until(
        () => a.wire.state.players.length === count,
        "added dummy occupies a room slot",
      );
    }
    await until(
      () => b.wire.state.players.length === 8,
      "all dummies reach the other client",
    );
    await a.page.locator("#add-dummy:disabled").waitFor();
    await b.page.locator("#menu-button").click();
    await b.page.locator("#remove-dummies").click();
    await until(
      () =>
        [a, b].every(
          (c) =>
            c.wire.state.players.length === 2 &&
            c.wire.state.players.every((p) => !p.dummy),
        ),
      "another player removes dummies from both clients",
    );
    assert.equal(a.wire.state.phase, "playing");
    await a.page.locator("#remove-dummies:disabled").waitFor();
    assert.equal(await a.page.locator("#add-dummy").isEnabled(), true);
    console.log(
      "PASS shared dummy controls, room capacity and removal without interrupting human PvP",
    );
    assert.deepEqual(errors, []);
    console.log("PASS no browser JavaScript errors");
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

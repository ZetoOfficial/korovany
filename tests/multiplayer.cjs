/* Two browser clients use only real UI input and the public network protocol. */
const assert = require("node:assert/strict");
const { chromium } = require("playwright");
const url = process.env.ASTRA_URL || "http://127.0.0.1:8080/";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
    await a.page.mouse.move(480 + Math.round(yawDelta / 0.0022), 360);
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
    await a.page.mouse.down();
    await a.page.mouse.up();
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
    await a.page.keyboard.down("f");
    await until(
      () => a.wire.state.players.find((p) => p.id === a.wire.id).kills === 1,
      "server confirms a melee kill",
      5000,
    ).catch((error) => {
      console.error("Combat state:", fighters());
      throw error;
    });
    await a.page.keyboard.up("f");
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
    assert.deepEqual(errors, []);
    console.log("PASS no browser JavaScript errors");
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

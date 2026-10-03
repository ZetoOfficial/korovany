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
    args: ["--enable-unsafe-swiftshader"],
  });
  try {
    const errors = [];
    async function client(name) {
      const context = await browser.newContext({
        viewport: { width: 960, height: 720 },
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
      await page.locator("#name").fill(name);
      return { context, page, wire };
    }

    const a = await client("Эльф"),
      b = await client("Страж");
    await a.page.locator("#create").click();
    await a.page.locator("#hud").waitFor({ state: "visible" });
    const room = await a.page.locator("#room-label").textContent();
    await b.page.locator("#room-code").fill(room);
    await b.page.locator("#join").click();
    await until(
      () =>
        a.wire.state?.phase === "playing" && b.wire.state?.phase === "playing",
      "round starts for both clients",
    );
    assert.equal(await a.page.locator("#player-count").textContent(), "2 / 8");
    console.log("PASS two browsers join a room and start the same match");

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

    await a.page.locator("#menu-button").click();
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

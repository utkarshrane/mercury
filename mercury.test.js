"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const { io } = require("socket.io-client");
const { app, attach } = require("./server");
const mercury = require("./mercury-server");

test("the closest hand keeps the silver", () => {
  const drops = [{ x: 0.62, y: 0.5, vx: 0, vy: 0 }];
  const players = [
    { x: 0.66, y: 0.5, tx: 0.66, ty: 0.5, pulling: true, connected: true, inRound: true, score: 0 },
    { x: 0.2, y: 0.5, tx: 0.2, ty: 0.5, pulling: true, connected: true, inRound: true, score: 0 },
  ];
  mercury.step(drops, players, 0.05);
  assert.equal(players[0].score, 1);
  assert.equal(players[1].score, 0);
  assert.equal(drops.length, 1);
});

test("a held magnet draws the silver toward that hand", () => {
  const drops = [{ x: 0.5, y: 0.5, vx: 0, vy: 0 }];
  const players = [
    { x: 0.78, y: 0.5, tx: 0.78, ty: 0.5, pulling: true, connected: true, inRound: true, score: 0 },
  ];
  for (let i = 0; i < 30; i += 1) mercury.step(drops, players, 0.05);
  assert.ok(drops[0].x > 0.6);
});

test("two players share one bowl and only the host starts", async () => {
  process.env.MERCURY_COUNT_MS = "40";
  process.env.MERCURY_ROUND_MS = "5000";
  process.env.MERCURY_TICK_MS = "30";
  const server = http.createServer(app);
  const socketServer = attach(server);
  mercury.attachMercury(socketServer, server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/mercury`;
  const ada = io(url, { transports: ["websocket"] });
  const bo = io(url, { transports: ["websocket"] });
  const wait = (socket, event) => new Promise((resolve) => socket.once(event, resolve));
  const emit = (socket, event, payload = {}) => new Promise((resolve) => socket.emit(event, payload, resolve));
  try {
    await Promise.all([
      new Promise((resolve) => ada.on("connect", resolve)),
      new Promise((resolve) => bo.on("connect", resolve)),
    ]);
    const created = wait(ada, "world");
    const ack = await emit(ada, "createRoom", { name: "Ada" });
    assert.equal(ack.ok, true);
    const lobby = await created;
    assert.equal(lobby.players.length, 1);
    assert.equal(lobby.drops.length, 72);

    const joined = wait(bo, "world");
    const joinAck = await emit(bo, "joinRoom", { code: ack.code, name: "Bo" });
    assert.equal(joinAck.ok, true);
    const seen = await joined;
    assert.equal(seen.players.length, 2);

    const denied = await emit(bo, "start", {});
    assert.equal(denied.ok, false);

    const worlds = [];
    ada.on("world", (state) => worlds.push(state));
    const startAck = await emit(ada, "start", {});
    assert.equal(startAck.ok, true);
    const countdown = worlds.find((state) => state.status === "countdown") || await wait(ada, "world");
    assert.equal(countdown.status, "countdown");
    assert.equal(countdown.drops.length, mercury.DROPS * 2);

    const playing = worlds.find((state) => state.status === "playing") || await wait(ada, "world");
    assert.equal(playing.status, "playing");
    const held = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("silver never stuck")), 2000);
      const check = (state) => {
        const me = state.players.find((player) => player.id === state.you);
        if (state.status === "playing" && me && me.score > 0) {
          clearTimeout(timer);
          resolve(me.score);
        }
      };
      ada.on("world", check);
      check(playing);
    });
    ada.emit("input", { pulling: true, x: 0.5, y: 0.5 });
    assert.ok(await held > 0);
  } finally {
    ada.close();
    bo.close();
    mercury.resetMercury();
    socketServer.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

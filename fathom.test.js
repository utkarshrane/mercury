"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const { io } = require("socket.io-client");
const { app, attach } = require("./server");
const fathom = require("./fathom-server");

function diver(id, x, y) {
  return {
    id,
    x,
    y,
    ix: 0,
    iy: 0,
    air: 100,
    stun: 0,
    bell: null,
    banks: 0,
    stealLock: 0,
    connected: true,
    inRound: true,
  };
}

function roomWith(players) {
  const level = fathom.createLevel();
  return {
    grid: level.grid,
    bells: level.bells,
    hatch: level.hatch,
    players,
  };
}

test("every bell can be reached from the moon pool", () => {
  const level = fathom.createLevel();
  assert.equal(level.chart.length, fathom.ROWS);
  assert.ok(level.chart.every((row) => row.length === fathom.COLS));
  assert.equal(level.bells.length, 3);
  assert.equal(fathom.BANKS, 2);
});

test("rock stops a diver", () => {
  const room = roomWith([diver("a", 2.4, 4.5)]);
  room.players[0].ix = -1;
  for (let i = 0; i < 40; i += 1) fathom.step(room, 0.05);
  assert.ok(room.players[0].x > 1.3);
});

test("a diver picks up a bell by touching it", () => {
  const room = roomWith([diver("a", 0, 0)]);
  const bell = room.bells[0];
  room.players[0].x = bell.x;
  room.players[0].y = bell.y;
  fathom.step(room, 0.05);
  assert.equal(room.players[0].bell, bell.id);
  assert.equal(bell.carriedBy, "a");
});

test("touching a carrier takes the bell", () => {
  const room = roomWith([diver("a", 8, 8), diver("b", 8.2, 8)]);
  const bell = room.bells[0];
  bell.x = 8;
  bell.y = 8;
  bell.carriedBy = "a";
  room.players[0].bell = bell.id;
  fathom.step(room, 0.05);
  assert.equal(room.players[1].bell, bell.id);
  assert.equal(room.players[0].bell, null);
  assert.equal(bell.carriedBy, "b");
});

test("surfacing a bell at the moon pool banks it", () => {
  const room = roomWith([diver("a", 0, 0)]);
  const bell = room.bells[0];
  const player = room.players[0];
  player.x = room.hatch.x;
  player.y = room.hatch.y;
  player.bell = bell.id;
  bell.carriedBy = player.id;
  fathom.step(room, 0.05);
  assert.equal(player.banks, 1);
  assert.equal(player.bell, null);
  assert.equal(bell.banked, true);
});

test("running out of air drops the bell and returns you to the pool", () => {
  const room = roomWith([diver("a", 10.5, 12.5)]);
  const bell = room.bells[2];
  const player = room.players[0];
  player.x = bell.x;
  player.y = bell.y;
  player.bell = bell.id;
  bell.carriedBy = player.id;
  bell.x = player.x;
  bell.y = player.y;
  player.air = 0.2;
  fathom.step(room, 0.05);
  assert.equal(player.bell, null);
  assert.equal(bell.carriedBy, null);
  assert.ok(player.stun > 0);
  assert.ok(Math.hypot(player.x - room.hatch.x, player.y - room.hatch.y) < 2);
  assert.ok(Math.hypot(bell.x - room.hatch.x, bell.y - room.hatch.y) > 3);
});

test("two divers share a cave and only the host starts", async () => {
  process.env.FATHOM_COUNT_MS = "40";
  process.env.FATHOM_ROUND_MS = "4000";
  process.env.FATHOM_TICK_MS = "40";
  const server = http.createServer(app);
  const socketServer = attach(server);
  fathom.attachFathom(socketServer, server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/fathom`;
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
    assert.equal(lobby.bells.length, 3);
    assert.equal(lobby.chart.length, fathom.ROWS);

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
    const playing = worlds.find((state) => state.status === "playing") || await wait(ada, "world");
    assert.equal(playing.status, "playing");
    assert.equal(playing.players.length, 2);
  } finally {
    ada.close();
    bo.close();
    fathom.resetFathom();
    socketServer.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

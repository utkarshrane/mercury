"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const { io } = require("socket.io-client");
const { app, attach } = require("./server");
const bloom = require("./bloom-server");

test("painting over a cell gives it to the new player", () => {
  const grid = bloom.createGrid();
  const scores = bloom.createScores();
  const first = bloom.paintDisc(grid, scores, 1, 0.5, 0.5);
  assert.ok(first.length > 10);
  assert.equal(scores[1], first.length);
  const stolen = bloom.paintDisc(grid, scores, 2, 0.5, 0.5);
  assert.ok(stolen.length > 0);
  assert.equal(scores[1] + scores[2], first.length);
  assert.ok(scores[2] > scores[1]);
});

test("two players share one floor and only the host starts", async () => {
  process.env.BLOOM_COUNT_MS = "40";
  process.env.BLOOM_ROUND_MS = "5000";
  process.env.BLOOM_TICK_MS = "30";
  const server = http.createServer(app);
  const socketServer = attach(server);
  bloom.attachBloom(socketServer, server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/bloom`;
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

    const joinedAda = wait(ada, "world");
    const joinedBo = wait(bo, "world");
    const joinAck = await emit(bo, "joinRoom", { code: ack.code, name: "Bo" });
    assert.equal(joinAck.ok, true);
    const [seenAda, seenBo] = await Promise.all([joinedAda, joinedBo]);
    assert.equal(seenBo.players.length, 2);
    assert.equal(seenAda.code, ack.code);

    const denied = await emit(bo, "start", {});
    assert.equal(denied.ok, false);

    const worlds = [];
    ada.on("world", (state) => worlds.push(state));
    const gridBo = wait(bo, "grid");
    const startAck = await emit(ada, "start", {});
    assert.equal(startAck.ok, true);
    const cells = await gridBo;
    assert.equal(cells.length, bloom.CELLS);
    const countdown = worlds.find((state) => state.status === "countdown")
      || await wait(ada, "world");
    assert.equal(countdown.status, "countdown");
    assert.equal(countdown.players.length, 2);

    const playing = worlds.find((state) => state.status === "playing") || await wait(ada, "world");
    assert.equal(playing.status, "playing");
    const painted = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no paint")), 2000);
      ada.on("paint", (list) => {
        if (list.length) {
          clearTimeout(timer);
          resolve(list);
        }
      });
    });
    ada.emit("input", { x: 1, y: 0 });
    const list = await painted;
    assert.equal(list.length % 2, 0);
    assert.ok(list.length >= 2);
  } finally {
    ada.close();
    bo.close();
    bloom.resetBloom();
    socketServer.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

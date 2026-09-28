"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const { io } = require("socket.io-client");
const { app, attach } = require("./server");
const only = require("./only-server");

test("one fitting card scores and two fitting cards cancel", () => {
  const tea = { id: "tea", name: "Tea", tags: ["hot", "drink"] };
  const soup = { id: "soup", name: "Soup", tags: ["hot", "food"] };
  const wool = { id: "wool", name: "Wool", tags: ["soft"] };
  const single = only.judge([
    { playerId: "ada", card: tea },
    { playerId: "leo", card: null },
  ], "hot");
  assert.equal(single.awarded, "ada");
  const both = only.judge([
    { playerId: "ada", card: tea },
    { playerId: "leo", card: soup },
  ], "hot");
  assert.equal(both.awarded, null);
  assert.equal(both.cancelled, true);
  const miss = only.judge([
    { playerId: "ada", card: wool },
    { playerId: "leo", card: tea },
  ], "hot");
  assert.equal(miss.awarded, "leo");
});

test("a tense line is one both hands can answer", () => {
  const tag = only.chooseTag({
    ada: [{ tags: ["hot", "drink"] }, { tags: ["soft"] }],
    leo: [{ tags: ["hot", "food"] }, { tags: ["round"] }],
  });
  assert.equal(tag, "hot");
});

test("hands stay private and a stranger cannot start", async () => {
  process.env.ONLY_PLAY_MS = "600";
  process.env.ONLY_REVEAL_MS = "200";
  process.env.ONLY_ROUNDS = "1";
  const server = http.createServer(app);
  const socketServer = attach(server);
  only.attachOnly(socketServer, server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/only`;
  const ada = io(url, { transports: ["websocket"] });
  const leo = io(url, { transports: ["websocket"] });
  const wait = (socket, event) => new Promise((resolve) => socket.once(event, resolve));
  const until = (socket, pred) => new Promise((resolve) => {
    const onWorld = (state) => {
      if (!pred(state)) return;
      socket.off("world", onWorld);
      resolve(state);
    };
    socket.on("world", onWorld);
  });
  const emit = (socket, event, payload = {}) => new Promise((resolve) => socket.emit(event, payload, resolve));
  try {
    await Promise.all([
      new Promise((resolve) => ada.on("connect", resolve)),
      new Promise((resolve) => leo.on("connect", resolve)),
    ]);
    const created = wait(ada, "world");
    const ack = await emit(ada, "createRoom", { name: "Ada" });
    assert.equal(ack.ok, true);
    await created;
    const joined = wait(leo, "world");
    const joinAck = await emit(leo, "joinRoom", { code: ack.code, name: "Leo" });
    assert.equal(joinAck.ok, true);
    await joined;
    const denied = await emit(leo, "start", {});
    assert.equal(denied.ok, false);
    const adaPlay = until(ada, (state) => state.status === "play");
    const leoPlay = until(leo, (state) => state.status === "play");
    const startAck = await emit(ada, "start", {});
    assert.equal(startAck.ok, true);
    const play = await adaPlay;
    const leoView = await leoPlay;
    assert.equal(play.hand.length, 5);
    assert.equal(play.players.find((player) => player.name === "Leo").cards, 5);
    const adaKeys = new Set(play.hand.map((card) => card.key));
    assert.equal(leoView.hand.some((card) => adaKeys.has(card.key)), false);
    const fitting = play.hand.find((card) => card.fit);
    const revealed = until(ada, (state) => state.status === "reveal" || state.status === "result");
    if (fitting) {
      const wrong = await emit(ada, "choose", { card: fitting.key, round: 9 });
      assert.equal(wrong.ok, false);
      const chosen = await emit(ada, "choose", { card: fitting.key, round: play.round });
      assert.equal(chosen.ok, true);
    }
    const held = await emit(leo, "choose", { card: "hold" });
    assert.equal(held.ok, true);
    const shown = await revealed;
    if (fitting) assert.equal(shown.awarded, play.you);
  } finally {
    ada.close();
    leo.close();
    only.resetRooms();
    delete process.env.ONLY_ROUNDS;
    await new Promise((resolve) => server.close(resolve));
  }
});

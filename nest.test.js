"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const { io } = require("socket.io-client");
const { app, attach } = require("./server");
const nest = require("./nest-server");

test("two phones share the third chick and three phones each hold one", () => {
  const pair = nest.assignChicks(["ada", "leo"]);
  assert.deepEqual(pair.ada, ["pip", "lumen"]);
  assert.deepEqual(pair.leo, ["moth", "lumen"]);
  const trio = nest.assignChicks(["ada", "leo", "nia"]);
  assert.deepEqual(trio.ada, ["pip"]);
  assert.deepEqual(trio.leo, ["moth"]);
  assert.deepEqual(trio.nia, ["lumen"]);
});

test("only the owner can care, and warmth reaches the other chicks", () => {
  const meters = nest.freshMeters();
  const roles = nest.assignChicks(["ada", "leo"]);
  const cooldowns = {};
  const before = meters.moth.warm;
  const denied = nest.applyCare(meters, roles, cooldowns, "leo", "pip", "feed", 0);
  assert.equal(denied.ok, false);
  const cared = nest.applyCare(meters, roles, cooldowns, "ada", "pip", "warm", 0);
  assert.equal(cared.ok, true);
  assert.ok(meters.moth.warm > before);
  const cooling = nest.applyCare(meters, roles, cooldowns, "ada", "pip", "feed", 100);
  assert.equal(cooling.ok, false);
});

test("both phones see the numbers and a stranger cannot tap your chick", async () => {
  process.env.NEST_SHIFT_MS = "700";
  process.env.NEST_TICK_MS = "50";
  const meters = nest.freshMeters();
  meters.pip.rest = 20;
  const lifted = nest.applyCare(meters, { ada: ["pip"], leo: ["moth", "lumen"] }, {}, "ada", "pip", "rest", 0);
  assert.equal(lifted.ok, true);
  assert.equal(meters.pip.rest, 48);
  assert.equal(nest.toneFor(10), "bad");

  const server = http.createServer(app);
  const socketServer = attach(server);
  nest.attachNest(socketServer, server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/nest`;
  const ada = io(url, { transports: ["websocket"] });
  const leo = io(url, { transports: ["websocket"] });
  const wait = (socket, event) => new Promise((resolve) => socket.once(event, resolve));
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
    const started = wait(ada, "world");
    const startAck = await emit(ada, "start", {});
    assert.equal(startAck.ok, true);
    const shift = await started;
    assert.equal(shift.status, "shift");
    const pip = shift.chicks.find((item) => item.id === "pip");
    const moth = shift.chicks.find((item) => item.id === "moth");
    assert.equal(pip.mine, true);
    assert.equal(typeof pip.needs[0].value, "number");
    assert.equal(moth.mine, false);
    assert.equal(typeof moth.needs[0].value, "number");
    const stolen = await emit(leo, "care", { chick: "pip", need: "feed" });
    assert.equal(stolen.ok, false);
    const shared = shift.chicks.find((item) => item.id === "lumen");
    assert.equal(shared.shared, true);
    assert.equal(shared.mine, true);
    const helped = await emit(leo, "care", { chick: "lumen", need: "rest" });
    assert.equal(helped.ok, true);
  } finally {
    ada.close();
    leo.close();
    nest.resetRooms();
    await new Promise((resolve) => server.close(resolve));
  }
});

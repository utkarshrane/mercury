"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const { io } = require("socket.io-client");
const { app, attach } = require("./server");
const vital = require("./vital-server");

test("every phone together holds all four vitals", () => {
  for (const count of [2, 3, 4]) {
    const ids = Array.from({ length: count }, (_, index) => `p${index}`);
    const roles = vital.assignRoles(ids);
    const held = new Set(Object.values(roles).flat());
    assert.deepEqual([...held].sort(), ["bleed", "breath", "calm", "pulse"]);
    for (const id of ids) assert.ok(roles[id].length >= 1);
  }
});

test("treating a steady vital pulls the others down", () => {
  const meters = vital.freshMeters();
  const roles = vital.assignRoles(["ada", "leo"]);
  const cooldowns = {};
  const before = meters.pulse;
  const result = vital.applyCare(meters, roles, cooldowns, "ada", "breath", 1000);
  assert.equal(result.ok, true);
  assert.equal(result.overtreat, true);
  assert.ok(meters.pulse < before);
  assert.equal(meters.breath, vital.freshMeters().breath);
  const denied = vital.applyCare(meters, roles, cooldowns, "ada", "pulse", 2000);
  assert.equal(denied.ok, false);
});

test("a low vital can be lifted and the number stays on that phone", async () => {
  process.env.VITAL_NIGHT_MS = "600";
  process.env.VITAL_TICK_MS = "50";
  const meters = { breath: 40, pulse: 70, bleed: 70, calm: 70 };
  const roles = { ada: ["breath"], leo: ["pulse", "bleed", "calm"] };
  const cooldowns = {};
  const cared = vital.applyCare(meters, roles, cooldowns, "ada", "breath", 0);
  assert.equal(cared.overtreat, false);
  assert.equal(meters.breath, 70);
  assert.equal(vital.wordFor(30), "failing");
  assert.equal(vital.wordFor(80), "steady");

  const server = http.createServer(app);
  const socketServer = attach(server);
  vital.attachVital(socketServer, server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/vital`;
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
    const nights = [];
    ada.on("world", (state) => { if (state.status === "night") nights.push(state); });
    leo.on("world", (state) => { if (state.status === "night") nights.push(state); });
    const started = wait(ada, "world");
    const startAck = await emit(ada, "start", {});
    assert.equal(startAck.ok, true);
    const night = await started;
    assert.equal(night.status, "night");
    const breath = night.vitals.find((item) => item.id === "breath");
    const pulse = night.vitals.find((item) => item.id === "pulse");
    assert.equal(typeof breath.value, "number");
    assert.equal(Object.hasOwn(pulse, "value"), false);
    const leoNight = nights.find((state) => state.you !== night.you) || await wait(leo, "world");
    const leoBreath = leoNight.vitals.find((item) => item.id === "breath");
    assert.equal(leoBreath.mine, false);
    assert.equal(Object.hasOwn(leoBreath, "value"), false);
    const care = await emit(ada, "care", { vital: "breath" });
    assert.equal(care.ok, true);
    const result = nights.find((state) => state.status === "result") || await wait(ada, "world");
    assert.equal(result.status === "night" || result.status === "result", true);
  } finally {
    ada.close();
    leo.close();
    vital.resetRooms();
    await new Promise((resolve) => server.close(resolve));
    delete process.env.VITAL_NIGHT_MS;
    delete process.env.VITAL_TICK_MS;
  }
});

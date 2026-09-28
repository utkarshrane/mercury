"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const { io } = require("socket.io-client");
const rules = require("./rules");
const { app, attach, resetRooms } = require("./server");

let server;
let socketServer;
let url;

function connect() {
  return new Promise((resolve, reject) => {
    const socket = io(url, { transports: ["websocket"] });
    socket.on("connect", () => resolve(socket));
    socket.on("connect_error", reject);
  });
}

function emit(socket, event, payload = {}) {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

function nextState(socket) {
  return new Promise((resolve) => socket.once("state", resolve));
}

test.before(async () => {
  process.env.CALLIT_TURN_MS = "600000";
  process.env.CALLIT_REVEAL_MS = "600000";
  server = http.createServer(app);
  socketServer = attach(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  resetRooms();
  socketServer.close();
  await new Promise((resolve) => server.close(resolve));
  rules.setRoll(null);
});

test("two players share a table, hide their dice, and resolve a true bid", async () => {
  rules.setRoll(() => 6);
  const asha = await connect();
  const noah = await connect();
  try {
    const created = nextState(asha);
    const createAck = await emit(asha, "createRoom", { name: "Asha" });
    assert.equal(createAck.ok, true);
    const lobbyA = await created;
    assert.equal(lobbyA.code, createAck.code);
    assert.equal(lobbyA.players.length, 1);

    const joinedA = nextState(asha);
    const joinedN = nextState(noah);
    const joinAck = await emit(noah, "joinRoom", { code: createAck.code, name: "Noah" });
    assert.equal(joinAck.ok, true);
    await Promise.all([joinedA, joinedN]);

    const denied = await emit(noah, "startGame", {});
    assert.equal(denied.ok, false);

    const dealtA = nextState(asha);
    const dealtN = nextState(noah);
    const startAck = await emit(asha, "startGame", {});
    assert.equal(startAck.ok, true);
    const [viewA, viewN] = await Promise.all([dealtA, dealtN]);

    assert.equal(viewA.status, "playing");
    assert.deepEqual(viewA.players.find((player) => player.id === viewA.you).dice, [6, 6, 6, 6, 6]);
    const hiddenFromNoah = viewN.players.find((player) => player.id !== viewN.you);
    assert.equal(hiddenFromNoah.dice, null);
    assert.equal(hiddenFromNoah.diceCount, 5);
    assert.equal(viewN.players.filter((player) => player.dice && player.dice.length === 5).length, 1);

    const openerIsAsha = viewA.turnPlayerId === viewA.you;
    const opener = openerIsAsha ? asha : noah;
    const other = openerIsAsha ? noah : asha;
    const openerView = openerIsAsha ? viewA : viewN;

    const wrong = await emit(other, "raise", { qty: 2, face: 2 });
    assert.equal(wrong.ok, false);

    const tooHigh = await emit(opener, "raise", { qty: 11, face: 6 });
    assert.equal(tooHigh.ok, false);

    const bidA = nextState(asha);
    const bidN = nextState(noah);
    const bidAck = await emit(opener, "raise", { qty: 10, face: 6 });
    assert.equal(bidAck.ok, true);
    const [afterA, afterN] = await Promise.all([bidA, bidN]);
    assert.equal(afterA.bid.qty, 10);
    assert.equal(afterA.bid.face, 6);
    assert.equal(afterA.turnPlayerId, openerView.you === afterA.you ? afterN.you : afterA.you);
    assert.equal(afterN.players.find((player) => player.id !== afterN.you).dice, null);

    const revealA = nextState(asha);
    const revealN = nextState(noah);
    const callAck = await emit(other, "call", {});
    assert.equal(callAck.ok, true);
    const [shownA, shownN] = await Promise.all([revealA, revealN]);
    assert.equal(shownA.status, "reveal");
    assert.equal(shownA.reveal.holds, true);
    assert.equal(shownA.reveal.count, 10);
    const callerId = openerIsAsha ? viewN.you : viewA.you;
    assert.equal(shownA.reveal.loserId, callerId);
    assert.equal(shownN.players.find((player) => player.id === callerId).diceCount, 4);
    assert.equal(shownN.players.find((player) => player.id !== callerId).diceCount, 5);
    assert.ok(Array.isArray(shownA.players.find((player) => player.id !== shownA.you).dice));

    const nextA = nextState(asha);
    const nextN = nextState(noah);
    await emit(asha, "continue", {});
    const [roundA] = await Promise.all([nextA, nextN]);
    assert.equal(roundA.round, 2);
    assert.equal(roundA.turnPlayerId, callerId);
    assert.equal(roundA.status, "playing");
    assert.equal(roundA.players.find((player) => player.id !== roundA.you).dice, null);
  } finally {
    asha.close();
    noah.close();
    rules.setRoll(null);
    resetRooms();
  }
});

test("a bluff fails when the table does not have the bid", async () => {
  rules.setRoll(() => 2);
  const ada = await connect();
  const bo = await connect();
  try {
    const createAck = await emit(ada, "createRoom", { name: "Ada" });
    const joinedAda = nextState(ada);
    const joinedBo = nextState(bo);
    await emit(bo, "joinRoom", { code: createAck.code, name: "Bo" });
    await Promise.all([joinedAda, joinedBo]);
    const dealtAda = nextState(ada);
    const dealtBo = nextState(bo);
    await emit(ada, "startGame", {});
    const [viewAda, viewBo] = await Promise.all([dealtAda, dealtBo]);
    assert.equal(viewAda.status, "playing");
    assert.equal(viewBo.status, "playing");
    assert.equal(viewBo.players.find((player) => player.id !== viewBo.you).dice, null);
    assert.ok(viewAda.turnPlayerId);
    const opener = viewAda.turnPlayerId === viewAda.you ? ada : bo;
    const other = opener === ada ? bo : ada;
    const openerId = viewAda.turnPlayerId;

    const raisedAda = nextState(ada);
    const raisedBo = nextState(bo);
    const bidAck = await emit(opener, "raise", { qty: 3, face: 1 });
    assert.equal(bidAck.ok, true);
    await Promise.all([raisedAda, raisedBo]);

    const revealAda = nextState(ada);
    const revealBo = nextState(bo);
    const callAck = await emit(other, "call", {});
    assert.equal(callAck.ok, true);
    const [shown] = await Promise.all([revealAda, revealBo]);
    assert.equal(shown.reveal.holds, false);
    assert.equal(shown.reveal.count, 0);
    assert.equal(shown.reveal.loserId, openerId);
    assert.equal(shown.players.find((player) => player.id === openerId).diceCount, 4);
  } finally {
    ada.close();
    bo.close();
    rules.setRoll(null);
    resetRooms();
  }
});

test("an unknown code is rejected", async () => {
  const solo = await connect();
  try {
    const ack = await emit(solo, "joinRoom", { code: "ZZZZ", name: "Sam" });
    assert.equal(ack.ok, false);
  } finally {
    solo.close();
    resetRooms();
  }
});

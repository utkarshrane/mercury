"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const { io } = require("socket.io-client");
const { app, attach } = require("./server");
const keyhole = require("./keyhole-server");

function seenZones(round) {
  const seen = new Set();
  for (const blind of Object.values(round.blinds)) {
    for (const beat of keyhole.visibleBeats(round.beats, blind)) seen.add(beat.zone);
  }
  return [...seen].sort();
}

test("every phone hides a different slice and together they see the whole room", () => {
  for (const count of [2, 3, 4, 5, 6]) {
    const ids = Array.from({ length: count }, (_, index) => `p${index}`);
    for (let roundIndex = 0; roundIndex < 4; roundIndex += 1) {
      const round = keyhole.buildRound(ids, 1000 + count * 10 + roundIndex, roundIndex);
      assert.equal(round.beats.length, 4);
      assert.equal(round.questions.length, 3);
      assert.deepEqual(seenZones(round), ["door", "shelf", "table", "window"]);
      for (const question of round.questions) {
        assert.equal(question.choices.length, 3);
        assert.equal(new Set(question.choices).size, 3);
        assert.ok(question.answer >= 0 && question.answer < 3);
        const beat = round.beats.find((item) => item.zone === question.zone);
        assert.equal(question.choices[question.answer], beat.label);
      }
      const ada = keyhole.visibleBeats(round.beats, round.blinds[ids[0]]);
      for (const beat of ada) assert.equal(round.blinds[ids[0]].includes(beat.zone), false);
    }
  }
});

test("an answer locks only when two people tap the same choice", () => {
  const round = keyhole.buildRound(["ada", "leo"], 42, 0);
  const locks = {};
  const question = round.questions[0];
  const first = keyhole.applyPick(round, locks, "ada", question.id, 0);
  assert.equal(first.ok, true);
  assert.equal(first.locked, false);
  const same = keyhole.applyPick(round, locks, "ada", question.id, 1);
  assert.equal(same.locked, false);
  const second = keyhole.applyPick(round, locks, "leo", question.id, 1);
  assert.equal(second.locked, true);
  assert.equal(locks[question.id], 1);
  const late = keyhole.applyPick(round, locks, "ada", question.id, 0);
  assert.equal(late.ok, false);
});

test("the person who saw the moment scores more than the person who agreed", () => {
  const round = keyhole.buildRound(["ada", "leo"], 7, 0);
  const question = round.questions[0];
  const locks = {};
  keyhole.applyPick(round, locks, "ada", question.id, question.answer);
  keyhole.applyPick(round, locks, "leo", question.id, question.answer);
  const adaSaw = !round.blinds.ada.includes(question.zone);
  const scored = keyhole.scoreRound(
    [{ id: "ada", name: "Ada" }, { id: "leo", name: "Leo" }],
    round,
    locks,
  );
  assert.equal(scored.agreed, 1);
  assert.equal(scored.detail[0].ok, true);
  const adaPoints = adaSaw ? 2 : 1;
  const leoPoints = adaSaw ? 1 : 2;
  assert.equal(scored.gain.ada, adaPoints);
  assert.equal(scored.gain.leo, leoPoints);
  assert.notEqual(scored.gain.ada, scored.gain.leo);
});

test("two phones share one evening and a hidden slice stays hidden", async () => {
  process.env.KEYHOLE_WATCH_MS = "40";
  process.env.KEYHOLE_ASK_MS = "2500";
  process.env.KEYHOLE_REVEAL_MS = "40";
  process.env.KEYHOLE_ROUNDS = "1";
  const server = http.createServer(app);
  const socketServer = attach(server);
  keyhole.attachKeyhole(socketServer, server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/keyhole`;
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
    const lobby = await created;
    assert.equal(lobby.status, "lobby");
    assert.equal(lobby.players.length, 1);

    const joinedAda = wait(ada, "world");
    const joinedLeo = wait(leo, "world");
    const joinAck = await emit(leo, "joinRoom", { code: ack.code, name: "Leo" });
    assert.equal(joinAck.ok, true);
    const [seenAda, seenLeo] = await Promise.all([joinedAda, joinedLeo]);
    assert.equal(seenLeo.players.length, 2);
    assert.equal(seenAda.code, ack.code);

    const denied = await emit(leo, "start", {});
    assert.equal(denied.ok, false);

    const adaWorlds = [];
    const leoWorlds = [];
    ada.on("world", (state) => adaWorlds.push(state));
    leo.on("world", (state) => leoWorlds.push(state));
    const startAck = await emit(ada, "start", {});
    assert.equal(startAck.ok, true);

    const askAda = adaWorlds.find((state) => state.status === "ask") || await wait(ada, "world");
    const askLeo = leoWorlds.find((state) => state.status === "ask") || await wait(leo, "world");
    assert.equal(askAda.status, "ask");
    assert.equal(askLeo.status, "ask");
    assert.equal(askAda.questions.length, 3);
    assert.equal(Object.hasOwn(askAda.questions[0], "answer"), false);
    const zones = new Set([...askAda.beats, ...askLeo.beats].map((beat) => beat.zone));
    assert.equal(zones.size, 4);
    assert.notDeepEqual(askAda.beats.map((beat) => beat.zone).sort(), askLeo.beats.map((beat) => beat.zone).sort());
    const hiddenLabels = askAda.hidden.map((item) => item.zone);
    for (const beat of askAda.beats) assert.equal(hiddenLabels.includes(beat.zone), false);

    const question = askAda.questions[0];
    const picked = wait(ada, "world");
    await emit(ada, "pick", { questionId: question.id, choice: 0 });
    await emit(leo, "pick", { questionId: question.id, choice: 0 });
    const locked = await picked;
    const found = locked.questions.find((item) => item.id === question.id) || askAda;
    const after = adaWorlds.find((state) => state.questions.some((item) => item.id === question.id && item.lock === 0)) || found;
    assert.equal(after.questions.find((item) => item.id === question.id).lock, 0);

    const revealed = adaWorlds.find((state) => state.status === "reveal") || await wait(ada, "world");
    assert.equal(revealed.status === "reveal" || revealed.status === "gallery", true);
    const reviewState = revealed.status === "reveal"
      ? revealed
      : adaWorlds.find((state) => state.review);
    if (reviewState && reviewState.review) {
      assert.equal(reviewState.review.detail.length, 3);
      assert.equal(reviewState.beats.length, 4);
    }

    const gallery = adaWorlds.find((state) => state.status === "gallery") || await wait(ada, "world");
    assert.equal(gallery.status, "gallery");
    assert.ok(gallery.verdict && gallery.verdict.line);
    assert.equal(gallery.players.length, 2);
  } finally {
    ada.close();
    leo.close();
    keyhole.resetRooms();
    await new Promise((resolve) => server.close(resolve));
    delete process.env.KEYHOLE_WATCH_MS;
    delete process.env.KEYHOLE_ASK_MS;
    delete process.env.KEYHOLE_REVEAL_MS;
    delete process.env.KEYHOLE_ROUNDS;
  }
});

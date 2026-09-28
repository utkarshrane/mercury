"use strict";

const crypto = require("crypto");
const os = require("os");

const MAX_PLAYERS = 6;
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const COLORS = ["#e23d2b", "#f0c14d", "#7eb8c9", "#d4789a", "#8fbf7a", "#c48b5a"];
const ZONES = ["door", "table", "window", "shelf"];
const ZONE_LABEL = {
  door: "the door",
  table: "the table",
  window: "the window",
  shelf: "the shelf",
};
const PROMPT = {
  door: "Who came through the door?",
  table: "What was set on the table?",
  window: "What appeared at the window?",
  shelf: "What changed on the shelf?",
};
const POOLS = {
  door: [
    { token: "red", label: "Woman in red" },
    { token: "blue", label: "Man in blue" },
    { token: "yellow", label: "Child in yellow" },
    { token: "green", label: "Courier in green" },
  ],
  table: [
    { token: "cup", label: "Teacup" },
    { token: "letter", label: "Letter" },
    { token: "orange", label: "Orange" },
    { token: "key", label: "Brass key" },
    { token: "candle", label: "Candle" },
  ],
  window: [
    { token: "rain", label: "Rain" },
    { token: "bicycle", label: "A bicycle" },
    { token: "moon", label: "The moon" },
    { token: "cat", label: "A white cat" },
  ],
  shelf: [
    { token: "book", label: "A book falls" },
    { token: "three", label: "Clock shows 3" },
    { token: "seven", label: "Clock shows 7" },
    { token: "eleven", label: "Clock shows 11" },
    { token: "plant", label: "The plant is watered" },
    { token: "photo", label: "A photo turns down" },
  ],
};
const SPLITS = [
  ["door", "window"],
  ["table", "shelf"],
  ["door", "table"],
  ["window", "shelf"],
];

const rooms = new Map();
const socketRoom = new Map();

function watchMs() {
  const n = Number(process.env.KEYHOLE_WATCH_MS);
  return Number.isFinite(n) && n > 0 ? n : 9000;
}

function askMs() {
  const n = Number(process.env.KEYHOLE_ASK_MS);
  return Number.isFinite(n) && n > 0 ? n : 20000;
}

function revealMs() {
  const n = Number(process.env.KEYHOLE_REVEAL_MS);
  return Number.isFinite(n) && n > 0 ? n : 7000;
}

function roundsInMatch() {
  const n = Number(process.env.KEYHOLE_ROUNDS);
  return Number.isFinite(n) && n > 0 ? Math.min(8, Math.floor(n)) : 4;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(list, rand) {
  const copy = list.slice();
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    const swap = copy[i];
    copy[i] = copy[j];
    copy[j] = swap;
  }
  return copy;
}

function cleanName(name) {
  return String(name || "")
    .replace(/[\u0000-\u001F]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 16);
}

function cleanCode(code) {
  return String(code || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 4);
}

function makeCode() {
  const bytes = crypto.randomBytes(4);
  let code = "";
  for (const byte of bytes) code += ALPHABET[byte % ALPHABET.length];
  return rooms.has(code) ? makeCode() : code;
}

function rankIp(ip) {
  if (ip.startsWith("192.168.")) return 0;
  if (ip.startsWith("10.")) return 1;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)) return 2;
  return 3;
}

function lanOrigins(port) {
  const found = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list || []) {
      const v4 = net.family === "IPv4" || net.family === 4;
      if (v4 && !net.internal) found.push(net.address);
    }
  }
  found.sort((a, b) => rankIp(a) - rankIp(b) || a.localeCompare(b));
  const best = found[0];
  return best ? [`http://${best}:${port}`] : [];
}

function assignBlinds(ids, roundIndex) {
  const blinds = {};
  const round = roundIndex || 0;
  const primary = round % 2 === 0 ? 0 : 2;
  const flip = Math.floor(round / 2) % 2;
  const extra = (primary + 2) % 4;
  ids.forEach((id, index) => {
    const slot = index < 2 ? primary + ((index + flip) % 2) : extra + (index % 2);
    blinds[id] = SPLITS[slot].slice();
  });
  return blinds;
}

function visibleBeats(beats, blind) {
  const hidden = new Set(blind || []);
  return beats.filter((beat) => !hidden.has(beat.zone));
}

function buildRound(ids, seed, roundIndex) {
  const rand = mulberry32(seed);
  const blinds = assignBlinds(ids, roundIndex || 0);
  const times = [0.9, 2.8, 4.7, 6.5];
  const ordered = shuffle(ZONES, rand);
  const beats = ordered.map((zone, index) => {
    const pool = shuffle(POOLS[zone], rand);
    const chosen = pool[0];
    return { zone, t: times[index], token: chosen.token, label: chosen.label };
  });
  beats.sort((a, b) => a.t - b.t);
  const asked = shuffle(ZONES, rand).slice(0, 3);
  const questions = asked.map((zone, index) => {
    const beat = beats.find((item) => item.zone === zone);
    const others = POOLS[zone].filter((item) => item.token !== beat.token);
    const choices = shuffle([beat, ...shuffle(others, rand).slice(0, 2)], rand);
    return {
      id: `q${index}`,
      zone,
      prompt: PROMPT[zone],
      choices: choices.map((item) => item.label),
      answer: choices.findIndex((item) => item.token === beat.token),
    };
  });
  return { seed, blinds, beats, questions, picks: {} };
}

function applyPick(round, locks, playerId, questionId, choice) {
  const question = round.questions.find((item) => item.id === questionId);
  if (!question) return { ok: false, error: "That question has closed." };
  if (Object.prototype.hasOwnProperty.call(locks, questionId)) {
    return { ok: false, error: "That answer is already locked." };
  }
  if (!Number.isInteger(choice) || choice < 0 || choice >= question.choices.length) {
    return { ok: false, error: "Pick one of the choices." };
  }
  if (!round.picks[questionId]) round.picks[questionId] = {};
  round.picks[questionId][playerId] = choice;
  const tally = new Map();
  for (const value of Object.values(round.picks[questionId])) {
    tally.set(value, (tally.get(value) || 0) + 1);
    if (tally.get(value) >= 2) {
      locks[questionId] = value;
      break;
    }
  }
  return { ok: true, locked: Object.prototype.hasOwnProperty.call(locks, questionId) };
}

function scoreRound(players, round, locks) {
  const gain = {};
  for (const player of players) gain[player.id] = 0;
  const detail = [];
  let agreed = 0;
  for (const question of round.questions) {
    const locked = Object.prototype.hasOwnProperty.call(locks, question.id) ? locks[question.id] : null;
    const ok = locked === question.answer;
    if (ok) agreed += 1;
    const credited = [];
    if (ok) {
      const picks = round.picks[question.id] || {};
      for (const player of players) {
        if (picks[player.id] !== locked) continue;
        const saw = !(round.blinds[player.id] || []).includes(question.zone);
        const points = saw ? 2 : 1;
        gain[player.id] = (gain[player.id] || 0) + points;
        credited.push({ id: player.id, name: player.name, points, saw });
      }
    }
    detail.push({
      id: question.id,
      prompt: question.prompt,
      locked,
      lockedLabel: locked == null ? null : question.choices[locked],
      answerLabel: question.choices[question.answer],
      ok,
      credited,
    });
  }
  return { agreed, detail, gain };
}

function reply(ack, payload) {
  if (typeof ack === "function") ack(payload);
}

function attachKeyhole(io, httpServer) {
  const nsp = io.of("/keyhole");

  function portOf() {
    const address = httpServer.address();
    return address && typeof address === "object" ? address.port : 0;
  }

  function arm(room, ms, fn) {
    clearTimeout(room.phaseTimer);
    room.token = (room.token || 0) + 1;
    const token = room.token;
    room.phaseTimer = setTimeout(() => {
      if (!rooms.has(room.code) || room.token !== token) return;
      fn();
    }, ms);
  }

  function phase(room, status, ms) {
    room.status = status;
    room.length = ms;
    room.endsAt = Date.now() + ms;
  }

  function living(room) {
    return room.players.filter((player) => player.connected);
  }

  function ensureHost(room) {
    const host = room.players.find((player) => player.id === room.hostId && player.connected);
    if (host) return;
    const next = room.players.find((player) => player.connected) || room.players[0];
    room.hostId = next ? next.id : null;
  }

  function destroy(room) {
    clearTimeout(room.phaseTimer);
    rooms.delete(room.code);
  }

  function emitWorld(room) {
    if (!rooms.has(room.code)) return;
    for (const player of room.players) {
      if (!player.socketId) continue;
      const socket = nsp.sockets.get(player.socketId);
      if (socket) socket.emit("world", worldFor(room, player.id));
    }
  }

  function verdictFor(room) {
    const ranked = room.players
      .filter((player) => player.connected || player.score)
      .slice()
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    const possible = room.asked || roundsInMatch() * 3;
    if (!room.evening) {
      return { line: "Nothing was agreed. The dark kept the evening.", evening: 0, possible };
    }
    const top = ranked[0];
    const tied = top ? ranked.filter((player) => player.score === top.score && player.score > 0) : [];
    if (!top || !top.score) {
      return { line: "You agreed, and still the evening kept its favorite details.", evening: room.evening, possible };
    }
    if (tied.length > 1) {
      return {
        line: `${tied.map((player) => player.name).join(" and ")} kept the evening together.`,
        evening: room.evening,
        possible,
      };
    }
    return { line: `${top.name} kept the clearest eye.`, evening: room.evening, possible };
  }

  function worldFor(room, viewerId) {
    const viewer = room.players.find((player) => player.id === viewerId);
    const scene = room.scene;
    const inPlay = room.status === "watch" || room.status === "ask" || room.status === "reveal";
    const waiting = Boolean(viewer && inPlay && !viewer.inRound);
    const hidden = !waiting && scene && viewer ? scene.blinds[viewer.id] || [] : [];
    const showAll = room.status === "reveal";
    const beats = !scene || waiting ? [] : visibleBeats(scene.beats, showAll ? [] : hidden);
    let questions = [];
    if (!waiting && scene && (room.status === "ask" || room.status === "reveal")) {
      questions = scene.questions.map((question) => {
        const picks = scene.picks[question.id] || {};
        return {
          id: question.id,
          zone: question.zone,
          prompt: question.prompt,
          choices: question.choices,
          lock: Object.prototype.hasOwnProperty.call(room.locks, question.id) ? room.locks[question.id] : null,
          picks: room.players
            .filter((player) => Object.prototype.hasOwnProperty.call(picks, player.id))
            .map((player) => ({
              id: player.id,
              name: player.name,
              color: player.color,
              choice: picks[player.id],
            })),
        };
      });
    }
    return {
      code: room.code,
      status: room.status,
      hostId: room.hostId,
      you: viewerId,
      round: room.round,
      rounds: roundsInMatch(),
      endsAt: room.endsAt,
      length: room.length,
      waiting,
      hidden: hidden.map((zone) => ({ zone, label: ZONE_LABEL[zone] })),
      beats,
      questions,
      review: room.status === "reveal" ? room.review : null,
      evening: room.evening,
      verdict: room.status === "gallery" ? verdictFor(room) : null,
      lanOrigins: lanOrigins(portOf()),
      players: room.players.map((player) => ({
        id: player.id,
        name: player.name,
        color: player.color,
        score: player.score,
        connected: player.connected,
        host: player.id === room.hostId,
        inRound: player.inRound,
      })),
    };
  }

  function startGallery(room) {
    room.status = "gallery";
    room.endsAt = null;
    room.length = 0;
    room.scene = null;
    room.locks = {};
    for (const player of room.players) player.inRound = false;
    emitWorld(room);
  }

  function startReveal(room) {
    if (!rooms.has(room.code) || room.status === "reveal" || room.status === "gallery") return;
    const scored = scoreRound(room.players.filter((player) => player.inRound), room.scene, room.locks);
    for (const player of room.players) player.score += scored.gain[player.id] || 0;
    room.evening += scored.agreed;
    room.asked = (room.asked || 0) + room.scene.questions.length;
    room.review = { agreed: scored.agreed, of: room.scene.questions.length, detail: scored.detail };
    phase(room, "reveal", revealMs());
    emitWorld(room);
    arm(room, revealMs(), () => advance(room));
  }

  function startAsk(room) {
    if (!rooms.has(room.code) || room.status !== "watch") return;
    phase(room, "ask", askMs());
    emitWorld(room);
    arm(room, askMs(), () => startReveal(room));
  }

  function advance(room) {
    if (!rooms.has(room.code)) return;
    if (room.round >= roundsInMatch() || living(room).length < 2) startGallery(room);
    else openRound(room);
  }

  function openRound(room) {
    const ids = living(room).map((player) => player.id);
    if (ids.length < 2) {
      startGallery(room);
      return;
    }
    room.round += 1;
    for (const player of room.players) player.inRound = player.connected;
    room.scene = buildRound(ids, crypto.randomInt(1, 2147483647), room.round - 1);
    room.locks = {};
    room.review = null;
    phase(room, "watch", watchMs());
    emitWorld(room);
    arm(room, watchMs(), () => startAsk(room));
  }

  function startMatch(room, playerId) {
    if (room.hostId !== playerId) return "Only the host can start.";
    if (living(room).length < 2) return "Need at least two phones.";
    if (room.status !== "lobby" && room.status !== "gallery") return "A watch is already going.";
    room.round = 0;
    room.evening = 0;
    room.asked = 0;
    for (const player of room.players) player.score = 0;
    openRound(room);
    return null;
  }

  function link(socket, room, player) {
    socket.join(room.code);
    socketRoom.set(socket.id, { code: room.code, playerId: player.id });
    player.socketId = socket.id;
    player.connected = true;
    clearTimeout(player.dropTimer);
  }

  function removePlayer(room, playerId) {
    room.players = room.players.filter((player) => player.id !== playerId);
    ensureHost(room);
    if (!room.players.length) destroy(room);
    else emitWorld(room);
  }

  function unlink(socket, immediate) {
    const linkInfo = socketRoom.get(socket.id);
    socketRoom.delete(socket.id);
    if (!linkInfo) return;
    const room = rooms.get(linkInfo.code);
    if (!room) return;
    const player = room.players.find((item) => item.id === linkInfo.playerId);
    if (!player || player.socketId !== socket.id) return;
    player.connected = false;
    player.socketId = null;
    if (immediate && (room.status === "lobby" || room.status === "gallery")) {
      removePlayer(room, player.id);
      return;
    }
    clearTimeout(player.dropTimer);
    player.dropTimer = setTimeout(() => {
      const current = rooms.get(room.code);
      if (!current) return;
      const still = current.players.find((item) => item.id === player.id);
      if (!still || still.connected) return;
      if (current.status === "lobby" || current.status === "gallery") removePlayer(current, still.id);
      else if (!current.players.some((item) => item.connected)) destroy(current);
    }, 20000);
    if (rooms.has(room.code)) emitWorld(room);
  }

  function roomOf(socket) {
    const linkInfo = socketRoom.get(socket.id);
    if (!linkInfo) return null;
    const room = rooms.get(linkInfo.code);
    const player = room && room.players.find((item) => item.id === linkInfo.playerId);
    if (!room || !player) return null;
    return { room, player };
  }

  nsp.on("connection", (socket) => {
    socket.on("createRoom", (payload, ack) => {
      const name = cleanName(payload && payload.name);
      if (!name) return reply(ack, { ok: false, error: "Enter your name." });
      unlink(socket, true);
      const room = {
        code: makeCode(),
        hostId: null,
        status: "lobby",
        players: [],
        round: 0,
        evening: 0,
        asked: 0,
        scene: null,
        locks: {},
        review: null,
        endsAt: null,
        length: 0,
        token: 0,
        phaseTimer: null,
      };
      const player = {
        id: crypto.randomBytes(8).toString("hex"),
        name,
        color: COLORS[0],
        score: 0,
        inRound: false,
        socketId: socket.id,
        connected: true,
        dropTimer: null,
      };
      room.players.push(player);
      room.hostId = player.id;
      rooms.set(room.code, room);
      link(socket, room, player);
      reply(ack, { ok: true, playerId: player.id, code: room.code, name });
      emitWorld(room);
    });

    socket.on("joinRoom", (payload, ack) => {
      const room = rooms.get(cleanCode(payload && payload.code));
      if (!room) return reply(ack, { ok: false, error: "No room with that code." });
      const existing = payload && payload.playerId
        ? room.players.find((player) => player.id === payload.playerId)
        : null;
      if (existing) {
        link(socket, room, existing);
        reply(ack, { ok: true, playerId: existing.id, code: room.code, name: existing.name });
        emitWorld(room);
        return;
      }
      const name = cleanName(payload && payload.name);
      if (!name) return reply(ack, { ok: false, error: "Enter your name." });
      if (room.players.length >= MAX_PLAYERS) return reply(ack, { ok: false, error: "This room is full." });
      unlink(socket, true);
      const player = {
        id: crypto.randomBytes(8).toString("hex"),
        name,
        color: COLORS[room.players.length % COLORS.length],
        score: 0,
        inRound: false,
        socketId: socket.id,
        connected: true,
        dropTimer: null,
      };
      room.players.push(player);
      link(socket, room, player);
      reply(ack, { ok: true, playerId: player.id, code: room.code, name });
      emitWorld(room);
    });

    socket.on("start", (_payload, ack) => {
      const found = roomOf(socket);
      if (!found) return reply(ack, { ok: false, error: "You are not in a room." });
      const error = startMatch(found.room, found.player.id);
      reply(ack, { ok: !error, error: error || null });
    });

    socket.on("pick", (payload, ack) => {
      const found = roomOf(socket);
      if (!found) return reply(ack, { ok: false, error: "You are not in a room." });
      const { room, player } = found;
      if (room.status !== "ask" || !player.inRound) {
        return reply(ack, { ok: false, error: "Wait for the questions." });
      }
      const result = applyPick(
        room.scene,
        room.locks,
        player.id,
        payload && payload.questionId,
        payload && payload.choice,
      );
      if (!result.ok) return reply(ack, result);
      const done = room.scene.questions.every((question) => Object.prototype.hasOwnProperty.call(room.locks, question.id));
      if (done) arm(room, 450, () => startReveal(room));
      emitWorld(room);
      reply(ack, { ok: true });
    });

    socket.on("leave", (_payload, ack) => {
      unlink(socket, true);
      reply(ack, { ok: true });
    });

    socket.on("disconnect", () => {
      unlink(socket, false);
    });
  });

  return nsp;
}

function resetRooms() {
  for (const room of rooms.values()) clearTimeout(room.phaseTimer);
  rooms.clear();
  socketRoom.clear();
}

module.exports = {
  ZONES,
  assignBlinds,
  visibleBeats,
  buildRound,
  applyPick,
  scoreRound,
  attachKeyhole,
  resetRooms,
};

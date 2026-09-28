"use strict";

const crypto = require("crypto");
const os = require("os");

const CARDS = [
  { id: "tea", name: "Tea", tags: ["hot", "drink"] },
  { id: "soup", name: "Soup", tags: ["hot", "food"] },
  { id: "lamp", name: "Lamp", tags: ["hot", "light"] },
  { id: "mango", name: "Mango", tags: ["sweet", "food"] },
  { id: "cake", name: "Cake", tags: ["sweet", "food"] },
  { id: "ice", name: "Ice", tags: ["cold", "drink"] },
  { id: "coin", name: "Coin", tags: ["metal", "round", "small"] },
  { id: "key", name: "Key", tags: ["metal", "small"] },
  { id: "bell", name: "Bell", tags: ["metal", "loud", "small"] },
  { id: "drum", name: "Drum", tags: ["loud", "round"] },
  { id: "moon", name: "Moon", tags: ["light", "round"] },
  { id: "wool", name: "Wool", tags: ["soft"] },
];

const LINES = {
  hot: "something hot",
  drink: "a drink",
  food: "something you eat",
  sweet: "something sweet",
  cold: "something cold",
  metal: "something metal",
  round: "something round",
  loud: "something loud",
  light: "something that shines",
  small: "something small",
  soft: "something soft",
};

const MAX_PLAYERS = 4;
const HAND = 5;
const COLORS = ["#d4654a", "#2f6f4e", "#1d4e89", "#c47a1a"];
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const rooms = new Map();

function playMs() {
  const n = Number(process.env.ONLY_PLAY_MS);
  return Number.isFinite(n) && n > 0 ? n : 12000;
}

function revealMs() {
  const n = Number(process.env.ONLY_REVEAL_MS);
  return Number.isFinite(n) && n > 0 ? n : 4500;
}

function roundCount() {
  const n = Number(process.env.ONLY_ROUNDS);
  return Number.isFinite(n) && n > 0 ? n : 5;
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

function lanOrigins(port) {
  const origins = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === "IPv4" && !entry.internal) origins.push(`http://${entry.address}:${port}`);
    }
  }
  origins.sort((a, b) => Number(b.includes("192.168.")) - Number(a.includes("192.168.")));
  return origins;
}

function shuffle(list) {
  const copy = list.slice();
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(i + 1);
    const swap = copy[i];
    copy[i] = copy[j];
    copy[j] = swap;
  }
  return copy;
}

function makeDeck() {
  const deck = [];
  for (const card of CARDS) {
    deck.push({ ...card, key: `${card.id}-a` });
    deck.push({ ...card, key: `${card.id}-b` });
  }
  return shuffle(deck);
}

function chooseTag(hands) {
  const owners = {};
  for (const cards of Object.values(hands)) {
    const seen = new Set();
    for (const card of cards) {
      for (const tag of card.tags) {
        if (seen.has(tag)) continue;
        seen.add(tag);
        owners[tag] = (owners[tag] || 0) + 1;
      }
    }
  }
  const tense = Object.keys(owners).filter((tag) => owners[tag] >= 2);
  const pool = tense.length ? tense : Object.keys(owners);
  if (!pool.length) return "hot";
  return pool[crypto.randomInt(pool.length)];
}

function judge(plays, tag) {
  const valid = plays.filter((play) => play.card && play.card.tags.includes(tag));
  return {
    awarded: valid.length === 1 ? valid[0].playerId : null,
    validIds: valid.map((play) => play.playerId),
    cancelled: valid.length > 1,
    empty: plays.every((play) => !play.card),
  };
}

function reply(ack, payload) {
  if (typeof ack === "function") ack(payload);
}

function attachOnly(io, httpServer) {
  const nsp = io.of("/only");

  function portOf() {
    const address = httpServer.address();
    return address && typeof address === "object" ? address.port : 0;
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

  function stopTimers(room) {
    clearTimeout(room.phaseTimer);
    room.phaseTimer = null;
  }

  function destroy(room) {
    stopTimers(room);
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

  function playsOf(room) {
    return room.players.filter((player) => player.inRound).map((player) => ({
      playerId: player.id,
      name: player.name,
      card: room.choices[player.id] || null,
    }));
  }

  function worldFor(room, viewerId) {
    const viewer = room.players.find((player) => player.id === viewerId);
    const open = room.status === "reveal" || room.status === "result";
    const table = open
      ? playsOf(room).map((play) => ({
        playerId: play.playerId,
        name: play.name,
        card: play.card ? { key: play.card.key, id: play.card.id, name: play.card.name } : null,
        fit: Boolean(play.card && play.card.tags.includes(room.tag)),
      }))
      : [];
    return {
      code: room.code,
      status: room.status,
      hostId: room.hostId,
      you: viewerId,
      round: room.round,
      rounds: roundCount(),
      endsAt: room.endsAt,
      waiting: Boolean(viewer && (room.status === "play" || room.status === "reveal") && !viewer.inRound),
      line: room.tag ? LINES[room.tag] : "",
      hand: viewer && viewer.inRound ? (room.hands[viewer.id] || []).map((card) => ({
        key: card.key,
        id: card.id,
        name: card.name,
        fit: room.tag ? card.tags.includes(room.tag) : false,
      })) : [],
      choice: viewer ? (room.choices[viewer.id] ? room.choices[viewer.id].key : room.held[viewer.id] ? "hold" : null) : null,
      table,
      verdict: open ? room.verdict : "",
      awarded: open ? room.awarded : null,
      lanOrigins: lanOrigins(portOf()),
      players: room.players.map((player) => ({
        id: player.id,
        name: player.name,
        color: player.color,
        host: player.id === room.hostId,
        connected: player.connected,
        inRound: player.inRound,
        score: player.score,
        cards: (room.hands[player.id] || []).length,
        ready: room.status === "play" && (Boolean(room.choices[player.id]) || Boolean(room.held[player.id])),
      })),
    };
  }

  function deal(room) {
    const deck = makeDeck();
    room.hands = {};
    for (const player of room.players) {
      if (!player.inRound) {
        room.hands[player.id] = [];
        continue;
      }
      room.hands[player.id] = deck.splice(0, HAND);
    }
  }

  function openRound(room) {
    room.choices = {};
    room.held = {};
    room.table = [];
    room.verdict = "";
    room.awarded = null;
    room.tag = chooseTag(room.hands);
    room.status = "play";
    room.endsAt = Date.now() + playMs();
    stopTimers(room);
    room.phaseTimer = setTimeout(() => show(room), playMs());
    emitWorld(room);
  }

  function show(room) {
    if (!rooms.has(room.code) || room.status !== "play") return;
    const plays = playsOf(room);
    const result = judge(plays, room.tag);
    room.awarded = result.awarded;
    if (result.awarded) {
      const winner = room.players.find((player) => player.id === result.awarded);
      if (winner) winner.score += 1;
      const card = plays.find((play) => play.playerId === result.awarded).card;
      room.verdict = `${winner ? winner.name : "Someone"} scored with ${card.name}.`;
    } else if (result.cancelled) {
      room.verdict = "More than one card fit, so nobody scores.";
    } else if (result.empty) {
      room.verdict = "Everybody held.";
    } else {
      room.verdict = "Nothing on the table fit.";
    }
    for (const play of plays) {
      if (!play.card) continue;
      room.hands[play.playerId] = (room.hands[play.playerId] || []).filter((card) => card.key !== play.card.key);
    }
    room.status = "reveal";
    room.endsAt = Date.now() + revealMs();
    stopTimers(room);
    room.phaseTimer = setTimeout(() => advance(room), revealMs());
    emitWorld(room);
  }

  function advance(room) {
    if (!rooms.has(room.code) || room.status !== "reveal") return;
    if (room.round >= roundCount()) {
      room.status = "result";
      room.endsAt = null;
      emitWorld(room);
      return;
    }
    room.round += 1;
    openRound(room);
  }

  function begin(room) {
    const ids = living(room);
    if (ids.length < 2) return;
    for (const player of room.players) {
      player.inRound = player.connected;
      player.score = 0;
    }
    room.round = 1;
    deal(room);
    openRound(room);
  }

  function startMatch(room, playerId) {
    if (room.hostId !== playerId) return "Only the host can start.";
    if (living(room).length < 2) return "Need at least two phones.";
    if (room.status !== "lobby" && room.status !== "result") return "A hand is already on the table.";
    begin(room);
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
    delete room.hands[playerId];
    ensureHost(room);
    if (!room.players.length) destroy(room);
    else emitWorld(room);
  }

  const socketRoom = new Map();

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
    if (immediate && (room.status === "lobby" || room.status === "result")) {
      removePlayer(room, player.id);
      return;
    }
    clearTimeout(player.dropTimer);
    player.dropTimer = setTimeout(() => {
      const current = rooms.get(room.code);
      if (!current) return;
      const still = current.players.find((item) => item.id === player.id);
      if (!still || still.connected) return;
      if (current.status === "lobby" || current.status === "result") removePlayer(current, still.id);
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

  function maybeReveal(room) {
    const pending = room.players.filter((player) => player.inRound && player.connected);
    const ready = pending.every((player) => room.choices[player.id] || room.held[player.id]);
    if (ready && pending.length) show(room);
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
        hands: {},
        choices: {},
        held: {},
        tag: null,
        round: 0,
        verdict: "",
        awarded: null,
        endsAt: null,
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
      if (room.players.length >= MAX_PLAYERS) return reply(ack, { ok: false, error: "This table is full." });
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

    socket.on("choose", (payload, ack) => {
      const found = roomOf(socket);
      if (!found) return reply(ack, { ok: false, error: "You are not in a room." });
      const { room, player } = found;
      if (room.status !== "play" || !player.inRound) return reply(ack, { ok: false, error: "Wait for the next hand." });
      const round = Number(payload && payload.round);
      if (Number.isFinite(round) && round !== room.round) return reply(ack, { ok: false, error: "That hand already closed." });
      const key = payload && payload.card;
      if (!key || key === "hold") {
        delete room.choices[player.id];
        room.held[player.id] = true;
        emitWorld(room);
        maybeReveal(room);
        return reply(ack, { ok: true });
      }
      const card = (room.hands[player.id] || []).find((item) => item.key === key);
      if (!card) return reply(ack, { ok: false, error: "That card is not in your hand." });
      if (!card.tags.includes(room.tag)) return reply(ack, { ok: false, error: "That card does not fit." });
      delete room.held[player.id];
      room.choices[player.id] = card;
      emitWorld(room);
      maybeReveal(room);
      reply(ack, { ok: true });
    });

    socket.on("leave", (_payload, ack) => {
      unlink(socket, true);
      reply(ack, { ok: true });
    });

    socket.on("disconnect", () => unlink(socket, false));
  });

  return nsp;
}

function resetRooms() {
  for (const room of rooms.values()) {
    clearTimeout(room.phaseTimer);
    for (const player of room.players) clearTimeout(player.dropTimer);
  }
  rooms.clear();
}

module.exports = {
  CARDS,
  LINES,
  chooseTag,
  judge,
  attachOnly,
  resetRooms,
};

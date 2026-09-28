"use strict";

const crypto = require("crypto");
const os = require("os");

const VITALS = [
  { id: "breath", label: "Breath", decay: 5.2 },
  { id: "pulse", label: "Pulse", decay: 6.1 },
  { id: "bleed", label: "Bleed", decay: 5.6 },
  { id: "calm", label: "Calm", decay: 4.4 },
];
const MAX_PLAYERS = 4;
const COLORS = ["#7dcea0", "#f0c27a", "#ff8b7b", "#8eb7ff"];
const CARE = 30;
const OVERTREAT_AT = 68;
const OVERTREAT_HIT = 14;
const COOLDOWN_MS = 2200;
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const rooms = new Map();

function nightMs() {
  const n = Number(process.env.VITAL_NIGHT_MS);
  return Number.isFinite(n) && n > 0 ? n : 70000;
}

function tickMs() {
  const n = Number(process.env.VITAL_TICK_MS);
  return Number.isFinite(n) && n > 0 ? n : 200;
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

function wordFor(value) {
  if (value >= 62) return "steady";
  if (value >= 36) return "uneasy";
  return "failing";
}

function levelFor(value) {
  if (value >= 62) return 2;
  if (value >= 36) return 1;
  return 0;
}

function assignRoles(ids) {
  const roles = {};
  for (const id of ids) roles[id] = [];
  VITALS.forEach((vital, index) => {
    roles[ids[index % ids.length]].push(vital.id);
  });
  return roles;
}

function freshMeters() {
  return { breath: 74, pulse: 70, bleed: 72, calm: 76 };
}

function stepMeters(meters, seconds) {
  let failed = null;
  for (const vital of VITALS) {
    meters[vital.id] = Math.max(0, meters[vital.id] - vital.decay * seconds);
    if (meters[vital.id] <= 0 && !failed) failed = vital.id;
  }
  return failed;
}

function applyCare(meters, roles, cooldowns, playerId, vitalId, now) {
  const owned = roles[playerId] || [];
  if (!owned.includes(vitalId)) return { ok: false, error: "That vital is on another phone." };
  const readyAt = cooldowns[playerId] || 0;
  if (readyAt > now) return { ok: false, error: "Your hands need a moment." };
  if (!VITALS.some((vital) => vital.id === vitalId)) return { ok: false, error: "That vital is not on the chart." };
  cooldowns[playerId] = now + COOLDOWN_MS;
  if (meters[vitalId] >= OVERTREAT_AT) {
    for (const other of VITALS) {
      if (other.id === vitalId) continue;
      meters[other.id] = Math.max(0, meters[other.id] - OVERTREAT_HIT);
    }
    return { ok: true, overtreat: true, points: 0 };
  }
  meters[vitalId] = Math.min(100, meters[vitalId] + CARE);
  return { ok: true, overtreat: false, points: 1 };
}

function reply(ack, payload) {
  if (typeof ack === "function") ack(payload);
}

function attachVital(io, httpServer) {
  const nsp = io.of("/vital");

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

  function stopNight(room) {
    clearInterval(room.tick);
    room.tick = null;
    clearTimeout(room.phaseTimer);
  }

  function destroy(room) {
    stopNight(room);
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

  function ownersOf(room, vitalId) {
    return room.players
      .filter((player) => (room.roles[player.id] || []).includes(vitalId))
      .map((player) => ({ id: player.id, name: player.name, color: player.color }));
  }

  function worldFor(room, viewerId) {
    const viewer = room.players.find((player) => player.id === viewerId);
    const open = room.status === "result";
    const mine = viewer ? room.roles[viewer.id] || [] : [];
    const vitals = room.meters
      ? VITALS.map((vital) => {
          const value = room.meters[vital.id];
          const card = {
            id: vital.id,
            label: vital.label,
            word: wordFor(value),
            level: levelFor(value),
            mine: mine.includes(vital.id),
            owners: ownersOf(room, vital.id),
          };
          if (card.mine || open) card.value = Math.round(value);
          return card;
        })
      : [];
    const survived = room.started ? Math.max(0, Math.min(nightMs(), (room.endedAt || Date.now()) - room.started)) : 0;
    return {
      code: room.code,
      status: room.status,
      hostId: room.hostId,
      you: viewerId,
      endsAt: room.endsAt,
      length: room.length,
      waiting: Boolean(viewer && room.status === "night" && !viewer.inRound),
      readyAt: viewer ? room.cooldowns[viewer.id] || 0 : 0,
      vitals,
      failed: open ? room.failed : null,
      survived: open ? survived : null,
      night: nightMs(),
      lanOrigins: lanOrigins(portOf()),
      players: room.players.map((player) => ({
        id: player.id,
        name: player.name,
        color: player.color,
        host: player.id === room.hostId,
        connected: player.connected,
        inRound: player.inRound,
        score: player.score,
        roles: open || player.id === viewerId ? room.roles[player.id] || [] : [],
      })),
    };
  }

  function finish(room, failed) {
    if (!rooms.has(room.code) || room.status !== "night") return;
    stopNight(room);
    room.failed = failed;
    room.endedAt = Date.now();
    room.status = "result";
    room.endsAt = null;
    emitWorld(room);
  }

  function tick(room) {
    if (!rooms.has(room.code) || room.status !== "night") return;
    const failed = stepMeters(room.meters, tickMs() / 1000);
    if (failed) finish(room, failed);
    else emitWorld(room);
  }

  function beginNight(room) {
    const ids = living(room).map((player) => player.id);
    if (ids.length < 2) return;
    room.roles = assignRoles(ids);
    room.meters = freshMeters();
    room.cooldowns = {};
    room.failed = null;
    room.started = Date.now();
    room.endedAt = null;
    for (const player of room.players) {
      player.inRound = player.connected;
      player.score = 0;
    }
    room.status = "night";
    room.length = nightMs();
    room.endsAt = Date.now() + nightMs();
    clearInterval(room.tick);
    room.tick = setInterval(() => tick(room), tickMs());
    clearTimeout(room.phaseTimer);
    room.phaseTimer = setTimeout(() => finish(room, null), nightMs());
    emitWorld(room);
  }

  function startMatch(room, playerId) {
    if (room.hostId !== playerId) return "Only the host can start.";
    if (living(room).length < 2) return "Need at least two phones.";
    if (room.status !== "lobby" && room.status !== "result") return "The night has already started.";
    beginNight(room);
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
        roles: {},
        meters: null,
        cooldowns: {},
        failed: null,
        started: 0,
        endedAt: null,
        endsAt: null,
        length: 0,
        tick: null,
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
      if (room.players.length >= MAX_PLAYERS) return reply(ack, { ok: false, error: "This ward is full." });
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

    socket.on("care", (payload, ack) => {
      const found = roomOf(socket);
      if (!found) return reply(ack, { ok: false, error: "You are not in a room." });
      const { room, player } = found;
      if (room.status !== "night" || !player.inRound) return reply(ack, { ok: false, error: "The night has not started." });
      const result = applyCare(room.meters, room.roles, room.cooldowns, player.id, payload && payload.vital, Date.now());
      if (!result.ok) return reply(ack, result);
      player.score += result.points;
      const failed = stepMeters(room.meters, 0);
      if (failed) finish(room, failed);
      else emitWorld(room);
      reply(ack, { ok: true, overtreat: result.overtreat });
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
  for (const room of rooms.values()) {
    clearInterval(room.tick);
    clearTimeout(room.phaseTimer);
    for (const player of room.players) clearTimeout(player.dropTimer);
  }
  rooms.clear();
}

module.exports = {
  VITALS,
  wordFor,
  assignRoles,
  freshMeters,
  stepMeters,
  applyCare,
  attachVital,
  resetRooms,
};

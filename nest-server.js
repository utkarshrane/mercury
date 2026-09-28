"use strict";

const crypto = require("crypto");
const os = require("os");

const CHICKS = [
  { id: "pip", name: "Pip" },
  { id: "moth", name: "Moth" },
  { id: "lumen", name: "Lumen" },
];
const NEEDS = [
  { id: "feed", label: "Feed" },
  { id: "warm", label: "Warm" },
  { id: "clean", label: "Clean" },
  { id: "rest", label: "Rest" },
];
const MAX_PLAYERS = 3;
const COLORS = ["#e7a15a", "#7eb6c9", "#e28b8b", "#8fba7a"];
const CARE = 28;
const SHARED_WARMTH = 8;
const COOLDOWN_MS = 1600;
const DECAY = 1.85;
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const rooms = new Map();

function shiftMs() {
  const n = Number(process.env.NEST_SHIFT_MS);
  return Number.isFinite(n) && n > 0 ? n : 60000;
}

function tickMs() {
  const n = Number(process.env.NEST_TICK_MS);
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

function toneFor(value) {
  if (value >= 40) return "ok";
  if (value >= 18) return "low";
  return "bad";
}

function assignChicks(ids) {
  const roles = {};
  for (const id of ids) roles[id] = [];
  if (ids.length === 2) {
    roles[ids[0]].push("pip", "lumen");
    roles[ids[1]].push("moth", "lumen");
    return roles;
  }
  CHICKS.forEach((chick, index) => {
    roles[ids[index % ids.length]].push(chick.id);
  });
  return roles;
}

function freshMeters() {
  const meters = {};
  for (const chick of CHICKS) {
    meters[chick.id] = { feed: 84, warm: 80, clean: 86, rest: 78 };
  }
  return meters;
}

function stepMeters(meters, seconds) {
  let failed = null;
  for (const chick of CHICKS) {
    for (const need of NEEDS) {
      const next = Math.max(0, meters[chick.id][need.id] - DECAY * seconds);
      meters[chick.id][need.id] = next;
      if (next <= 0 && !failed) failed = { chick: chick.id, need: need.id };
    }
  }
  return failed;
}

function applyCare(meters, roles, cooldowns, playerId, chickId, needId, now) {
  const owned = roles[playerId] || [];
  if (!owned.includes(chickId)) return { ok: false, error: "That chick is on another phone." };
  if (!NEEDS.some((need) => need.id === needId)) return { ok: false, error: "That care is not on the card." };
  const readyAt = cooldowns[playerId] || 0;
  if (readyAt > now) return { ok: false, error: "Your hands need a moment." };
  cooldowns[playerId] = now + COOLDOWN_MS;
  meters[chickId][needId] = Math.min(100, meters[chickId][needId] + CARE);
  if (needId === "warm") {
    for (const other of CHICKS) {
      if (other.id === chickId) continue;
      meters[other.id].warm = Math.min(100, meters[other.id].warm + SHARED_WARMTH);
    }
  }
  return { ok: true, points: 1 };
}

function reply(ack, payload) {
  if (typeof ack === "function") ack(payload);
}

function attachNest(io, httpServer) {
  const nsp = io.of("/nest");

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

  function stopShift(room) {
    clearInterval(room.tick);
    room.tick = null;
    clearTimeout(room.phaseTimer);
  }

  function destroy(room) {
    stopShift(room);
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

  function ownersOf(room, chickId) {
    return room.players
      .filter((item) => (room.roles[item.id] || []).includes(chickId))
      .map((item) => ({ id: item.id, name: item.name, color: item.color }));
  }

  function worldFor(room, viewerId) {
    const viewer = room.players.find((player) => player.id === viewerId);
    const open = room.status === "shift" || room.status === "result";
    const chicks = open
      ? CHICKS.map((chick) => {
          const owners = ownersOf(room, chick.id);
          const needs = NEEDS.map((need) => {
            const value = room.meters[chick.id][need.id];
            return {
              id: need.id,
              label: need.label,
              value: Math.round(value),
              tone: toneFor(value),
            };
          });
          return {
            id: chick.id,
            name: chick.name,
            mine: owners.some((owner) => owner.id === viewerId),
            shared: owners.length > 1,
            owners,
            needs,
          };
        })
      : [];
    const survived = room.started ? Math.max(0, Math.min(shiftMs(), (room.endedAt || Date.now()) - room.started)) : 0;
    return {
      code: room.code,
      status: room.status,
      hostId: room.hostId,
      you: viewerId,
      endsAt: room.endsAt,
      length: room.length,
      waiting: Boolean(viewer && room.status === "shift" && !viewer.inRound),
      readyAt: viewer ? room.cooldowns[viewer.id] || 0 : 0,
      chicks,
      note: room.note,
      failed: room.status === "result" ? room.failed : null,
      survived: room.status === "result" ? survived : null,
      shift: shiftMs(),
      lanOrigins: lanOrigins(portOf()),
      players: room.players.map((player) => ({
        id: player.id,
        name: player.name,
        color: player.color,
        host: player.id === room.hostId,
        connected: player.connected,
        inRound: player.inRound,
        score: player.score,
        chicks: room.roles[player.id] || [],
      })),
    };
  }

  function finish(room, failed) {
    if (!rooms.has(room.code) || room.status !== "shift") return;
    stopShift(room);
    room.failed = failed;
    room.endedAt = Date.now();
    room.status = "result";
    room.endsAt = null;
    emitWorld(room);
  }

  function tick(room) {
    if (!rooms.has(room.code) || room.status !== "shift") return;
    const failed = stepMeters(room.meters, tickMs() / 1000);
    if (failed) finish(room, failed);
    else emitWorld(room);
  }

  function beginShift(room) {
    const ids = living(room).map((player) => player.id);
    if (ids.length < 2) return;
    room.roles = assignChicks(ids);
    room.meters = freshMeters();
    room.cooldowns = {};
    room.failed = null;
    room.note = null;
    room.started = Date.now();
    room.endedAt = null;
    for (const player of room.players) {
      player.inRound = player.connected;
      player.score = 0;
    }
    room.status = "shift";
    room.length = shiftMs();
    room.endsAt = Date.now() + shiftMs();
    clearInterval(room.tick);
    room.tick = setInterval(() => tick(room), tickMs());
    clearTimeout(room.phaseTimer);
    room.phaseTimer = setTimeout(() => finish(room, null), shiftMs());
    emitWorld(room);
  }

  function startMatch(room, playerId) {
    if (room.hostId !== playerId) return "Only the host can start.";
    if (living(room).length < 2) return "Need at least two phones.";
    if (room.status !== "lobby" && room.status !== "result") return "The shift has already started.";
    beginShift(room);
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
        note: null,
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
      if (room.players.length >= MAX_PLAYERS) return reply(ack, { ok: false, error: "This nest is full." });
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
      if (room.status !== "shift" || !player.inRound) return reply(ack, { ok: false, error: "The shift has not started." });
      const chickId = payload && payload.chick;
      const needId = payload && payload.need;
      const result = applyCare(room.meters, room.roles, room.cooldowns, player.id, chickId, needId, Date.now());
      if (!result.ok) return reply(ack, result);
      player.score += result.points;
      const chick = CHICKS.find((item) => item.id === chickId);
      const need = NEEDS.find((item) => item.id === needId);
      room.note = `${player.name} cared for ${chick ? chick.name : "a chick"} · ${need ? need.label : ""}`;
      const failed = stepMeters(room.meters, 0);
      if (failed) finish(room, failed);
      else emitWorld(room);
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
  for (const room of rooms.values()) {
    clearInterval(room.tick);
    clearTimeout(room.phaseTimer);
    for (const player of room.players) clearTimeout(player.dropTimer);
  }
  rooms.clear();
}

module.exports = {
  CHICKS,
  NEEDS,
  toneFor,
  assignChicks,
  freshMeters,
  stepMeters,
  applyCare,
  attachNest,
  resetRooms,
};

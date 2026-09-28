"use strict";

const crypto = require("crypto");
const os = require("os");

const MAX_PLAYERS = 6;
const DROPS = 56;
const BOWL = 0.24;
const HOLD = 0.16;
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const COLORS = ["#c4b5ff", "#ffb15a", "#7dffe1", "#ff7aa2", "#d6ff6b", "#8ecbff"];

const rooms = new Map();

function roundMs() {
  const n = Number(process.env.MERCURY_ROUND_MS);
  return Number.isFinite(n) && n > 0 ? n : 40000;
}

function countMs() {
  const n = Number(process.env.MERCURY_COUNT_MS);
  return Number.isFinite(n) && n > 0 ? n : 3000;
}

function tickMs() {
  const n = Number(process.env.MERCURY_TICK_MS);
  return Number.isFinite(n) && n > 0 ? n : 50;
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

function createDrops(n = DROPS) {
  const drops = [];
  for (let i = 0; i < n; i += 1) {
    const angle = Math.random() * Math.PI * 2;
    const radius = Math.random() * 0.1;
    drops.push({
      x: 0.5 + Math.cos(angle) * radius,
      y: 0.5 + Math.sin(angle) * radius,
      vx: 0,
      vy: 0,
    });
  }
  return drops;
}

function clampInside(entity, limit) {
  const ox = entity.x - 0.5;
  const oy = entity.y - 0.5;
  const radius = Math.hypot(ox, oy);
  if (radius > limit) {
    entity.x = 0.5 + (ox / radius) * limit;
    entity.y = 0.5 + (oy / radius) * limit;
  }
}

function seat(index, total) {
  const angle = (Math.PI * 2 * index) / Math.max(total, 1) - Math.PI / 2;
  return {
    x: 0.5 + Math.cos(angle) * 0.28,
    y: 0.5 + Math.sin(angle) * 0.28,
  };
}

/**
 * Move the silver and give each drop to the closest hand that is holding it.
 * players need x, y, tx, ty, pulling, connected, inRound, score.
 */
function step(drops, players, dt) {
  const active = players.filter((player) => player.connected && player.inRound && player.pulling);
  for (const player of active) {
    player.x += (player.tx - player.x) * Math.min(1, dt * 16);
    player.y += (player.ty - player.y) * Math.min(1, dt * 16);
  }
  for (let i = 0; i < active.length; i += 1) {
    for (let j = i + 1; j < active.length; j += 1) {
      const a = active[i];
      const b = active[j];
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      const dist = Math.hypot(dx, dy) || 0.0001;
      if (dist >= 0.16) continue;
      const push = (0.16 - dist) * 0.65;
      dx /= dist;
      dy /= dist;
      a.x -= dx * push;
      a.y -= dy * push;
      b.x += dx * push;
      b.y += dy * push;
    }
  }
  for (const player of active) clampInside(player, 0.3);

  let cx = 0;
  let cy = 0;
  for (const drop of drops) {
    cx += drop.x;
    cy += drop.y;
  }
  cx /= drops.length || 1;
  cy /= drops.length || 1;

  for (const drop of drops) {
    let ax = (cx - drop.x) * 1.1;
    let ay = (cy - drop.y) * 1.1;
    for (const player of active) {
      const dx = player.x - drop.x;
      const dy = player.y - drop.y;
      const dist = Math.hypot(dx, dy) + 0.04;
      const pull = 8 / dist;
      ax += (dx / dist) * pull;
      ay += (dy / dist) * pull;
    }
    drop.vx = (drop.vx + ax * dt) * 0.9;
    drop.vy = (drop.vy + ay * dt) * 0.9;
    const speed = Math.hypot(drop.vx, drop.vy);
    if (speed > 1.15) {
      drop.vx = (drop.vx / speed) * 1.15;
      drop.vy = (drop.vy / speed) * 1.15;
    }
    drop.x += drop.vx * dt;
    drop.y += drop.vy * dt;
    const ox = drop.x - 0.5;
    const oy = drop.y - 0.5;
    const radius = Math.hypot(ox, oy);
    if (radius > BOWL) {
      drop.x = 0.5 + (ox / radius) * BOWL;
      drop.y = 0.5 + (oy / radius) * BOWL;
      drop.vx *= 0.35;
      drop.vy *= 0.35;
    }
  }

  for (const drop of drops) {
    let best = null;
    let bestDist = HOLD;
    for (const player of active) {
      const dist = Math.hypot(player.x - drop.x, player.y - drop.y);
      if (dist < bestDist) {
        best = player;
        bestDist = dist;
      }
    }
    if (best) best.score += 1;
  }
}

function attachMercury(io, httpServer) {
  const nsp = io.of("/mercury");
  const socketRoom = new Map();

  function portOf() {
    const address = httpServer.address();
    return address && typeof address === "object" ? address.port : 3000;
  }

  function reply(ack, body) {
    if (typeof ack === "function") ack(body);
  }

  function destroy(room) {
    clearInterval(room.tick);
    clearTimeout(room.phaseTimer);
    rooms.delete(room.code);
  }

  function takeSlot(room) {
    const used = new Set(room.players.map((player) => player.slot));
    for (let slot = 1; slot <= MAX_PLAYERS; slot += 1) {
      if (!used.has(slot)) return slot;
    }
    return 0;
  }

  function ensureHost(room) {
    const host = room.players.find((player) => player.id === room.hostId && player.connected);
    if (host) return;
    const next = room.players.find((player) => player.connected);
    room.hostId = next ? next.id : room.players[0] ? room.players[0].id : null;
  }

  function canStart(room, playerId) {
    if (playerId === room.hostId) return true;
    const host = room.players.find((player) => player.id === room.hostId);
    return !host || !host.connected;
  }

  function seatAll(room) {
    const seated = room.players.filter((player) => player.connected);
    seated.forEach((player, index) => {
      const spot = seat(index, seated.length);
      player.x = spot.x;
      player.y = spot.y;
      player.tx = spot.x;
      player.ty = spot.y;
      player.pulling = false;
    });
  }

  function packDrops(room) {
    const packed = [];
    for (const drop of room.drops) {
      packed.push(Math.round(drop.x * 1000) / 1000, Math.round(drop.y * 1000) / 1000);
    }
    return packed;
  }

  function worldFor(room, viewerId) {
    const total = room.players.reduce((sum, player) => sum + player.score, 0);
    return {
      code: room.code,
      status: room.status,
      hostId: room.hostId,
      you: viewerId,
      endsAt: room.endsAt,
      lanOrigins: lanOrigins(portOf()),
      drops: packDrops(room),
      players: room.players.map((player) => ({
        id: player.id,
        name: player.name,
        color: player.color,
        slot: player.slot,
        x: Math.round(player.x * 1000) / 1000,
        y: Math.round(player.y * 1000) / 1000,
        score: player.score,
        share: total ? player.score / total : 0,
        pulling: player.pulling,
        connected: player.connected,
      })),
    };
  }

  function emitWorld(room) {
    if (!rooms.has(room.code)) return;
    for (const player of room.players) {
      if (!player.socketId) continue;
      const socket = nsp.sockets.get(player.socketId);
      if (socket) socket.emit("world", worldFor(room, player.id));
    }
  }

  function beginRound(room) {
    room.players = room.players.filter((player) => player.connected);
    ensureHost(room);
    if (room.players.length < 2) return "Need at least two players.";
    room.drops = createDrops();
    for (const player of room.players) {
      player.inRound = true;
      player.score = 0;
      player.pulling = false;
    }
    seatAll(room);
    room.status = "countdown";
    room.endsAt = Date.now() + countMs();
    clearTimeout(room.phaseTimer);
    room.phaseTimer = setTimeout(() => {
      if (!rooms.has(room.code) || room.status !== "countdown") return;
      room.status = "playing";
      room.endsAt = Date.now() + roundMs();
      room.phaseTimer = setTimeout(() => finishRound(room), roundMs());
      emitWorld(room);
    }, countMs());
    emitWorld(room);
    return null;
  }

  function finishRound(room) {
    if (!rooms.has(room.code) || room.status === "gallery") return;
    room.status = "gallery";
    room.endsAt = null;
    for (const player of room.players) player.pulling = false;
    emitWorld(room);
  }

  function tick(room) {
    if (room.status !== "playing") return;
    if (room.endsAt && Date.now() >= room.endsAt) {
      finishRound(room);
      return;
    }
    for (const player of room.players) {
      if (player.pulling) continue;
      player.x += (player.tx - player.x) * 0.18;
      player.y += (player.ty - player.y) * 0.18;
    }
    step(room.drops, room.players, tickMs() / 1000);
    emitWorld(room);
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
    player.pulling = false;
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

  nsp.on("connection", (socket) => {
    socket.on("createRoom", (payload, ack) => {
      const name = cleanName(payload && payload.name);
      if (!name) return reply(ack, { ok: false, error: "Enter your name." });
      const spot = seat(0, 1);
      const room = {
        code: makeCode(),
        hostId: null,
        status: "lobby",
        players: [],
        drops: createDrops(36),
        endsAt: null,
        tick: null,
        phaseTimer: null,
      };
      room.tick = setInterval(() => tick(room), tickMs());
      const player = {
        id: crypto.randomBytes(8).toString("hex"),
        name,
        slot: 1,
        color: COLORS[0],
        x: spot.x,
        y: spot.y,
        tx: spot.x,
        ty: spot.y,
        pulling: false,
        inRound: true,
        score: 0,
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
      if (!room) return reply(ack, { ok: false, error: "No bowl with that code." });
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
      if (room.players.length >= MAX_PLAYERS) return reply(ack, { ok: false, error: "This bowl is full." });
      const slot = takeSlot(room);
      const spot = seat(room.players.length, room.players.length + 1);
      const player = {
        id: crypto.randomBytes(8).toString("hex"),
        name,
        slot,
        color: COLORS[(slot - 1) % COLORS.length],
        x: spot.x,
        y: spot.y,
        tx: spot.x,
        ty: spot.y,
        pulling: false,
        inRound: room.status === "lobby" || room.status === "gallery",
        score: 0,
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
      const linkInfo = socketRoom.get(socket.id);
      const room = linkInfo && rooms.get(linkInfo.code);
      const player = room && room.players.find((item) => item.id === linkInfo.playerId);
      if (!room || !player) return reply(ack, { ok: false, error: "You are not at a bowl." });
      if (!canStart(room, player.id)) return reply(ack, { ok: false, error: "Only the host can start." });
      if (room.status === "playing" || room.status === "countdown") {
        return reply(ack, { ok: false, error: "The silver is already moving." });
      }
      const error = beginRound(room);
      reply(ack, { ok: !error, error: error || null });
    });

    socket.on("input", (payload) => {
      const linkInfo = socketRoom.get(socket.id);
      const room = linkInfo && rooms.get(linkInfo.code);
      if (!room || room.status !== "playing") return;
      const player = room.players.find((item) => item.id === linkInfo.playerId);
      if (!player || !player.connected || !player.inRound) return;
      const pulling = !!(payload && payload.pulling);
      player.pulling = pulling;
      if (!pulling) return;
      let x = Number(payload.x);
      let y = Number(payload.y);
      if (!Number.isFinite(x)) x = player.x;
      if (!Number.isFinite(y)) y = player.y;
      const aim = { x, y };
      clampInside(aim, 0.3);
      player.tx = aim.x;
      player.ty = aim.y;
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

function resetMercury() {
  for (const room of [...rooms.values()]) {
    clearInterval(room.tick);
    clearTimeout(room.phaseTimer);
    rooms.delete(room.code);
  }
}

module.exports = {
  attachMercury,
  resetMercury,
  step,
  createDrops,
  DROPS,
  BOWL,
  HOLD,
};

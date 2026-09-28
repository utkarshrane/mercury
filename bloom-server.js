"use strict";

const crypto = require("crypto");
const os = require("os");

const COLS = 180;
const ROWS = 108;
const CELLS = COLS * ROWS;
const SPEED = 0.52;
const BRUSH = 7.2;
const MAX_PLAYERS = 8;
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const COLORS = ["#ff4d3a", "#ffc14d", "#2ad4b0", "#8b7cff", "#ff5fa2", "#c6ef5a", "#59b7ff", "#ff8d4d"];

const rooms = new Map();

function roundMs() {
  const n = Number(process.env.BLOOM_ROUND_MS);
  return Number.isFinite(n) && n > 0 ? n : 45000;
}

function countMs() {
  const n = Number(process.env.BLOOM_COUNT_MS);
  return Number.isFinite(n) && n > 0 ? n : 3000;
}

function tickMs() {
  const n = Number(process.env.BLOOM_TICK_MS);
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

function createGrid() {
  return new Uint8Array(CELLS);
}

function createScores() {
  return new Array(MAX_PLAYERS + 1).fill(0);
}

/**
 * Paint a disc. x and y are 0..1 across the floor.
 * owner is the player's slot (1..8). Returns changed cell indexes.
 */
function paintDisc(grid, scores, owner, x, y) {
  const cx = x * (COLS - 1);
  const cy = y * (ROWS - 1);
  const r2 = BRUSH * BRUSH;
  const changed = [];
  const y0 = Math.max(0, Math.floor(cy - BRUSH));
  const y1 = Math.min(ROWS - 1, Math.ceil(cy + BRUSH));
  const x0 = Math.max(0, Math.floor(cx - BRUSH));
  const x1 = Math.min(COLS - 1, Math.ceil(cx + BRUSH));
  for (let iy = y0; iy <= y1; iy += 1) {
    for (let ix = x0; ix <= x1; ix += 1) {
      const dx = ix - cx;
      const dy = iy - cy;
      if (dx * dx + dy * dy > r2) continue;
      const idx = iy * COLS + ix;
      const prev = grid[idx];
      if (prev === owner) continue;
      if (prev) scores[prev] = Math.max(0, scores[prev] - 1);
      grid[idx] = owner;
      scores[owner] += 1;
      changed.push(idx);
    }
  }
  return changed;
}

function attachBloom(io, httpServer) {
  const nsp = io.of("/bloom");
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

  function worldFor(room, viewerId) {
    const painted = room.scores.reduce((sum, n) => sum + n, 0);
    return {
      code: room.code,
      status: room.status,
      hostId: room.hostId,
      you: viewerId,
      endsAt: room.endsAt,
      cols: COLS,
      rows: ROWS,
      lanOrigins: lanOrigins(portOf()),
      players: room.players.map((player) => ({
        id: player.id,
        name: player.name,
        color: player.color,
        slot: player.slot,
        x: player.x,
        y: player.y,
        score: room.scores[player.slot] || 0,
        share: painted ? (room.scores[player.slot] || 0) / painted : 0,
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

  function emitGrid(room) {
    nsp.to(room.code).emit("grid", Array.from(room.grid));
  }

  function spawn(room) {
    const seated = room.players.filter((player) => player.connected);
    seated.forEach((player, index) => {
      const angle = (Math.PI * 2 * index) / seated.length - Math.PI / 2;
      player.x = 0.5 + Math.cos(angle) * 0.28;
      player.y = 0.5 + Math.sin(angle) * 0.28;
      player.input = { x: 0, y: 0 };
    });
  }

  function beginRound(room) {
    room.players = room.players.filter((player) => player.connected);
    ensureHost(room);
    if (room.players.length < 2) return "Need at least two players.";
    room.grid = createGrid();
    room.scores = createScores();
    for (const player of room.players) player.inRound = true;
    spawn(room);
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
    emitGrid(room);
    emitWorld(room);
    return null;
  }

  function finishRound(room) {
    if (!rooms.has(room.code) || room.status === "gallery") return;
    room.status = "gallery";
    room.endsAt = null;
    for (const player of room.players) player.input = { x: 0, y: 0 };
    emitGrid(room);
    emitWorld(room);
  }

  function step(room) {
    if (room.status !== "playing") return;
    if (room.endsAt && Date.now() >= room.endsAt) {
      finishRound(room);
      return;
    }
    const dt = tickMs() / 1000;
      const changed = [];
    for (const player of room.players) {
      if (!player.connected || !player.inRound) continue;
      let { x, y } = player.input;
      const mag = Math.hypot(x, y);
      if (mag < 0.12) continue;
      if (mag > 1) {
        x /= mag;
        y /= mag;
      }
      player.x = Math.min(0.92, Math.max(0.08, player.x + x * SPEED * dt));
      player.y = Math.min(0.92, Math.max(0.08, player.y + y * SPEED * dt));
      for (const idx of paintDisc(room.grid, room.scores, player.slot, player.x, player.y)) {
        changed.push(idx, player.slot);
      }
    }
    if (changed.length) nsp.to(room.code).emit("paint", changed);
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
    player.input = { x: 0, y: 0 };
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
      const room = {
        code: makeCode(),
        hostId: null,
        status: "lobby",
        players: [],
        grid: createGrid(),
        scores: createScores(),
        endsAt: null,
        tick: null,
        phaseTimer: null,
      };
      room.tick = setInterval(() => step(room), tickMs());
      const player = {
        id: crypto.randomBytes(8).toString("hex"),
        name,
        slot: 1,
        color: COLORS[0],
        x: 0.5,
        y: 0.5,
        input: { x: 0, y: 0 },
        inRound: true,
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
      if (!room) return reply(ack, { ok: false, error: "No floor with that code." });
      const existing = payload && payload.playerId
        ? room.players.find((player) => player.id === payload.playerId)
        : null;
      if (existing) {
        link(socket, room, existing);
        reply(ack, { ok: true, playerId: existing.id, code: room.code, name: existing.name });
        emitWorld(room);
        socket.emit("grid", Array.from(room.grid));
        return;
      }
      const name = cleanName(payload && payload.name);
      if (!name) return reply(ack, { ok: false, error: "Enter your name." });
      if (room.players.length >= MAX_PLAYERS) return reply(ack, { ok: false, error: "This floor is full." });
      const slot = takeSlot(room);
      const player = {
        id: crypto.randomBytes(8).toString("hex"),
        name,
        slot,
        color: COLORS[(slot - 1) % COLORS.length],
        x: 0.5,
        y: 0.5,
        input: { x: 0, y: 0 },
        inRound: room.status === "lobby" || room.status === "gallery",
        socketId: socket.id,
        connected: true,
        dropTimer: null,
      };
      room.players.push(player);
      link(socket, room, player);
      reply(ack, { ok: true, playerId: player.id, code: room.code, name });
      emitWorld(room);
      socket.emit("grid", Array.from(room.grid));
    });

    socket.on("start", (_payload, ack) => {
      const linkInfo = socketRoom.get(socket.id);
      const room = linkInfo && rooms.get(linkInfo.code);
      const player = room && room.players.find((item) => item.id === linkInfo.playerId);
      if (!room || !player) return reply(ack, { ok: false, error: "You are not on a floor." });
      if (!canStart(room, player.id)) return reply(ack, { ok: false, error: "Only the host can start." });
      if (room.status === "playing" || room.status === "countdown") {
        return reply(ack, { ok: false, error: "A bloom is already going." });
      }
      const error = beginRound(room);
      reply(ack, { ok: !error, error: error || null });
    });

    socket.on("input", (payload) => {
      const linkInfo = socketRoom.get(socket.id);
      const room = linkInfo && rooms.get(linkInfo.code);
      if (!room || room.status !== "playing") return;
      const player = room.players.find((item) => item.id === linkInfo.playerId);
      if (!player || !player.connected) return;
      let x = Number(payload && payload.x);
      let y = Number(payload && payload.y);
      if (!Number.isFinite(x)) x = 0;
      if (!Number.isFinite(y)) y = 0;
      const mag = Math.hypot(x, y);
      if (mag > 1) {
        x /= mag;
        y /= mag;
      }
      player.input = { x, y };
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

function resetBloom() {
  for (const room of [...rooms.values()]) {
    clearInterval(room.tick);
    clearTimeout(room.phaseTimer);
    rooms.delete(room.code);
  }
}

module.exports = {
  attachBloom,
  resetBloom,
  paintDisc,
  createGrid,
  createScores,
  COLS,
  ROWS,
  CELLS,
  BRUSH,
};

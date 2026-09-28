"use strict";

const crypto = require("crypto");
const os = require("os");

const MAX_PLAYERS = 6;
const COLS = 13;
const ROWS = 15;
const BANKS = 2;
const RADIUS = 0.26;
const SPEED = 7.4;
const CARRY = 4.8;
const CURRENT = 1.5;
const PICKUP = 0.9;
const STEAL = 0.95;
const AIR_MAX = 100;
const AIR_DRAIN = 3.2;
const AIR_FILL = 70;
const STUN = 0.8;
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const COLORS = ["#ffb085", "#ffe08a", "#7dffe1", "#d4b4ff", "#8ecbff", "#ff8fbe"];

const RAW = [
  "#############",
  "##...HHH...##",
  "##...^^^...##",
  "##..VVVVV..##",
  "##.........##",
  "##.#.....#.##",
  "##.B.....B.##",
  "##.#.....#.##",
  "##.........##",
  "##...vvv...##",
  "##..VV.VV..##",
  "##.........##",
  "##...#B#...##",
  "##.........##",
  "#############",
];

const rooms = new Map();

function roundMs() {
  const n = Number(process.env.FATHOM_ROUND_MS);
  return Number.isFinite(n) && n > 0 ? n : 90000;
}

function countMs() {
  const n = Number(process.env.FATHOM_COUNT_MS);
  return Number.isFinite(n) && n > 0 ? n : 3000;
}

function tickMs() {
  const n = Number(process.env.FATHOM_TICK_MS);
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

function createLevel() {
  if (RAW.length !== ROWS || RAW.some((row) => row.length !== COLS)) {
    throw new Error("The cave map is the wrong size.");
  }
  const grid = RAW.map((row) => row.split(""));
  const bells = [];
  let hatchX = 0;
  let hatchY = 0;
  let hatchN = 0;
  for (let r = 0; r < ROWS; r += 1) {
    for (let c = 0; c < COLS; c += 1) {
      const cell = grid[r][c];
      if (cell === "B") {
        bells.push({
          id: bells.length,
          x: c + 0.5,
          y: r + 0.5,
          carriedBy: null,
          banked: false,
        });
        grid[r][c] = ".";
      } else if (cell === "H") {
        hatchX += c + 0.5;
        hatchY += r + 0.5;
        hatchN += 1;
      }
    }
  }
  if (bells.length !== 3 || !hatchN) throw new Error("The cave is missing its bells or the moon pool.");
  const hatch = { x: hatchX / hatchN, y: hatchY / hatchN };
  const seen = flood(grid, hatch);
  for (const bell of bells) {
    if (!seen[Math.floor(bell.y)][Math.floor(bell.x)]) throw new Error("A bell is sealed in the rock.");
  }
  return { grid, bells, hatch, chart: grid.map((row) => row.join("")) };
}

function flood(grid, hatch) {
  const seen = Array.from({ length: ROWS }, () => Array(COLS).fill(false));
  const queue = [[Math.floor(hatch.x), Math.floor(hatch.y)]];
  seen[queue[0][1]][queue[0][0]] = true;
  while (queue.length) {
    const [c, r] = queue.pop();
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nc = c + dc;
      const nr = r + dr;
      if (nr < 0 || nc < 0 || nr >= ROWS || nc >= COLS || seen[nr][nc]) continue;
      if (grid[nr][nc] === "#") continue;
      seen[nr][nc] = true;
      queue.push([nc, nr]);
    }
  }
  return seen;
}

function tileAt(grid, x, y) {
  const c = Math.floor(x);
  const r = Math.floor(y);
  if (r < 0 || c < 0 || r >= ROWS || c >= COLS) return "#";
  return grid[r][c];
}

function circleHits(grid, x, y) {
  const minC = Math.floor(x - RADIUS);
  const maxC = Math.floor(x + RADIUS);
  const minR = Math.floor(y - RADIUS);
  const maxR = Math.floor(y + RADIUS);
  for (let r = minR; r <= maxR; r += 1) {
    for (let c = minC; c <= maxC; c += 1) {
      if (r < 0 || c < 0 || r >= ROWS || c >= COLS || grid[r][c] !== "#") continue;
      const nearestX = Math.max(c, Math.min(x, c + 1));
      const nearestY = Math.max(r, Math.min(y, r + 1));
      const dx = x - nearestX;
      const dy = y - nearestY;
      if (dx * dx + dy * dy < RADIUS * RADIUS) return true;
    }
  }
  return false;
}

function moveBody(grid, body, dx, dy) {
  const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / 0.18));
  const sx = dx / steps;
  const sy = dy / steps;
  for (let i = 0; i < steps; i += 1) {
    body.x += sx;
    if (circleHits(grid, body.x, body.y)) body.x -= sx;
    body.y += sy;
    if (circleHits(grid, body.x, body.y)) body.y -= sy;
  }
}

function flowOf(cell) {
  if (cell === "v") return { x: 0, y: 1 };
  if (cell === "^") return { x: 0, y: -1 };
  if (cell === ">") return { x: 1, y: 0 };
  if (cell === "<") return { x: -1, y: 0 };
  return null;
}

function heldIds(player) {
  if (!Array.isArray(player.held)) player.held = player.bell == null ? [] : [player.bell];
  player.bell = player.held.length ? player.held[0] : null;
  return player.held;
}

function dropBell(room, player) {
  const ids = heldIds(player).slice();
  player.held = [];
  player.bell = null;
  for (const id of ids) {
    const bell = room.bells.find((item) => item.id === id);
    if (!bell || bell.banked) continue;
    bell.carriedBy = null;
    bell.x = player.x;
    bell.y = player.y;
  }
}

function atPool(room, player) {
  if (tileAt(room.grid, player.x, player.y) === "H") return true;
  return Math.hypot(player.x - room.hatch.x, player.y - room.hatch.y) < 1.7;
}

function drown(room, player) {
  dropBell(room, player);
  player.x = room.hatch.x;
  player.y = room.hatch.y + 0.8;
  if (circleHits(room.grid, player.x, player.y)) {
    player.x = room.hatch.x;
    player.y = room.hatch.y;
  }
  player.air = AIR_MAX;
  player.stun = STUN;
  player.ix = 0;
  player.iy = 0;
}

/**
 * Swim, steal, and bank. Returns the id of a diver who surfaced enough bells.
 * players need x, y, ix, iy, air, stun, bell, banks, connected, inRound, stealLock, id.
 */
function step(room, dt) {
  const live = room.players.filter((player) => player.connected && player.inRound);
  for (let i = 0; i < live.length; i += 1) {
    for (let j = i + 1; j < live.length; j += 1) {
      const a = live[i];
      const b = live[j];
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      const dist = Math.hypot(dx, dy) || 0.001;
      if (dist >= 0.46) continue;
      const push = (0.46 - dist) * 0.35;
      dx /= dist;
      dy /= dist;
      moveBody(room.grid, a, -dx * push, -dy * push);
      moveBody(room.grid, b, dx * push, dy * push);
    }
  }

  for (const player of live) {
    player.stealLock = Math.max(0, (player.stealLock || 0) - dt);
    if (player.stun > 0) {
      player.stun = Math.max(0, player.stun - dt);
      player.ix = 0;
      player.iy = 0;
    }
    let ix = player.ix || 0;
    let iy = player.iy || 0;
    const mag = Math.hypot(ix, iy);
    if (mag > 1) {
      ix /= mag;
      iy /= mag;
    }
    const carrying = heldIds(player).length;
    const speed = carrying ? Math.max(3.1, CARRY - (carrying - 1) * 0.7) : SPEED;
    let dx = ix * speed * dt;
    let dy = iy * speed * dt;
    const flow = player.stun > 0 ? null : flowOf(tileAt(room.grid, player.x, player.y));
    if (flow) {
      dx += flow.x * CURRENT * dt;
      dy += flow.y * CURRENT * dt;
    }
    if (player.stun <= 0) moveBody(room.grid, player, dx, dy);
    const here = tileAt(room.grid, player.x, player.y);
    if (here === "V") player.air = Math.min(AIR_MAX, player.air + AIR_FILL * dt);
    else if (player.stun <= 0) player.air = Math.max(0, player.air - AIR_DRAIN * dt);
    if (player.air <= 0 && player.stun <= 0) drown(room, player);
  }

  for (const player of live) {
    if (player.stun > 0 || player.stealLock > 0) continue;
    let best = null;
    let bestDist = STEAL;
    for (const other of live) {
      if (other === player || !heldIds(other).length || other.stun > 0) continue;
      const dist = Math.hypot(other.x - player.x, other.y - player.y);
      if (dist < bestDist) {
        bestDist = dist;
        best = other;
      }
    }
    if (!best) continue;
    const id = best.held.shift();
    heldIds(best);
    const bell = room.bells.find((item) => item.id === id);
    heldIds(player).push(id);
    heldIds(player);
    if (bell) bell.carriedBy = player.id;
    player.stealLock = 1.5;
    best.stealLock = 1.5;
  }

  for (const bell of room.bells) {
    if (bell.banked || bell.carriedBy) continue;
    let best = null;
    let bestDist = PICKUP;
    for (const player of live) {
      if (player.stun > 0 || player.stealLock > 0) continue;
      if (heldIds(player).includes(bell.id)) continue;
      const dist = Math.hypot(bell.x - player.x, bell.y - player.y);
      if (dist < bestDist) {
        bestDist = dist;
        best = player;
      }
    }
    if (!best) continue;
    heldIds(best).push(bell.id);
    heldIds(best);
    bell.carriedBy = best.id;
  }

  let winner = null;
  for (const player of live) {
    const carried = heldIds(player);
    if (!carried.length || player.stun > 0 || !atPool(room, player)) continue;
    for (const id of carried.slice()) {
      const bell = room.bells.find((item) => item.id === id);
      if (!bell || bell.banked) continue;
      bell.banked = true;
      bell.carriedBy = null;
      bell.x = room.hatch.x + (bell.id - 1) * 1.25;
      bell.y = room.hatch.y;
      player.banks += 1;
    }
    player.held = [];
    player.bell = null;
    if (player.banks >= BANKS) winner = player.id;
  }

  for (const bell of room.bells) {
    if (bell.banked || !bell.carriedBy) continue;
    const carrier = live.find((player) => player.id === bell.carriedBy);
    if (!carrier) continue;
    const carried = heldIds(carrier);
    const index = Math.max(0, carried.indexOf(bell.id));
    const span = carried.length <= 1 ? 0 : Math.min(1.4, 0.7 * (carried.length - 1));
    const angle = -Math.PI / 2 + (carried.length <= 1 ? 0 : -span / 2 + (span * index) / (carried.length - 1));
    bell.x = carrier.x + Math.cos(angle) * 0.95;
    bell.y = carrier.y + Math.sin(angle) * 0.95;
  }
  return winner;
}

function cameraFor(room) {
  const live = room.players.filter((player) => player.connected && player.inRound);
  if (!live.length) return { x: room.hatch.x, y: room.hatch.y + 4 };
  let x = 0;
  let y = 0;
  let weight = 0;
  for (const player of live) {
    const pull = player.bell == null ? 1 : 3;
    x += player.x * pull;
    y += player.y * pull;
    weight += pull;
  }
  return { x: x / weight, y: y / weight };
}

function attachFathom(io, httpServer) {
  const nsp = io.of("/fathom");
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

  function placePlayers(room) {
    const seated = room.players.filter((player) => player.connected);
    seated.forEach((player, index) => {
      const offset = (index - (seated.length - 1) / 2) * 0.72;
      player.x = room.hatch.x + offset;
      player.y = room.hatch.y + 1.15;
      if (circleHits(room.grid, player.x, player.y)) {
        player.x = room.hatch.x;
        player.y = room.hatch.y;
      }
      player.ix = 0;
      player.iy = 0;
      player.air = AIR_MAX;
      player.stun = 0;
      player.bell = null;
      player.held = [];
      player.banks = 0;
      player.stealLock = 0;
      player.inRound = true;
    });
  }

  function worldFor(room, viewerId) {
    const camera = cameraFor(room);
    return {
      code: room.code,
      status: room.status,
      hostId: room.hostId,
      you: viewerId,
      endsAt: room.endsAt,
      need: BANKS,
      winnerId: room.winnerId,
      reason: room.reason,
      results: room.results || null,
      lanOrigins: lanOrigins(portOf()),
      cols: COLS,
      rows: ROWS,
      chart: room.chart,
      camera: {
        x: Math.round(camera.x * 1000) / 1000,
        y: Math.round(camera.y * 1000) / 1000,
      },
      bells: room.bells.map((bell) => ({
        id: bell.id,
        x: Math.round(bell.x * 1000) / 1000,
        y: Math.round(bell.y * 1000) / 1000,
        carriedBy: bell.carriedBy,
        banked: bell.banked,
      })),
      players: room.players.map((player) => ({
        id: player.id,
        name: player.name,
        color: player.color,
        slot: player.slot,
        x: Math.round(player.x * 1000) / 1000,
        y: Math.round(player.y * 1000) / 1000,
        air: Math.round(player.air),
        banks: player.banks,
        bell: player.bell,
        holding: heldIds(player).length,
        stun: player.stun > 0,
        inRound: player.inRound,
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
    if (room.players.length < 2) return "Need at least two divers.";
    const level = createLevel();
    room.grid = level.grid;
    room.bells = level.bells;
    room.hatch = level.hatch;
    room.chart = level.chart;
    room.winnerId = null;
    room.reason = null;
    room.results = null;
    placePlayers(room);
    room.status = "countdown";
    room.endsAt = Date.now() + countMs();
    clearTimeout(room.phaseTimer);
    room.phaseTimer = setTimeout(() => {
      if (!rooms.has(room.code) || room.status !== "countdown") return;
      room.status = "playing";
      room.endsAt = Date.now() + roundMs();
      room.phaseTimer = setTimeout(() => finishRound(room, false), roundMs());
      emitWorld(room);
    }, countMs());
    emitWorld(room);
    return null;
  }

  function finishRound(room, earlyId) {
    if (!rooms.has(room.code) || room.status === "gallery") return;
    clearTimeout(room.phaseTimer);
    room.status = "gallery";
    room.endsAt = null;
    if (earlyId) {
      room.winnerId = earlyId;
      room.reason = "banked";
    } else {
      const verdict = decide(room);
      room.winnerId = verdict.id;
      room.reason = verdict.reason;
    }
    for (const player of room.players) {
      player.ix = 0;
      player.iy = 0;
    }
    room.results = room.players.map((player) => ({
      id: player.id,
      name: player.name,
      color: player.color,
      banks: player.banks,
    }));
    emitWorld(room);
  }

  function decide(room) {
    const people = room.players.filter((player) => player.inRound && player.connected);
    if (!people.length) return { id: null, reason: "none" };
    const top = Math.max(...people.map((player) => player.banks));
    let pool = people.filter((player) => player.banks === top);
    if (top > 0 && pool.length === 1) return { id: pool[0].id, reason: "banked" };
    const holding = pool.filter((player) => player.bell != null);
    if (holding.length === 1) return { id: holding[0].id, reason: "carrying" };
    if (top === 0 && !holding.length) return { id: null, reason: "none" };
    pool = pool.slice().sort((a, b) => {
      const ah = Math.hypot(a.x - room.hatch.x, a.y - room.hatch.y);
      const bh = Math.hypot(b.x - room.hatch.x, b.y - room.hatch.y);
      return ah - bh;
    });
    return { id: pool[0].id, reason: top > 0 ? "closest" : "carrying" };
  }

  function tick(room) {
    if (room.status !== "playing") return;
    if (room.endsAt && Date.now() >= room.endsAt) {
      finishRound(room, null);
      return;
    }
    const winner = step(room, tickMs() / 1000);
    if (winner) finishRound(room, winner);
    else emitWorld(room);
  }

  function link(socket, room, player) {
    socket.join(room.code);
    socketRoom.set(socket.id, { code: room.code, playerId: player.id });
    player.socketId = socket.id;
    player.connected = true;
    clearTimeout(player.dropTimer);
  }

  function removePlayer(room, playerId) {
    const player = room.players.find((item) => item.id === playerId);
    if (player) dropBell(room, player);
    room.players = room.players.filter((item) => item.id !== playerId);
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
    player.ix = 0;
    player.iy = 0;
    if (room.status === "playing") dropBell(room, player);
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

  function blankPlayer(name, slot, socketId) {
    return {
      id: crypto.randomBytes(8).toString("hex"),
      name,
      slot,
      color: COLORS[(slot - 1) % COLORS.length],
      x: 0,
      y: 0,
      ix: 0,
      iy: 0,
      air: AIR_MAX,
      stun: 0,
      bell: null,
      held: [],
      banks: 0,
      stealLock: 0,
      inRound: false,
      socketId,
      connected: true,
      dropTimer: null,
    };
  }

  nsp.on("connection", (socket) => {
    socket.on("createRoom", (payload, ack) => {
      const name = cleanName(payload && payload.name);
      if (!name) return reply(ack, { ok: false, error: "Enter your name." });
      const level = createLevel();
      const room = {
        code: makeCode(),
        hostId: null,
        status: "lobby",
        players: [],
        grid: level.grid,
        bells: level.bells,
        hatch: level.hatch,
        chart: level.chart,
        winnerId: null,
        reason: null,
        endsAt: null,
        tick: null,
        phaseTimer: null,
      };
      room.tick = setInterval(() => tick(room), tickMs());
      const player = blankPlayer(name, 1, socket.id);
      player.x = room.hatch.x;
      player.y = room.hatch.y + 1.15;
      room.players.push(player);
      room.hostId = player.id;
      rooms.set(room.code, room);
      link(socket, room, player);
      reply(ack, { ok: true, playerId: player.id, code: room.code, name });
      emitWorld(room);
    });

    socket.on("joinRoom", (payload, ack) => {
      const room = rooms.get(cleanCode(payload && payload.code));
      if (!room) return reply(ack, { ok: false, error: "No cave with that code." });
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
      if (room.players.length >= MAX_PLAYERS) return reply(ack, { ok: false, error: "This cave is full." });
      const player = blankPlayer(name, takeSlot(room), socket.id);
      player.x = room.hatch.x;
      player.y = room.hatch.y + 1.15;
      player.inRound = room.status === "lobby" || room.status === "gallery";
      room.players.push(player);
      link(socket, room, player);
      reply(ack, { ok: true, playerId: player.id, code: room.code, name });
      emitWorld(room);
    });

    socket.on("start", (_payload, ack) => {
      const linkInfo = socketRoom.get(socket.id);
      const room = linkInfo && rooms.get(linkInfo.code);
      const player = room && room.players.find((item) => item.id === linkInfo.playerId);
      if (!room || !player) return reply(ack, { ok: false, error: "You are not in a cave." });
      if (!canStart(room, player.id)) return reply(ack, { ok: false, error: "Only the host can start." });
      if (room.status === "playing" || room.status === "countdown") {
        return reply(ack, { ok: false, error: "The dive already started." });
      }
      const error = beginRound(room);
      reply(ack, { ok: !error, error: error || null });
    });

    socket.on("input", (payload) => {
      const linkInfo = socketRoom.get(socket.id);
      const room = linkInfo && rooms.get(linkInfo.code);
      if (!room || room.status !== "playing") return;
      const player = room.players.find((item) => item.id === linkInfo.playerId);
      if (!player || !player.connected || !player.inRound || player.stun > 0) return;
      let x = Number(payload && payload.x);
      let y = Number(payload && payload.y);
      if (!Number.isFinite(x)) x = 0;
      if (!Number.isFinite(y)) y = 0;
      player.ix = Math.max(-1, Math.min(1, x));
      player.iy = Math.max(-1, Math.min(1, y));
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

function resetFathom() {
  for (const room of [...rooms.values()]) {
    clearInterval(room.tick);
    clearTimeout(room.phaseTimer);
    for (const player of room.players) clearTimeout(player.dropTimer);
    rooms.delete(room.code);
  }
}

module.exports = {
  attachFathom,
  resetFathom,
  step,
  createLevel,
  COLS,
  ROWS,
  BANKS,
  RADIUS,
};

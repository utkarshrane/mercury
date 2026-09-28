"use strict";

const http = require("http");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const { Server } = require("socket.io");
const rules = require("./rules");

const PORT = Number(process.env.PORT) || 3000;
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const COLORS = ["#e23d2b", "#e0a15a", "#7f9a72", "#d4789a", "#7aa2c4", "#c46b3a"];
const MAX_PLAYERS = 6;

const rooms = new Map();

const app = express();
app.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});
app.get("/health", (_req, res) => {
  res.json({ ok: true });
});
app.get("/rules.js", (_req, res) => {
  res.type("application/javascript");
  res.sendFile(path.join(__dirname, "rules.js"));
});
app.get("/dice", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "dice.html"));
});
app.get("/bloom", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "bloom.html"));
});
app.get("/fathom", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "fathom.html"));
});
app.use(express.static(path.join(__dirname, "public")));

function turnMs() {
  const n = Number(process.env.CALLIT_TURN_MS);
  return Number.isFinite(n) && n > 0 ? n : 50000;
}

function revealMs() {
  const n = Number(process.env.CALLIT_REVEAL_MS);
  return Number.isFinite(n) && n > 0 ? n : 6500;
}

function dropMs() {
  const n = Number(process.env.CALLIT_DROP_MS);
  return Number.isFinite(n) && n > 0 ? n : 60000;
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

function playerById(room, id) {
  return room.players.find((player) => player.id === id) || null;
}

function nextAliveId(room, afterId) {
  const start = Math.max(0, room.players.findIndex((player) => player.id === afterId));
  for (let step = 1; step <= room.players.length; step += 1) {
    const player = room.players[(start + step) % room.players.length];
    if (player && player.alive) return player.id;
  }
  return null;
}

function nextColor(room) {
  const used = new Set(room.players.map((player) => player.color));
  return COLORS.find((color) => !used.has(color)) || COLORS[room.players.length % COLORS.length];
}

function pushLog(room, text) {
  room.log.push(text);
  if (room.log.length > 14) room.log.shift();
}

function createRoom() {
  const room = {
    code: makeCode(),
    hostId: null,
    status: "lobby",
    players: [],
    round: 0,
    bid: null,
    turnPlayerId: null,
    turnDeadline: null,
    turnBudget: null,
    palifico: false,
    reveal: null,
    winnerId: null,
    log: [],
    timer: null,
  };
  rooms.set(room.code, room);
  return room;
}

function destroyRoom(code) {
  const room = rooms.get(code);
  if (!room) return;
  clearTimeout(room.timer);
  for (const player of room.players) clearTimeout(player.dropTimer);
  rooms.delete(code);
}

function ensureHost(room) {
  if (playerById(room, room.hostId)) return;
  const next = room.players.find((player) => player.connected) || room.players[0];
  room.hostId = next ? next.id : null;
}

function canDeal(room, playerId) {
  if (playerId === room.hostId) return true;
  const host = playerById(room, room.hostId);
  return !host || !host.connected;
}

function addPlayer(room, name, socketId) {
  const inHand = room.status === "playing" || room.status === "reveal";
  const player = {
    id: crypto.randomBytes(8).toString("hex"),
    name,
    socketId,
    color: nextColor(room),
    dice: [],
    alive: false,
    waiting: inHand,
    connected: true,
    dropTimer: null,
  };
  room.players.push(player);
  if (inHand) pushLog(room, `${name} will join the next game.`);
  return player;
}

function attach(httpServer) {
  const io = new Server(httpServer);
  const socketRoom = new Map();

  function portOf() {
    const address = httpServer.address();
    if (address && typeof address === "object") return address.port;
    return PORT;
  }

  function emitState(room) {
    if (!rooms.has(room.code)) return;
    for (const player of room.players) {
      if (!player.socketId) continue;
      const socket = io.sockets.sockets.get(player.socketId);
      if (socket) socket.emit("state", viewFor(room, player.id));
    }
  }

  function viewFor(room, viewerId) {
    const exposed = room.status === "reveal" || room.status === "gameover";
    return {
      code: room.code,
      status: room.status,
      hostId: room.hostId,
      round: room.round,
      bid: room.bid,
      turnPlayerId: room.turnPlayerId,
      turnDeadline: room.turnDeadline,
      turnBudget: room.turnBudget,
      palifico: room.palifico,
      winnerId: room.winnerId,
      reveal: room.reveal,
      log: room.log,
      you: viewerId,
      totalDice: room.players.filter((player) => player.alive).reduce((sum, player) => sum + player.dice.length, 0),
      lanOrigins: lanOrigins(portOf()),
      players: room.players.map((player) => ({
        id: player.id,
        name: player.name,
        color: player.color,
        diceCount: player.dice.length,
        alive: player.alive,
        waiting: player.waiting,
        connected: player.connected,
        dice: exposed || player.id === viewerId ? player.dice.slice() : null,
      })),
    };
  }

  function armTimer(room, ms, fn) {
    clearTimeout(room.timer);
    room.turnBudget = ms;
    room.turnDeadline = Date.now() + ms;
    room.timer = setTimeout(fn, ms);
  }

  function endGame(room, winner, keepReveal) {
    clearTimeout(room.timer);
    room.status = "gameover";
    room.turnPlayerId = null;
    room.turnDeadline = null;
    room.turnBudget = null;
    room.winnerId = winner ? winner.id : null;
    if (!keepReveal) room.reveal = null;
    if (winner) pushLog(room, `${winner.name} takes the table.`);
    emitState(room);
  }

  function openRound(room, openerId, fresh) {
    const alive = room.players.filter((player) => player.alive);
    if (alive.length < 2) {
      endGame(room, alive[0] || null, !fresh);
      return;
    }
    if (!fresh) room.round += 1;
    for (const player of alive) player.dice = rules.rollDice(player.dice.length);
    room.palifico = alive.some((player) => player.dice.length === 1);
    room.status = "playing";
    room.bid = null;
    room.reveal = null;
    let opener = playerById(room, openerId);
    if (!opener || !opener.alive) {
      openerId = nextAliveId(room, openerId);
      opener = playerById(room, openerId);
    }
    if (!opener) {
      endGame(room, alive[0] || null, false);
      return;
    }
    room.turnPlayerId = opener.id;
    if (fresh) {
      room.log = [];
      pushLog(room, `${opener.name} opens. Five dice each. Ones are wild.`);
    } else if (room.palifico) {
      pushLog(room, `Palifico. ${opener.name} opens. Ones are not wild.`);
    } else {
      pushLog(room, `Round ${room.round}. ${opener.name} opens.`);
    }
    armTimer(room, turnMs(), () => autoAct(room));
    emitState(room);
  }

  function startGame(room, requesterId) {
    if (!canDeal(room, requesterId)) return "Only the host can deal.";
    if (room.status === "playing" || room.status === "reveal") return "Finish this hand first.";
    room.players = room.players.filter((player) => player.connected);
    ensureHost(room);
    if (room.players.length < 2) return "Need at least two players.";
    if (room.players.length > MAX_PLAYERS) return "Six players is the maximum.";
    for (const player of room.players) {
      player.alive = true;
      player.waiting = false;
      player.dice = [1, 1, 1, 1, 1];
    }
    room.round = 1;
    room.winnerId = null;
    const opener = room.players[crypto.randomInt(0, room.players.length)];
    openRound(room, opener.id, true);
    return null;
  }

  function applyRaise(room, player, next) {
    if (room.status !== "playing") return "The round is not open.";
    if (!player.alive) return "You are out of this game.";
    if (player.id !== room.turnPlayerId) return "It is not your turn.";
    const total = room.players.filter((p) => p.alive).reduce((sum, p) => sum + p.dice.length, 0);
    const verdict = rules.isLegalBid(room.bid, next, { palifico: room.palifico, maxQty: total });
    if (!verdict.ok) return verdict.reason;
    room.bid = { qty: next.qty, face: next.face, playerId: player.id, name: player.name };
    pushLog(room, `${player.name} bids ${rules.bidPhrase(next.qty, next.face)}.`);
    room.turnPlayerId = nextAliveId(room, player.id);
    armTimer(room, turnMs(), () => autoAct(room));
    emitState(room);
    return null;
  }

  function resolveCall(room, caller) {
    if (room.status !== "playing") return "The round is not open.";
    if (!caller.alive) return "You are out of this game.";
    if (caller.id !== room.turnPlayerId) return "It is not your turn.";
    if (!room.bid) return "There is no bid to call.";

    const hidden = room.players.filter((player) => player.alive).flatMap((player) => player.dice);
    const count = rules.countFace(hidden, room.bid.face, !room.palifico);
    const holds = count >= room.bid.qty;
    const loserId = holds ? caller.id : room.bid.playerId;
    const loser = playerById(room, loserId);
    const phrase = rules.bidPhrase(room.bid.qty, room.bid.face);
    let eliminatedId = null;
    if (loser && loser.alive && loser.dice.length > 0) {
      loser.dice.pop();
      if (loser.dice.length === 0) {
        loser.alive = false;
        eliminatedId = loser.id;
      }
      pushLog(
        room,
        holds
          ? `${phrase} stood. ${count} on the table. ${loser.name} loses a die.`
          : `${phrase} was a bluff. ${count} on the table. ${loser.name} loses a die.`
      );
      if (eliminatedId) pushLog(room, `${loser.name} is out.`);
    } else {
      pushLog(room, `${phrase} ${holds ? "stood" : "was a bluff"}. ${count} on the table.`);
    }
    room.reveal = {
      bid: { qty: room.bid.qty, face: room.bid.face, playerId: room.bid.playerId, name: room.bid.name },
      count,
      holds,
      loserId,
      eliminatedId,
    };
    room.status = "reveal";
    armTimer(room, revealMs(), () => {
      if (!rooms.has(room.code) || room.status !== "reveal") return;
      advance(room);
    });
    emitState(room);
    return null;
  }

  function advance(room) {
    if (room.status !== "reveal") return;
    room.status = "dealing";
    clearTimeout(room.timer);
    const alive = room.players.filter((player) => player.alive);
    if (alive.length < 2) {
      endGame(room, alive[0] || null, true);
      return;
    }
    const openerId = room.reveal ? room.reveal.loserId : room.turnPlayerId;
    openRound(room, openerId, false);
  }

  function autoAct(room) {
    if (!rooms.has(room.code) || room.status !== "playing") return;
    const player = playerById(room, room.turnPlayerId);
    if (!player || !player.alive) return;
    if (!room.bid) applyRaise(room, player, { qty: 1, face: 2 });
    else resolveCall(room, player);
  }

  function forfeit(room, playerId) {
    const player = playerById(room, playerId);
    if (!player || !player.alive) return;
    const wasTurn = room.turnPlayerId === playerId && room.status === "playing";
    player.alive = false;
    player.dice = [];
    pushLog(room, `${player.name} left the table.`);
    if (!room.players.some((p) => p.connected)) {
      destroyRoom(room.code);
      return;
    }
    const alive = room.players.filter((p) => p.alive);
    if (alive.length < 2) {
      endGame(room, alive[0] || null, room.status === "reveal");
      return;
    }
    if (wasTurn) {
      room.turnPlayerId = nextAliveId(room, playerId);
      armTimer(room, turnMs(), () => autoAct(room));
    }
    emitState(room);
  }

  function dropLater(room, player) {
    clearTimeout(player.dropTimer);
    player.dropTimer = setTimeout(() => {
      const current = rooms.get(room.code);
      if (!current) return;
      const still = playerById(current, player.id);
      if (!still || still.connected) return;
      if (current.status === "lobby" || current.status === "gameover") {
        current.players = current.players.filter((p) => p.id !== still.id);
        ensureHost(current);
        if (!current.players.length) destroyRoom(current.code);
        else emitState(current);
      } else {
        forfeit(current, still.id);
      }
    }, dropMs());
  }

  function unlink(socket, immediate) {
    const link = socketRoom.get(socket.id);
    socketRoom.delete(socket.id);
    if (!link) return;
    const room = rooms.get(link.code);
    if (!room) return;
    const player = playerById(room, link.playerId);
    if (!player || player.socketId !== socket.id) return;
    player.connected = false;
    player.socketId = null;
    if (immediate) {
      clearTimeout(player.dropTimer);
      if (room.status === "lobby" || room.status === "gameover") {
        room.players = room.players.filter((p) => p.id !== player.id);
        ensureHost(room);
        if (!room.players.length) destroyRoom(room.code);
        else emitState(room);
      } else {
        forfeit(room, player.id);
      }
      return;
    }
    ensureHost(room);
    dropLater(room, player);
    if (rooms.has(room.code)) emitState(room);
  }

  function link(socket, room, player) {
    socketRoom.set(socket.id, { code: room.code, playerId: player.id });
    player.socketId = socket.id;
    player.connected = true;
    clearTimeout(player.dropTimer);
  }

  function parseBid(payload) {
    const qty = Number(payload && payload.qty);
    const face = Number(payload && payload.face);
    if (!Number.isInteger(qty) || !Number.isInteger(face)) return null;
    return { qty, face };
  }

  function reply(ack, body) {
    if (typeof ack === "function") ack(body);
  }

  io.on("connection", (socket) => {
    socket.on("createRoom", (payload, ack) => {
      const name = cleanName(payload && payload.name);
      if (!name) return reply(ack, { ok: false, error: "Enter your name." });
      const room = createRoom();
      const player = addPlayer(room, name, socket.id);
      room.hostId = player.id;
      link(socket, room, player);
      reply(ack, { ok: true, playerId: player.id, code: room.code, name });
      emitState(room);
    });

    socket.on("joinRoom", (payload, ack) => {
      const code = cleanCode(payload && payload.code);
      const room = rooms.get(code);
      if (!room) return reply(ack, { ok: false, error: "No table with that code." });
      const existing = payload && payload.playerId ? playerById(room, payload.playerId) : null;
      if (existing) {
        link(socket, room, existing);
        reply(ack, { ok: true, playerId: existing.id, code: room.code, name: existing.name });
        emitState(room);
        return;
      }
      const name = cleanName(payload && payload.name);
      if (!name) return reply(ack, { ok: false, error: "Enter your name." });
      if (room.players.length >= MAX_PLAYERS) return reply(ack, { ok: false, error: "This table is full." });
      const player = addPlayer(room, name, socket.id);
      link(socket, room, player);
      reply(ack, { ok: true, playerId: player.id, code: room.code, name });
      emitState(room);
    });

    socket.on("startGame", (_payload, ack) => {
      const linkInfo = socketRoom.get(socket.id);
      const room = linkInfo && rooms.get(linkInfo.code);
      const player = room && playerById(room, linkInfo.playerId);
      if (!room || !player) return reply(ack, { ok: false, error: "You are not at a table." });
      const error = startGame(room, player.id);
      reply(ack, { ok: !error, error: error || null });
    });

    socket.on("raise", (payload, ack) => {
      const linkInfo = socketRoom.get(socket.id);
      const room = linkInfo && rooms.get(linkInfo.code);
      const player = room && playerById(room, linkInfo.playerId);
      if (!room || !player) return reply(ack, { ok: false, error: "You are not at a table." });
      const bid = parseBid(payload);
      if (!bid) return reply(ack, { ok: false, error: "That bid is not a real bid." });
      const error = applyRaise(room, player, bid);
      reply(ack, { ok: !error, error: error || null });
    });

    socket.on("call", (_payload, ack) => {
      const linkInfo = socketRoom.get(socket.id);
      const room = linkInfo && rooms.get(linkInfo.code);
      const player = room && playerById(room, linkInfo.playerId);
      if (!room || !player) return reply(ack, { ok: false, error: "You are not at a table." });
      const error = resolveCall(room, player);
      reply(ack, { ok: !error, error: error || null });
    });

    socket.on("continue", (_payload, ack) => {
      const linkInfo = socketRoom.get(socket.id);
      const room = linkInfo && rooms.get(linkInfo.code);
      if (!room) return reply(ack, { ok: false, error: "You are not at a table." });
      advance(room);
      reply(ack, { ok: true, error: null });
    });

    socket.on("rematch", (_payload, ack) => {
      const linkInfo = socketRoom.get(socket.id);
      const room = linkInfo && rooms.get(linkInfo.code);
      const player = room && playerById(room, linkInfo.playerId);
      if (!room || !player) return reply(ack, { ok: false, error: "You are not at a table." });
      if (room.status !== "gameover") return reply(ack, { ok: false, error: "Finish this hand first." });
      const error = startGame(room, player.id);
      reply(ack, { ok: !error, error: error || null });
    });

    socket.on("leave", (_payload, ack) => {
      unlink(socket, true);
      reply(ack, { ok: true });
    });

    socket.on("disconnect", () => {
      unlink(socket, false);
    });
  });

  return io;
}

if (require.main === module) {
  const server = http.createServer(app);
  const io = attach(server);
  require("./bloom-server").attachBloom(io, server);
  require("./mercury-server").attachMercury(io, server);
  require("./fathom-server").attachFathom(io, server);
  server.listen(PORT, () => {
    const address = server.address();
    const port = address && typeof address === "object" ? address.port : PORT;
    console.log(`FATHOM is live at http://localhost:${port}/fathom`);
    console.log(`MERCURY is live at http://localhost:${port}`);
    console.log(`BLOOM is at http://localhost:${port}/bloom`);
    console.log(`CALL IT is at http://localhost:${port}/dice`);
    for (const origin of lanOrigins(port)) {
      console.log(`Same Wi-Fi: ${origin}`);
    }
  });
}

function resetRooms() {
  for (const code of [...rooms.keys()]) destroyRoom(code);
}

module.exports = { app, attach, resetRooms };

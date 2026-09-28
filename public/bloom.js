"use strict";

const COLS = 180;
const ROWS = 108;
const SPEED = 0.52;
const COLORS = ["#ff4d3a", "#ffc14d", "#2ad4b0", "#8b7cff", "#ff5fa2", "#c6ef5a", "#59b7ff", "#ff8d4d"];

const canvas = document.getElementById("court");
const ctx = canvas.getContext("2d");
const paint = document.createElement("canvas");
const paintCtx = paint.getContext("2d");
const panel = document.getElementById("panel");
const hud = document.getElementById("hud");
const countEl = document.getElementById("count");
const banner = document.getElementById("banner");

const params = new URLSearchParams(location.search);
const invited = (params.get("room") || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4);

let world = null;
let grid = new Uint8Array(COLS * ROWS);
let panelMode = "";
let draftName = localStorage.getItem("bloom-name") || localStorage.getItem("callit-name") || "";
let draftCode = invited;
let leftOnPurpose = false;
let pointerId = null;
let pointer = null;
const keys = new Set();
const shown = new Map();
let lastFrame = performance.now();
let court = { x: 24, y: 88, w: 300, h: 180 };
let ambientOn = true;
const ambient = Array.from({ length: 6 }, (_, i) => ({
  x: 0.2 + Math.random() * 0.6,
  y: 0.2 + Math.random() * 0.6,
  a: Math.random() * Math.PI * 2,
  s: 0.04 + Math.random() * 0.05,
  color: COLORS[i % COLORS.length],
}));

const socket = io("/bloom", { autoConnect: true });

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[ch]));
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function toast(message) {
  const node = document.getElementById("toast");
  node.textContent = message;
  node.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => node.classList.remove("show"), 2800);
}

function loadSession() {
  try { return JSON.parse(sessionStorage.getItem("bloom") || "null"); }
  catch { return null; }
}

function saveSession(session) {
  sessionStorage.setItem("bloom", JSON.stringify(session));
  if (session.name) localStorage.setItem("bloom-name", session.name);
}

function clearSession() {
  sessionStorage.removeItem("bloom");
}

function colorForSlot(slot) {
  const player = world && world.players.find((item) => item.slot === slot);
  return player ? player.color : COLORS[(slot - 1) % COLORS.length];
}

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = window.innerWidth;
  const height = window.innerHeight;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const hudHeight = world && world.status !== "lobby" ? 96 : 28;
  court = {
    x: 18,
    y: hudHeight,
    w: Math.max(120, width - 36),
    h: Math.max(120, height - hudHeight - 24),
  };
  paint.width = Math.round(court.w * dpr);
  paint.height = Math.round(court.h * dpr);
  redrawPaint();
}

function stamp(context, x, y, radius, color) {
  const glow = context.createRadialGradient(x, y, radius * 0.15, x, y, radius * 1.45);
  glow.addColorStop(0, color);
  glow.addColorStop(0.62, color);
  glow.addColorStop(1, "rgba(16, 14, 12, 0)");
  context.fillStyle = glow;
  context.beginPath();
  context.arc(x, y, radius * 1.45, 0, Math.PI * 2);
  context.fill();
}

function fillCell(ix, iy, color) {
  const cw = paint.width / COLS;
  const ch = paint.height / ROWS;
  paintCtx.fillStyle = color;
  paintCtx.fillRect(ix * cw, iy * ch, cw + 0.8, ch + 0.8);
}

function redrawPaint() {
  paintCtx.clearRect(0, 0, paint.width, paint.height);
  if (!paint.width || !paint.height) return;
  for (let i = 0; i < grid.length; i += 1) {
    const owner = grid[i];
    if (!owner) continue;
    fillCell(i % COLS, (i / COLS) | 0, colorForSlot(owner));
  }
}

function applyPaint(cells) {
  if (!paint.width) return;
  for (let i = 0; i < cells.length; i += 2) {
    const idx = cells[i];
    const slot = cells[i + 1];
    if (idx < 0 || idx >= grid.length) continue;
    grid[idx] = slot;
    fillCell(idx % COLS, (idx / COLS) | 0, colorForSlot(slot));
  }
}

function localStamp(x, y, slot) {
  if (!paint.width) return;
  const cw = paint.width / COLS;
  const ch = paint.height / ROWS;
  paintCtx.fillStyle = colorForSlot(slot);
  paintCtx.beginPath();
  paintCtx.arc(x * paint.width, y * paint.height, Math.max(cw, ch) * 7.2, 0, Math.PI * 2);
  paintCtx.fill();
}

function roundRect(context, x, y, w, h, r) {
  context.beginPath();
  context.moveTo(x + r, y);
  context.arcTo(x + w, y, x + w, y + h, r);
  context.arcTo(x + w, y + h, x, y + h, r);
  context.arcTo(x, y + h, x, y, r);
  context.arcTo(x, y, x + w, y, r);
  context.closePath();
}

function desired() {
  let x = 0;
  let y = 0;
  if (keys.has("arrowleft") || keys.has("a")) x -= 1;
  if (keys.has("arrowright") || keys.has("d")) x += 1;
  if (keys.has("arrowup") || keys.has("w")) y -= 1;
  if (keys.has("arrowdown") || keys.has("s")) y += 1;
  const me = world && world.players.find((player) => player.id === world.you);
  const view = me && shown.get(me.id);
  if (pointer && view) {
    x += pointer.x - view.x;
    y += pointer.y - view.y;
  }
  const mag = Math.hypot(x, y);
  if (mag > 1) {
    x /= mag;
    y /= mag;
  }
  return { x, y };
}

function drawAmbient(dt) {
  if (!paint.width) return;
  paintCtx.fillStyle = "rgba(16, 14, 12, 0.035)";
  paintCtx.fillRect(0, 0, paint.width, paint.height);
  const cw = paint.width / COLS;
  const ch = paint.height / ROWS;
  const radius = Math.max(cw, ch) * 2.4;
  for (const walker of ambient) {
    walker.a += dt * 0.6;
    walker.x += Math.cos(walker.a) * walker.s * dt;
    walker.y += Math.sin(walker.a * 0.8) * walker.s * dt;
    if (walker.x < 0.08 || walker.x > 0.92) walker.a = Math.PI - walker.a;
    if (walker.y < 0.08 || walker.y > 0.92) walker.a = -walker.a;
    walker.x = clamp(walker.x, 0.05, 0.95);
    walker.y = clamp(walker.y, 0.05, 0.95);
    stamp(
      paintCtx,
      walker.x * paint.width,
      walker.y * paint.height,
      radius,
      walker.color
    );
  }
}

function drawPlayers(now) {
  if (!world) return;
  const me = world.players.find((player) => player.id === world.you);
  const vector = desired();
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  for (const player of world.players) {
    if (world.status !== "lobby" && world.status !== "gallery" && !player.connected && player.score === 0) continue;
    let view = shown.get(player.id);
    if (!view) view = { x: player.x, y: player.y };
    if (player.id === world.you && world.status === "playing") {
      const mag = Math.hypot(vector.x, vector.y);
      if (mag > 0.12) {
        view.x = clamp(view.x + vector.x * SPEED * dt, 0.015, 0.985);
        view.y = clamp(view.y + vector.y * SPEED * dt, 0.015, 0.985);
        localStamp(view.x, view.y, player.slot);
      }
      view.x += (player.x - view.x) * 0.18;
      view.y += (player.y - view.y) * 0.18;
    } else {
      view.x += (player.x - view.x) * 0.35;
      view.y += (player.y - view.y) * 0.35;
    }
    shown.set(player.id, view);
    const px = court.x + view.x * court.w;
    const py = court.y + view.y * court.h;
    const leader = world.players.every((other) => other.score <= player.score) && player.score > 0;
    const body = player.id === world.you ? 16 : 13;
    ctx.save();
    ctx.shadowColor = player.color;
    ctx.shadowBlur = leader ? 28 : 16;
    ctx.beginPath();
    ctx.fillStyle = player.color;
    ctx.arc(px, py, body, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.beginPath();
    ctx.lineWidth = leader ? 4 : 2.5;
    ctx.strokeStyle = player.id === world.you ? "#fffaf6" : "rgba(244,239,230,0.85)";
    ctx.arc(px, py, body, 0, Math.PI * 2);
    ctx.stroke();
    ctx.font = "600 14px Outfit, sans-serif";
    ctx.textAlign = "center";
    ctx.lineWidth = 4;
    ctx.strokeStyle = "rgba(16,14,12,0.8)";
    ctx.strokeText(player.name, px, py - 22);
    ctx.fillStyle = "#f4efe6";
    ctx.fillText(player.name, px, py - 22);
  }
  if (me && world.status === "playing" && !me.connected) return;
}

function frame(now) {
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  const width = window.innerWidth;
  const height = window.innerHeight;
  ctx.setTransform(Math.min(window.devicePixelRatio || 1, 2), 0, 0, Math.min(window.devicePixelRatio || 1, 2), 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#100e0c";
  ctx.fillRect(0, 0, width, height);
  if (ambientOn && (!world || world.status === "lobby")) drawAmbient(dt);
  roundRect(ctx, court.x, court.y, court.w, court.h, 28);
  ctx.save();
  ctx.clip();
  ctx.fillStyle = "#1a1511";
  ctx.fillRect(court.x, court.y, court.w, court.h);
  ctx.save();
  ctx.filter = "blur(7px)";
  ctx.globalAlpha = 0.55;
  ctx.drawImage(paint, court.x, court.y, court.w, court.h);
  ctx.filter = "blur(3px)";
  ctx.globalAlpha = 1;
  ctx.drawImage(paint, court.x, court.y, court.w, court.h);
  ctx.restore();
  drawPlayers(now);
  ctx.restore();
  ctx.strokeStyle = "rgba(244, 239, 230, 0.18)";
  ctx.lineWidth = 1.5;
  roundRect(ctx, court.x, court.y, court.w, court.h, 28);
  ctx.stroke();
  lastFrame = now;
  requestAnimationFrame(frame);
}

function rulesHtml() {
  return `
    <ol class="steps">
      <li>Move. Color stays where you go.</li>
      <li>Paint over someone and that floor becomes yours.</li>
      <li>When the clock ends, the most color wins.</li>
    </ol>`;
}

function inviteLinks() {
  if (!world) return [];
  const local = /^(localhost|127\.0\.0\.1)$/i.test(location.hostname);
  const origins = !local
    ? [location.origin]
    : (world.lanOrigins && world.lanOrigins.length ? world.lanOrigins : [location.origin]);
  return origins.map((origin) => `${origin}/bloom?room=${world.code}`);
}

function homeHtml() {
  return `
    <p class="eyebrow">${invited ? `Floor ${esc(invited)}` : "A floor for two to eight"}</p>
    <h1>BL<i>O</i>OM</h1>
    <p class="lede">Paint the floor. Take it back. Anyone with the code can join.</p>
    <div class="dots" aria-hidden="true">${COLORS.slice(0, 5).map((color) => `<i style="background:${color}"></i>`).join("")}</div>
    <label for="name">Your name</label>
    <input id="name" maxlength="16" autocomplete="nickname" placeholder="Name" value="${esc(draftName)}">
    <div class="actions">
      <button type="button" class="primary" data-act="create">Open a floor</button>
      <div class="join-row">
        <input id="code" maxlength="4" autocapitalize="characters" autocomplete="off" placeholder="CODE" value="${esc(draftCode)}" aria-label="Room code">
        <button type="button" class="ghost" data-act="join">Join</button>
      </div>
    </div>
    ${rulesHtml()}
    <p class="other"><a href="/">Play Mercury</a> · <a href="/dice">Play Call it</a></p>`;
}

function lobbyHtml() {
  const here = world.players.filter((player) => player.connected).length;
  const host = world.players.find((player) => player.id === world.hostId);
  const canStart = world.you === world.hostId || !host || !host.connected;
  const links = inviteLinks();
  return `
    <p class="eyebrow">Floor</p>
    <button type="button" class="ticket" data-act="copy-code">${esc(world.code)}</button>
    <p class="hint">Share the code. No accounts, no install.</p>
    ${links.map((link) => `<p class="share">${esc(link)}</p>`).join("")}
    <button type="button" class="ghost" data-act="copy-link">Copy invite link</button>
    <ul class="roster">
      ${world.players.map((player) => {
        const marks = [
          player.id === world.you ? "you" : "",
          player.id === world.hostId ? "host" : "",
          player.connected ? "" : "away",
        ].filter(Boolean).join(" · ");
        return `<li><i class="swatch" style="background:${esc(player.color)}"></i><span>${esc(player.name)}${marks ? ` · ${esc(marks)}` : ""}</span></li>`;
      }).join("")}
    </ul>
    ${rulesHtml()}
    ${canStart
      ? `<button type="button" class="primary" data-act="start" ${here < 2 ? "disabled" : ""}>Start the bloom</button>
         <p class="wait">${here < 2 ? "Need at least two players." : `${here} here. Start when everyone can see the rules.`}</p>`
      : `<p class="wait">Waiting for the host to start.</p>`}
    <button type="button" class="ghost" data-act="leave">Leave</button>`;
}

function galleryHtml() {
  const ranked = [...world.players].sort((a, b) => b.score - a.score);
  const top = ranked[0] ? ranked[0].score : 0;
  const winners = ranked.filter((player) => player.score === top && top > 0);
  const youWon = winners.some((player) => player.id === world.you);
  const title = !winners.length
    ? "Nobody painted"
    : winners.length > 1
      ? "The floor is split"
      : youWon
        ? "You take the floor"
        : `${winners[0].name} takes the floor`;
  const host = world.players.find((player) => player.id === world.hostId);
  const canStart = world.you === world.hostId || !host || !host.connected;
  return `
    <p class="eyebrow">The painting holds</p>
    <h2>${esc(title)}</h2>
    <ul class="roster">
      ${ranked.map((player) => `<li><i class="swatch" style="background:${esc(player.color)}"></i><span>${esc(player.name)} · ${Math.round(player.share * 100)}%</span></li>`).join("")}
    </ul>
    ${canStart
      ? `<button type="button" class="primary" data-act="start">Bloom again</button>`
      : `<p class="wait">Waiting for the host to bloom again.</p>`}`;
}

let hudKey = "";

function syncChrome() {
  const mode = !world ? "home" : world.status === "lobby" ? "lobby" : world.status === "gallery" ? "gallery" : "hidden";
  panel.hidden = mode === "hidden";
  const modeChanged = mode !== panelMode;
  if (modeChanged) {
    panelMode = mode;
    if (mode === "home") panel.innerHTML = homeHtml();
    else if (mode === "lobby") panel.innerHTML = lobbyHtml();
    else if (mode === "gallery") panel.innerHTML = galleryHtml();
    resize();
  } else if (mode === "lobby") {
    panel.innerHTML = lobbyHtml();
  }
  const live = world && world.status !== "lobby";
  hud.hidden = !live;
  if (live) {
    const key = `${world.status}|${world.players.map((player) => player.id).join(",")}`;
    if (key !== hudKey) {
      hudKey = key;
      hud.innerHTML = `
        <div class="hud-row">
          <div class="brand">BL<i>O</i>OM</div>
          <div class="clock"></div>
          <button type="button" class="leave" data-act="leave">Leave</button>
        </div>
        <div class="bar"></div>
        <div class="chips"></div>`;
    }
    updateHudNumbers();
  } else {
    hudKey = "";
  }
  const showCount = world && world.status === "countdown";
  countEl.hidden = !showCount;
  if (showCount) {
    countEl.textContent = String(Math.max(1, Math.ceil((world.endsAt - Date.now()) / 1000)));
  }
  banner.hidden = true;
  document.title = world ? `BLOOM · ${world.code}` : "BLOOM";
}

function updateHudNumbers() {
  if (!world || hud.hidden) return;
  const clock = hud.querySelector(".clock");
  const bar = hud.querySelector(".bar");
  const chips = hud.querySelector(".chips");
  if (!clock || !bar || !chips) return;
  if (world.status === "playing" && world.endsAt) {
    const seconds = Math.max(0, Math.ceil((world.endsAt - Date.now()) / 1000));
    clock.textContent = String(seconds);
    clock.classList.toggle("urgent", seconds <= 8);
  } else {
    clock.textContent = "";
  }
  const painted = world.players.some((player) => player.score > 0);
  bar.innerHTML = painted
    ? world.players.map((player) => `<span style="flex:${Math.max(player.score, 0)} 1 0;background:${esc(player.color)}"></span>`).join("")
    : "";
  chips.innerHTML = world.players.map((player) => `<b style="color:${esc(player.color)}">${esc(player.name)} ${Math.round(player.share * 100)}%</b>`).join("");
}

function onWorld(next) {
  if (leftOnPurpose) return;
  const player = next.players.find((item) => item.id === next.you);
  if (player) saveSession({ playerId: next.you, code: next.code, name: player.name });
  history.replaceState(null, "", `/bloom?room=${next.code}`);
  if (world && world.code !== next.code) {
    grid = new Uint8Array(COLS * ROWS);
    shown.clear();
  }
  world = next;
  ambientOn = next.status === "lobby";
  syncChrome();
}

function readFields() {
  const nameInput = document.getElementById("name");
  const codeInput = document.getElementById("code");
  if (nameInput) draftName = nameInput.value;
  if (codeInput) draftCode = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4);
}

function ackOrToast(res) {
  if (!res || res.ok) return;
  toast(res.error || "Something went wrong.");
}

function createRoom() {
  readFields();
  const name = draftName.trim();
  if (!name) return toast("Enter your name.");
  leftOnPurpose = false;
  socket.emit("createRoom", { name }, (res) => {
    if (!res || !res.ok) return ackOrToast(res);
    saveSession({ playerId: res.playerId, code: res.code, name: res.name });
  });
}

function joinRoom() {
  readFields();
  const name = draftName.trim();
  const code = draftCode.trim().toUpperCase();
  if (!name) return toast("Enter your name.");
  if (code.length < 4) return toast("Enter the 4-character code.");
  leftOnPurpose = false;
  socket.emit("joinRoom", { name, code }, (res) => {
    if (!res || !res.ok) return ackOrToast(res);
    saveSession({ playerId: res.playerId, code: res.code, name: res.name });
  });
}

function tryRejoin() {
  if (leftOnPurpose) return;
  const session = loadSession();
  if (!session) return;
  if (invited && invited !== session.code) return;
  socket.emit("joinRoom", session, (res) => {
    if (!res || !res.ok) {
      clearSession();
      world = null;
      panelMode = "";
      syncChrome();
      if (res && res.error) toast(res.error);
    }
  });
}

function leave() {
  leftOnPurpose = true;
  socket.emit("leave");
  clearSession();
  world = null;
  grid = new Uint8Array(COLS * ROWS);
  panelMode = "";
  history.replaceState(null, "", "/bloom");
  redrawPaint();
  syncChrome();
}

function copyText(text, message) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => toast(message)).catch(() => toast(text));
  } else {
    toast(text);
  }
}

function courtPoint(event) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: clamp((event.clientX - rect.left - court.x) / court.w, 0, 1),
    y: clamp((event.clientY - rect.top - court.y) / court.h, 0, 1),
  };
}

document.body.addEventListener("click", (event) => {
  const button = event.target.closest("[data-act]");
  if (!button || button.disabled) return;
  const act = button.dataset.act;
  if (act === "create") return createRoom();
  if (act === "join") return joinRoom();
  if (act === "leave") {
    if (world && world.status === "playing" && !window.confirm("Leave this bloom?")) return;
    return leave();
  }
  if (!world) return;
  if (act === "copy-code") return copyText(world.code, "Code copied");
  if (act === "copy-link") return copyText(inviteLinks()[0] || world.code, "Link copied");
  if (act === "start") return socket.emit("start", {}, ackOrToast);
});

document.body.addEventListener("input", (event) => {
  if (event.target.id === "name") draftName = event.target.value;
  if (event.target.id === "code") {
    draftCode = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4);
    event.target.value = draftCode;
  }
});

document.body.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !world) {
    readFields();
    if (event.target.id === "code" || draftCode.trim()) joinRoom();
    else createRoom();
    return;
  }
  keys.add(event.key.toLowerCase());
});

document.body.addEventListener("keyup", (event) => {
  keys.delete(event.key.toLowerCase());
});

canvas.addEventListener("pointerdown", (event) => {
  if (!world || world.status !== "playing") return;
  pointerId = event.pointerId;
  canvas.setPointerCapture(event.pointerId);
  pointer = courtPoint(event);
});

canvas.addEventListener("pointermove", (event) => {
  if (event.pointerId !== pointerId) return;
  pointer = courtPoint(event);
});

function endPointer(event) {
  if (event.pointerId !== pointerId) return;
  pointerId = null;
  pointer = null;
}

canvas.addEventListener("pointerup", endPointer);
canvas.addEventListener("pointercancel", endPointer);
canvas.addEventListener("contextmenu", (event) => event.preventDefault());

window.addEventListener("resize", resize);
window.addEventListener("blur", () => keys.clear());

setInterval(() => {
  if (!world || world.status !== "playing") return;
  const vector = desired();
  socket.emit("input", vector);
  updateHudNumbers();
}, 50);

setInterval(() => {
  if (!world || world.status !== "countdown" || !world.endsAt) return;
  const n = Math.max(1, Math.ceil((world.endsAt - Date.now()) / 1000));
  countEl.textContent = String(n);
}, 200);

socket.on("world", onWorld);
socket.on("grid", (cells) => {
  grid = Uint8Array.from(cells);
  redrawPaint();
});
socket.on("paint", (cells) => applyPaint(cells));
socket.on("connect", () => {
  document.getElementById("net").hidden = true;
  tryRejoin();
});
socket.on("disconnect", () => {
  if (!leftOnPurpose) document.getElementById("net").hidden = false;
});

resize();
syncChrome();
requestAnimationFrame(frame);

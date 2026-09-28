"use strict";

const canvas = document.getElementById("bowl");
const ctx = canvas.getContext("2d");
const blob = document.createElement("canvas");
const blobCtx = blob.getContext("2d");
const panel = document.getElementById("panel");
const hud = document.getElementById("hud");
const countEl = document.getElementById("count");

const params = new URLSearchParams(location.search);
const invited = (params.get("room") || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4);

let world = null;
let panelMode = "";
let hudKey = "";
let draftName = localStorage.getItem("mercury-name") || localStorage.getItem("bloom-name") || localStorage.getItem("callit-name") || "";
let draftCode = invited;
let leftOnPurpose = false;
let pointerId = null;
let pointer = null;
let keyTarget = null;
const keys = new Set();
let bowl = { cx: 200, cy: 220, r: 160 };
let ambientOn = true;
let shown = [];
const hands = new Map();

const ambient = Array.from({ length: 42 }, (_, index) => {
  const angle = (index / 42) * Math.PI * 2;
  return { x: 0.5 + Math.cos(angle) * 0.11, y: 0.5 + Math.sin(angle) * 0.09, vx: 0, vy: 0 };
});

const socket = io("/mercury", { autoConnect: true });

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
  try { return JSON.parse(sessionStorage.getItem("mercury") || "null"); }
  catch { return null; }
}

function saveSession(session) {
  sessionStorage.setItem("mercury", JSON.stringify(session));
  if (session.name) localStorage.setItem("mercury-name", session.name);
}

function clearSession() {
  sessionStorage.removeItem("mercury");
}

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = window.innerWidth;
  const height = window.innerHeight;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const dock = world && (world.status === "playing" || world.status === "countdown" || world.status === "gallery") ? 28 : Math.min(300, height * 0.46);
  const availH = Math.max(160, height - dock);
  bowl.r = Math.max(108, Math.min(width * 0.38, availH * 0.46));
  bowl.cx = width / 2;
  bowl.cy = availH * 0.5;
  const size = Math.ceil((bowl.r * 2 + 120) * dpr);
  if (blob.width !== size) {
    blob.width = size;
    blob.height = size;
  }
}

function toScreen(x, y) {
  return {
    x: bowl.cx + ((x - 0.5) / 0.4) * bowl.r,
    y: bowl.cy + ((y - 0.5) / 0.4) * bowl.r,
  };
}

function inside(point, limit) {
  const ox = point.x - 0.5;
  const oy = point.y - 0.5;
  const radius = Math.hypot(ox, oy);
  if (radius > limit) {
    point.x = 0.5 + (ox / radius) * limit;
    point.y = 0.5 + (oy / radius) * limit;
  }
  return point;
}

function fromScreen(px, py) {
  return inside({
    x: 0.5 + ((px - bowl.cx) * 0.4) / bowl.r,
    y: 0.5 + ((py - bowl.cy) * 0.4) / bowl.r,
  }, 0.3);
}

function stepAmbient(dt) {
  const time = performance.now() / 1000;
  let cx = 0;
  let cy = 0;
  for (const drop of ambient) {
    cx += drop.x;
    cy += drop.y;
  }
  cx /= ambient.length;
  cy /= ambient.length;
  const ghosts = [
    { x: cx + Math.cos(time * 0.9) * 0.05, y: cy + Math.sin(time * 1.2) * 0.04 },
  ];
  for (const drop of ambient) {
    let ax = (cx - drop.x) * 8;
    let ay = (cy - drop.y) * 8;
    for (const ghost of ghosts) {
      const dx = ghost.x - drop.x;
      const dy = ghost.y - drop.y;
      const dist = Math.hypot(dx, dy) + 0.08;
      ax += (dx / dist) * (1.2 / dist);
      ay += (dy / dist) * (1.2 / dist);
    }
    drop.vx = (drop.vx + ax * dt) * 0.9;
    drop.vy = (drop.vy + ay * dt) * 0.9;
    drop.x += drop.vx * dt;
    drop.y += drop.vy * dt;
    contain(drop);
  }
}

function contain(drop) {
  const ox = drop.x - 0.5;
  const oy = drop.y - 0.5;
  const radius = Math.hypot(ox, oy);
  if (radius > 0.28) {
    drop.x = 0.5 + (ox / radius) * 0.28;
    drop.y = 0.5 + (oy / radius) * 0.28;
    drop.vx *= 0.4;
    drop.vy *= 0.4;
  }
}

function drawDrops(drops) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(bowl.cx, bowl.cy, bowl.r - 1, 0, Math.PI * 2);
  ctx.clip();
  ctx.fillStyle = "#10141c";
  ctx.fillRect(bowl.cx - bowl.r, bowl.cy - bowl.r, bowl.r * 2, bowl.r * 2);
  ctx.fillStyle = "#f4f7fb";
  const radius = bowl.r * 0.2;
  let sx = 0;
  let sy = 0;
  const points = drops.map((drop) => {
    const point = toScreen(drop.x, drop.y);
    sx += point.x;
    sy += point.y;
    return point;
  });
  for (const point of points) {
    ctx.beginPath();
    ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
    ctx.fill();
  }
  if (points.length) {
    const sheen = ctx.createRadialGradient(
      sx / points.length - radius * 0.35,
      sy / points.length - radius * 0.4,
      radius * 0.1,
      sx / points.length,
      sy / points.length,
      radius * 1.6
    );
    sheen.addColorStop(0, "rgba(255,255,255,0.75)");
    sheen.addColorStop(0.45, "rgba(255,255,255,0)");
    ctx.fillStyle = sheen;
    ctx.beginPath();
    ctx.arc(sx / points.length, sy / points.length, radius * 1.6, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
  ctx.beginPath();
  ctx.arc(bowl.cx, bowl.cy, bowl.r, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(232, 238, 246, 0.55)";
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

function drawHands(now) {
  if (!world) return;
  const me = world.players.find((player) => player.id === world.you);
  for (const player of world.players) {
    if (!player.connected && player.score === 0 && world.status === "lobby") continue;
    let view = hands.get(player.id);
    if (!view) view = { x: player.x, y: player.y };
    const local = player.id === world.you && world.status === "playing" && (pointer || keyTarget);
    const aim = local ? (pointer || keyTarget) : null;
    if (aim) {
      view.x += (aim.x - view.x) * 0.45;
      view.y += (aim.y - view.y) * 0.45;
    } else {
      view.x += (player.x - view.x) * 0.35;
      view.y += (player.y - view.y) * 0.35;
    }
    hands.set(player.id, view);
    const point = toScreen(view.x, view.y);
    const mine = player.id === (me && me.id);
    ctx.save();
    ctx.shadowColor = player.color;
    ctx.shadowBlur = 18;
    ctx.beginPath();
    ctx.fillStyle = player.color;
    ctx.arc(point.x, point.y, mine ? 16 : 13, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.beginPath();
    ctx.lineWidth = mine ? 3 : 1.5;
    ctx.strokeStyle = mine ? "#f4f8fc" : "rgba(244,248,252,0.7)";
    ctx.arc(point.x, point.y, mine ? 16 : 13, 0, Math.PI * 2);
    ctx.stroke();
    ctx.font = "600 13px Outfit, sans-serif";
    ctx.textAlign = "center";
    ctx.lineWidth = 4;
    ctx.strokeStyle = "rgba(6,7,11,0.85)";
    ctx.strokeText(player.name, point.x, point.y - 24);
    ctx.fillStyle = "#f4f8fc";
    ctx.fillText(player.name, point.x, point.y - 24);
  }
  void now;
}

function frame(now) {
  const dt = Math.min(0.05, (now - (frame.last || now)) / 1000);
  frame.last = now;
  const width = window.innerWidth;
  const height = window.innerHeight;
  ctx.setTransform(Math.min(window.devicePixelRatio || 1, 2), 0, 0, Math.min(window.devicePixelRatio || 1, 2), 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#06070b";
  ctx.fillRect(0, 0, width, height);
  if (ambientOn) stepAmbient(dt);
  for (const drop of shown) {
    if (drop.tx == null) continue;
    drop.x += (drop.tx - drop.x) * 0.35;
    drop.y += (drop.ty - drop.y) * 0.35;
  }
  const drops = ambientOn ? ambient : shown;
  drawDrops(drops);
  drawHands(now);
  if (keyTarget && world && world.status === "playing") {
    const speed = 0.55 * dt;
    if (keys.has("arrowleft") || keys.has("a")) keyTarget.x = clamp(keyTarget.x - speed, 0.08, 0.92);
    if (keys.has("arrowright") || keys.has("d")) keyTarget.x = clamp(keyTarget.x + speed, 0.08, 0.92);
    if (keys.has("arrowup") || keys.has("w")) keyTarget.y = clamp(keyTarget.y - speed, 0.08, 0.92);
    if (keys.has("arrowdown") || keys.has("s")) keyTarget.y = clamp(keyTarget.y + speed, 0.08, 0.92);
    inside(keyTarget, 0.3);
  }
  requestAnimationFrame(frame);
}

function rulesHtml() {
  return `
    <ol class="steps">
      <li>Drag your hand through the silver. Arrows work too.</li>
      <li>While you hold it, it sticks to you.</li>
      <li>When the clock ends, the most silver wins.</li>
    </ol>`;
}

function inviteLinks() {
  if (!world) return [];
  const local = /^(localhost|127\.0\.0\.1)$/i.test(location.hostname);
  const origins = !local
    ? [location.origin]
    : (world.lanOrigins && world.lanOrigins.length ? world.lanOrigins : [location.origin]);
  return origins.map((origin) => `${origin}/?room=${world.code}`);
}

function homeHtml() {
  return `
    <h1>MERCURY</h1>
    <p class="lede">One bowl. Everyone pulls. Hold the silver and it sticks to you.</p>
    <label for="name">Your name</label>
    <input id="name" maxlength="16" autocomplete="nickname" placeholder="Name" value="${esc(draftName)}">
    <div class="actions">
      <button type="button" class="primary" data-act="create">Open a bowl</button>
      <div class="join-row">
        <input id="code" maxlength="4" autocapitalize="characters" autocomplete="off" placeholder="CODE" value="${esc(draftCode)}" aria-label="Room code">
        <button type="button" class="ghost" data-act="join">Join</button>
      </div>
    </div>
    <p class="hint">Drag it. Hold it. Most silver wins.</p>
    <p class="other"><a href="/fathom">Play Fathom</a> · <a href="/bloom">Play Bloom</a> · <a href="/dice">Play Call it</a></p>`;
}

function lobbyHtml() {
  const here = world.players.filter((player) => player.connected).length;
  const host = world.players.find((player) => player.id === world.hostId);
  const canStart = world.you === world.hostId || !host || !host.connected;
  return `
    <button type="button" class="ticket" data-act="copy-code">${esc(world.code)}</button>
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
    ${canStart
      ? `<button type="button" class="primary" data-act="start" ${here < 2 ? "disabled" : ""}>Release the silver</button>
         <p class="wait">${here < 2 ? "Need one more player." : `${here} here. Press start.`}</p>`
      : `<p class="wait">Waiting for the host to start.</p>`}
    <p class="hint">Drag inside the bowl. The silver follows your hand.</p>
    <button type="button" class="ghost" data-act="copy-link">Copy invite link</button>
    <button type="button" class="ghost" data-act="leave">Leave</button>`;
}

function galleryHtml() {
  const ranked = [...world.players].sort((a, b) => b.score - a.score);
  const top = ranked[0] ? ranked[0].score : 0;
  const winners = ranked.filter((player) => player.score === top && top > 0);
  const youWon = winners.some((player) => player.id === world.you);
  const title = !winners.length
    ? "The silver stayed still"
    : winners.length > 1
      ? "The silver is split"
      : youWon
        ? "You hold the silver"
        : `${winners[0].name} holds the silver`;
  const host = world.players.find((player) => player.id === world.hostId);
  const canStart = world.you === world.hostId || !host || !host.connected;
  return `
    <p class="eyebrow">It settles</p>
    <h2>${esc(title)}</h2>
    <ul class="roster">
      ${ranked.map((player) => `<li><i class="swatch" style="background:${esc(player.color)}"></i><span>${esc(player.name)} · ${Math.round(player.share * 100)}%</span></li>`).join("")}
    </ul>
    ${canStart
      ? `<button type="button" class="primary" data-act="start">Pull again</button>`
      : `<p class="wait">Waiting for the host.</p>`}
    <button type="button" class="ghost" data-act="leave">Leave</button>`;
}

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
  } else if (mode === "lobby" || mode === "gallery") {
    panel.innerHTML = mode === "lobby" ? lobbyHtml() : galleryHtml();
  }
  const live = world && world.status !== "lobby";
  hud.hidden = !live;
  if (live) {
    const key = `${world.status}|${world.players.map((player) => player.id).join(",")}`;
    if (key !== hudKey) {
      hudKey = key;
      hud.innerHTML = `
        <div class="hud-row">
          <div class="brand">MERCURY</div>
          <div class="clock"></div>
          <button type="button" class="leave" data-act="leave">Leave</button>
        </div>
        <p class="hint">Hold the silver</p>
        <div class="bar"></div>
        <div class="chips"></div>`;
    }
    updateHud();
  } else {
    hudKey = "";
  }
  const showCount = world && world.status === "countdown";
  countEl.hidden = !showCount;
  if (showCount) countEl.textContent = String(Math.max(1, Math.ceil((world.endsAt - Date.now()) / 1000)));
  document.title = world ? `MERCURY · ${world.code}` : "MERCURY";
}

function updateHud() {
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
  const scored = world.players.some((player) => player.score > 0);
  bar.innerHTML = scored
    ? world.players.map((player) => `<span style="flex:${Math.max(player.score, 0)} 1 0;background:${esc(player.color)}"></span>`).join("")
    : "";
  chips.innerHTML = world.players.map((player) => `<b style="color:${esc(player.color)}">${esc(player.name)} ${Math.round(player.share * 100)}%</b>`).join("");
}

function applyDrops(packed) {
  const next = [];
  for (let i = 0; i < packed.length; i += 2) next.push({ x: packed[i], y: packed[i + 1] });
  if (shown.length !== next.length) {
    shown = next.map((drop) => ({ x: drop.x, y: drop.y, tx: drop.x, ty: drop.y }));
    return;
  }
  for (let i = 0; i < next.length; i += 1) {
    shown[i].tx = next[i].x;
    shown[i].ty = next[i].y;
  }
}

function onWorld(next) {
  if (leftOnPurpose) return;
  const player = next.players.find((item) => item.id === next.you);
  if (player) saveSession({ playerId: next.you, code: next.code, name: player.name });
  history.replaceState(null, "", `/?room=${next.code}`);
  if (world && world.code !== next.code) {
    shown = [];
    hands.clear();
  }
  world = next;
  ambientOn = next.status === "lobby";
  if (!ambientOn) applyDrops(next.drops || []);
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
  shown = [];
  hands.clear();
  panelMode = "";
  pointer = null;
  keyTarget = null;
  history.replaceState(null, "", "/");
  syncChrome();
}

function copyText(text, message) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => toast(message)).catch(() => toast(text));
  } else {
    toast(text);
  }
}

document.body.addEventListener("click", (event) => {
  const button = event.target.closest("[data-act]");
  if (!button || button.disabled) return;
  const act = button.dataset.act;
  if (act === "create") return createRoom();
  if (act === "join") return joinRoom();
  if (act === "leave") {
    if (world && world.status === "playing" && !window.confirm("Leave this bowl?")) return;
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
  const key = event.key.toLowerCase();
  if (["arrowup", "arrowdown", "arrowleft", "arrowright", " "].includes(key)) event.preventDefault();
  if (event.key === "Enter" && (!world || world.status === "lobby")) {
    readFields();
    if (event.target.id === "code" || draftCode.trim()) joinRoom();
    else createRoom();
    return;
  }
  keys.add(key);
  if (world && world.status === "playing" && !keyTarget) {
    const me = world.players.find((player) => player.id === world.you);
    keyTarget = me ? { x: me.x, y: me.y } : { x: 0.5, y: 0.5 };
  }
});

document.body.addEventListener("keyup", (event) => {
  keys.delete(event.key.toLowerCase());
  if (![...keys].some((key) => ["arrowup", "arrowdown", "arrowleft", "arrowright", "a", "d", "w", "s"].includes(key))) {
    keyTarget = null;
  }
});

function pointerPoint(event) {
  const rect = canvas.getBoundingClientRect();
  return fromScreen(event.clientX - rect.left, event.clientY - rect.top);
}

window.addEventListener("pointerdown", (event) => {
  if (!world || world.status !== "playing") return;
  if (event.target.closest && event.target.closest("button, a, input")) return;
  pointerId = event.pointerId;
  if (canvas.setPointerCapture) {
    try { canvas.setPointerCapture(event.pointerId); } catch { /* already gone */ }
  }
  pointer = pointerPoint(event);
});

window.addEventListener("pointermove", (event) => {
  if (event.pointerId !== pointerId) return;
  pointer = pointerPoint(event);
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
window.addEventListener("blur", () => {
  keys.clear();
  keyTarget = null;
});

setInterval(() => {
  if (!world || world.status !== "playing") return;
  const aim = pointer || keyTarget;
  socket.emit("input", aim ? { pulling: true, x: aim.x, y: aim.y } : { pulling: false });
  updateHud();
}, 50);

setInterval(() => {
  if (!world || world.status !== "countdown" || !world.endsAt) return;
  countEl.textContent = String(Math.max(1, Math.ceil((world.endsAt - Date.now()) / 1000)));
}, 200);

socket.on("world", onWorld);
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

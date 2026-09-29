"use strict";

const canvas = document.getElementById("cave");
const ctx = canvas.getContext("2d");
const panel = document.getElementById("panel");
const hud = document.getElementById("hud");
const countEl = document.getElementById("count");

const params = new URLSearchParams(location.search);
const invited = (params.get("room") || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4);

let world = null;
let panelMode = "";
let hudKey = "";
let draftName = localStorage.getItem("fathom-name") || localStorage.getItem("mercury-name") || localStorage.getItem("bloom-name") || "";
let draftCode = invited;
let leftOnPurpose = false;
let pointerId = null;
let stick = null;
const keys = new Set();
let width = 0;
let height = 0;
let tile = 42;
let originX = 0;
let originY = 0;
const bodies = new Map();
const bellViews = new Map();
let bubbles = [];

const socket = io("/fathom", { autoConnect: true });

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
  try { return JSON.parse(sessionStorage.getItem("fathom") || "null"); }
  catch { return null; }
}

function saveSession(session) {
  sessionStorage.setItem("fathom", JSON.stringify(session));
  if (session.name) localStorage.setItem("fathom-name", session.name);
}

function clearSession() {
  sessionStorage.removeItem("fathom");
}

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  width = window.innerWidth;
  height = window.innerHeight;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  fitMap();
}

function fitMap() {
  const cols = world && world.cols ? world.cols : 13;
  const rows = world && world.rows ? world.rows : 15;
  const top = world && world.status !== "lobby" ? 86 : 12;
  const pad = 10;
  tile = Math.max(8, Math.min((width - pad * 2) / cols, (height - top - pad) / rows));
  originX = (width - cols * tile) / 2;
  originY = top + Math.max(0, (height - top - pad - rows * tile) / 2);
}

function toScreen(x, y) {
  return {
    x: originX + x * tile,
    y: originY + y * tile,
  };
}

function inviteLinks() {
  if (!world) return [];
  const local = /^(localhost|127\.0\.0\.1)$/i.test(location.hostname);
  const origins = !local
    ? [location.origin]
    : (world.lanOrigins && world.lanOrigins.length ? world.lanOrigins : [location.origin]);
  return origins.map((origin) => `${origin}/fathom?room=${world.code}`);
}

function homeHtml() {
  return `
    <h1>Fathom</h1>
    <p class="lede">Three gold bells are sunk in one cave. Carry them up to the moon pool. Touch the diver who holds one and it becomes yours.</p>
    <label for="name">Your name</label>
    <input id="name" maxlength="16" autocomplete="nickname" placeholder="Name" value="${esc(draftName)}">
    <div class="actions">
      <button type="button" class="primary" data-act="create">Open a cave</button>
      <div class="join-row">
        <input id="code" maxlength="4" autocapitalize="characters" autocomplete="off" placeholder="CODE" value="${esc(draftCode)}" aria-label="Room code">
        <button type="button" class="ghost" data-act="join">Join</button>
      </div>
    </div>
    <p class="hint">Steer with a drag, or WASD. Breathe on the bubble vents. First to surface two bells wins.</p>
    <p class="other"><a href="/">Mercury</a> · <a href="/bloom">Bloom</a> · <a href="/dice">Call it</a></p>`;
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
      ? `<button type="button" class="primary" data-act="start" ${here < 2 ? "disabled" : ""}>Dive</button>
         <p class="wait">${here < 2 ? "Need one more diver." : `${here} here. Press dive.`}</p>`
      : `<p class="wait">Waiting for the host to dive.</p>`}
    <p class="hint">Drag to swim. Every bell you touch comes with you. Surface two.</p>
    <button type="button" class="ghost" data-act="copy-link">Copy invite link</button>
    <button type="button" class="ghost" data-act="leave">Leave</button>`;
}

function galleryHtml() {
  const ranked = [...world.players].sort((a, b) => b.banks - a.banks || a.name.localeCompare(b.name));
  const winner = world.players.find((player) => player.id === world.winnerId);
  const youWon = winner && winner.id === world.you;
  let title = "The bells stayed down";
  if (winner && world.reason === "banked") title = youWon ? "You surfaced the bells" : `${winner.name} surfaced the bells`;
  else if (winner && world.reason === "carrying") title = youWon ? "You kept the bell" : `${winner.name} kept the bell`;
  else if (winner && world.reason === "closest") title = youWon ? "You were closest to air" : `${winner.name} was closest to air`;
  const host = world.players.find((player) => player.id === world.hostId);
  const canStart = world.you === world.hostId || !host || !host.connected;
  return `
    <p class="eyebrow">Surface</p>
    <h2>${esc(title)}</h2>
    <ul class="roster">
      ${ranked.map((player) => `<li><i class="swatch" style="background:${esc(player.color)}"></i><span>${esc(player.name)} · ${player.banks} bell${player.banks === 1 ? "" : "s"}</span></li>`).join("")}
    </ul>
    ${canStart
      ? `<button type="button" class="primary" data-act="start">Dive again</button>`
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
    const active = document.activeElement;
    const typing = active && (active.id === "name" || active.id === "code");
    if (!typing) panel.innerHTML = mode === "lobby" ? lobbyHtml() : galleryHtml();
  }
  const live = world && world.status !== "lobby";
  hud.hidden = !live;
  if (live) {
    const key = `${world.status}|${world.players.map((player) => player.id).join(",")}`;
    if (key !== hudKey) {
      hudKey = key;
      hud.innerHTML = `
        <div class="hud-row">
          <div class="brand">FATHOM</div>
          <div class="clock"></div>
          <button type="button" class="leave" data-act="leave">Leave</button>
        </div>
        <div class="air" aria-hidden="true"><span></span></div>
        <p class="goal"></p>
        <div class="chips"></div>`;
    }
    updateHud();
  } else {
    hudKey = "";
  }
  const showCount = world && world.status === "countdown";
  countEl.hidden = !showCount;
  if (showCount) countEl.textContent = String(Math.max(1, Math.ceil((world.endsAt - Date.now()) / 1000)));
  document.title = world ? `FATHOM · ${world.code}` : "FATHOM";
}

function updateHud() {
  if (!world || hud.hidden) return;
  const clock = hud.querySelector(".clock");
  const chips = hud.querySelector(".chips");
  const air = hud.querySelector(".air > span");
  if (!clock || !chips || !air) return;
  if (world.status === "playing" && world.endsAt) {
    const seconds = Math.max(0, Math.ceil((world.endsAt - Date.now()) / 1000));
    clock.textContent = String(seconds);
    clock.classList.toggle("urgent", seconds <= 15);
  } else {
    clock.textContent = "";
  }
  const me = world.players.find((player) => player.id === world.you);
  const goal = hud.querySelector(".goal");
  if (goal) {
    goal.textContent = !me || world.status !== "playing"
      ? ""
      : (me.holding || 0) > 1 || me.bell != null
        ? ((me.holding || 1) > 1 ? "Carry the bells to the moon pool" : "Carry the bell to the moon pool")
        : me.banks
          ? "Grab another bell"
          : "Swim to a gold bell. You can carry more than one.";
  }
  air.style.width = `${me ? me.air : 0}%`;
  air.style.background = me && me.air < 30 ? "#ffb085" : "#7dffe1";
  chips.innerHTML = world.players.map((player) => {
    const count = player.holding || (player.bell != null ? 1 : 0);
    const hold = count > 1 ? ` · ${count} bells` : count === 1 ? " · bell" : "";
    return `<b style="color:${esc(player.color)}">${esc(player.name)} ${player.banks}${hold}</b>`;
  }).join("");
}

function track(map, id, x, y) {
  let body = map.get(id);
  if (!body) {
    body = { x, y, tx: x, ty: y };
    map.set(id, body);
  } else {
    body.tx = x;
    body.ty = y;
  }
  return body;
}

function onWorld(next) {
  if (leftOnPurpose) return;
  const player = next.players.find((item) => item.id === next.you);
  if (player) saveSession({ playerId: next.you, code: next.code, name: player.name });
  history.replaceState(null, "", `/fathom?room=${next.code}`);
  if (world && world.code !== next.code) {
    bodies.clear();
    bellViews.clear();
  }
  fitMap();
  for (const diver of next.players) {
    if (!diver.inRound && next.status === "playing") continue;
    track(bodies, diver.id, diver.x, diver.y);
  }
  for (const bell of next.bells) track(bellViews, bell.id, bell.x, bell.y);
  world = next;
  if (!bubbles.length && next.chart) seedBubbles();
  syncChrome();
}

function seedBubbles() {
  bubbles = [];
  if (!world || !world.chart) return;
  world.chart.forEach((row, r) => {
    row.split("").forEach((cell, c) => {
      if (cell !== "V") return;
      for (let i = 0; i < 5; i += 1) {
        bubbles.push({
          x: c + 0.2 + Math.random() * 0.6,
          y: r + Math.random(),
          home: r,
          col: c,
          s: 0.4 + Math.random(),
        });
      }
    });
  });
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
  clearSession();
  socket.emit("leave", {}, () => {
    world = null;
    panelMode = "";
    bodies.clear();
    history.replaceState(null, "", "/fathom");
    syncChrome();
  });
}

async function copyText(value) {
  try {
    await navigator.clipboard.writeText(value);
    toast("Copied.");
  } catch {
    toast(value);
  }
}

function stickVector() {
  let x = 0;
  let y = 0;
  if (keys.has("arrowleft") || keys.has("a")) x -= 1;
  if (keys.has("arrowright") || keys.has("d")) x += 1;
  if (keys.has("arrowup") || keys.has("w")) y -= 1;
  if (keys.has("arrowdown") || keys.has("s")) y += 1;
  if (stick) {
    x += stick.x;
    y += stick.y;
  }
  const mag = Math.hypot(x, y);
  if (mag > 1) {
    x /= mag;
    y /= mag;
  }
  return { x, y };
}

let lastSent = "";
function sendInput() {
  if (!world || world.status !== "playing") return;
  const vector = stickVector();
  const packed = `${vector.x.toFixed(2)},${vector.y.toFixed(2)}`;
  if (packed === lastSent) return;
  lastSent = packed;
  socket.emit("input", vector);
}

function draw() {
  ctx.clearRect(0, 0, width, height);
  const sky = ctx.createLinearGradient(0, 0, 0, height);
  sky.addColorStop(0, "#0c2832");
  sky.addColorStop(1, "#061016");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, width, height);
  if (world && world.chart) drawCave();
  else drawIdle();
  if (stick) drawStick();
}

function drawIdle() {
  ctx.fillStyle = "rgba(125, 255, 225, 0.08)";
  const time = performance.now() / 1000;
  for (let i = 0; i < 18; i += 1) {
    const y = (height * 0.2 + i * 36 + time * 18) % (height + 40) - 20;
    ctx.beginPath();
    ctx.arc(width * (0.2 + (i % 5) * 0.15), y, 3 + (i % 3), 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawCave() {
  const chart = world.chart;
  let poolX = 0;
  let poolY = 0;
  let poolN = 0;
  for (let r = 0; r < chart.length; r += 1) {
    const row = chart[r];
    for (let c = 0; c < row.length; c += 1) {
      const cell = row[c];
      if (cell === "#") continue;
      const point = toScreen(c, r);
      if (point.x < -tile || point.y < -tile || point.x > width + tile || point.y > height + tile) continue;
      if (cell === "H") {
        poolX += c + 0.5;
        poolY += r + 0.5;
        poolN += 1;
        ctx.fillStyle = "rgba(232, 244, 236, 0.72)";
        ctx.fillRect(point.x, point.y, tile, tile);
      } else if (cell === "V") {
        ctx.fillStyle = "rgba(125, 255, 225, 0.08)";
        ctx.fillRect(point.x, point.y, tile, tile);
      }
    }
  }
  if (poolN) {
    const pool = toScreen(poolX / poolN, poolY / poolN);
    ctx.fillStyle = "#102830";
    ctx.font = `700 ${Math.max(11, tile * 0.28)}px Manrope, sans-serif`;
    ctx.textAlign = "center";
    ctx.fillText("POOL", pool.x, pool.y + 4);
  }
  ctx.fillStyle = "#1c4650";
  for (let r = 0; r < chart.length; r += 1) {
    const row = chart[r];
    for (let c = 0; c < row.length; c += 1) {
      if (row[c] !== "#") continue;
      const point = toScreen(c, r);
      ctx.fillRect(point.x - 0.5, point.y - 0.5, tile + 1, tile + 1);
    }
  }
  drawGuide();
  ctx.strokeStyle = "rgba(125, 255, 225, 0.35)";
  ctx.lineWidth = 1.5;
  chart.forEach((row, r) => {
    row.split("").forEach((cell, c) => {
      if (cell !== "v" && cell !== "^") return;
      const point = toScreen(c + 0.5, r + 0.5);
      ctx.beginPath();
      ctx.moveTo(point.x, point.y + (cell === "v" ? -6 : 6));
      ctx.lineTo(point.x, point.y + (cell === "v" ? 6 : -6));
      ctx.stroke();
    });
  });
  const time = performance.now() / 1000;
  ctx.fillStyle = "rgba(210, 255, 244, 0.55)";
  for (const bubble of bubbles) {
    bubble.y -= 0.01 * bubble.s;
    if (bubble.y < bubble.home - 1.4) bubble.y = bubble.home + 0.9;
    const point = toScreen(bubble.x, bubble.y);
    ctx.beginPath();
    ctx.arc(point.x, point.y, 1.5 + bubble.s, 0, Math.PI * 2);
    ctx.fill();
  }
  if (world.bells) {
    for (const bell of world.bells) {
      const view = bellViews.get(bell.id) || bell;
      drawBell(view.x, view.y, bell.banked, time);
    }
  }
  if (world.players) {
    for (const player of world.players) {
      if (world.status === "playing" && !player.inRound) continue;
      const view = bodies.get(player.id) || player;
      drawDiver(view.x, view.y, player);
    }
  }
}

function drawBell(x, y, banked, time) {
  const point = toScreen(x, y);
  const radius = Math.max(7, tile * (banked ? 0.22 : 0.34));
  ctx.save();
  ctx.translate(point.x, point.y + Math.sin(time * 3 + x) * 1.5);
  ctx.fillStyle = "#f0c36a";
  ctx.beginPath();
  ctx.arc(0, 0, radius, Math.PI, 0);
  ctx.lineTo(radius * 0.72, radius * 0.85);
  ctx.arc(0, radius * 0.85, radius * 0.72, 0, Math.PI);
  ctx.fill();
  ctx.fillStyle = "#1a1408";
  ctx.beginPath();
  ctx.arc(0, radius * 0.2, radius * 0.16, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawDiver(x, y, player) {
  const point = toScreen(x, y);
  const radius = Math.max(10, tile * 0.34);
  ctx.save();
  ctx.shadowColor = player.color;
  ctx.shadowBlur = 16;
  ctx.fillStyle = player.color;
  ctx.beginPath();
  ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  if (player.stun) {
    ctx.strokeStyle = "rgba(255,255,255,0.7)";
    ctx.beginPath();
    ctx.arc(point.x, point.y, radius + 5, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.fillStyle = "#f4efe4";
  ctx.font = `600 ${Math.max(11, tile * 0.28)}px Manrope, sans-serif`;
  ctx.textAlign = "center";
  ctx.fillText(player.name, point.x, point.y - radius - 6);
  if (player.id === world.you) {
    ctx.strokeStyle = "rgba(244,239,228,0.8)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(point.x, point.y, radius + 4, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (player.air / 100));
    ctx.stroke();
  }
}

function drawGuide() {
  if (!world || world.status !== "playing") return;
  const me = world.players.find((player) => player.id === world.you && player.inRound);
  if (!me) return;
  const fromBody = bodies.get(me.id) || me;
  let target = null;
  if (me.bell != null) {
    let sx = 0;
    let sy = 0;
    let n = 0;
    world.chart.forEach((row, r) => {
      row.split("").forEach((cell, c) => {
        if (cell !== "H") return;
        sx += c + 0.5;
        sy += r + 0.5;
        n += 1;
      });
    });
    if (n) target = { x: sx / n, y: sy / n };
  } else {
    let best = Infinity;
    for (const bell of world.bells) {
      if (bell.banked) continue;
      const view = bellViews.get(bell.id) || bell;
      const dist = Math.hypot(view.x - fromBody.x, view.y - fromBody.y);
      if (dist < best) {
        best = dist;
        target = view;
      }
    }
  }
  if (!target) return;
  const a = toScreen(fromBody.x, fromBody.y);
  const b = toScreen(target.x, target.y);
  ctx.save();
  ctx.strokeStyle = "rgba(240, 195, 106, 0.45)";
  ctx.setLineDash([5, 7]);
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
  ctx.restore();
}

function drawStick() {
  ctx.strokeStyle = "rgba(244,239,228,0.35)";
  ctx.fillStyle = "rgba(244,239,228,0.2)";
  ctx.beginPath();
  ctx.arc(stick.originX, stick.originY, 46, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(stick.originX + stick.x * 32, stick.originY + stick.y * 32, 16, 0, Math.PI * 2);
  ctx.fill();
}

function glide(dt) {
  const k = Math.min(1, dt * 14);
  for (const body of bodies.values()) {
    body.x += (body.tx - body.x) * k;
    body.y += (body.ty - body.y) * k;
  }
  for (const body of bellViews.values()) {
    body.x += (body.tx - body.x) * k;
    body.y += (body.ty - body.y) * k;
  }
}

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  glide(dt);
  if (world && world.status === "countdown" && world.endsAt) {
    countEl.textContent = String(Math.max(1, Math.ceil((world.endsAt - Date.now()) / 1000)));
  }
  if (world && world.status === "playing") updateHud();
  draw();
  requestAnimationFrame(frame);
}

panel.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  const act = button.dataset.act;
  if (act === "create") createRoom();
  else if (act === "join") joinRoom();
  else if (act === "start") socket.emit("start", {}, ackOrToast);
  else if (act === "leave") leave();
  else if (act === "copy-code" && world) copyText(world.code);
  else if (act === "copy-link") {
    const links = inviteLinks();
    if (links[0]) copyText(links[0]);
  }
});

hud.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (button && button.dataset.act === "leave") leave();
});

function ignoredTarget(target) {
  return target && target.closest && target.closest("button, a, input, textarea");
}

window.addEventListener("pointerdown", (event) => {
  if (!world || world.status !== "playing" || ignoredTarget(event.target)) return;
  pointerId = event.pointerId;
  stick = { originX: event.clientX, originY: event.clientY, x: 0, y: 0 };
});

window.addEventListener("pointermove", (event) => {
  if (event.pointerId !== pointerId || !stick) return;
  const dx = event.clientX - stick.originX;
  const dy = event.clientY - stick.originY;
  const mag = Math.hypot(dx, dy) || 1;
  const reach = Math.min(1, mag / 56);
  stick.x = (dx / mag) * reach;
  stick.y = (dy / mag) * reach;
  sendInput();
});

function endPointer(event) {
  if (event.pointerId !== pointerId) return;
  pointerId = null;
  stick = null;
  sendInput();
}

window.addEventListener("pointerup", endPointer);
window.addEventListener("pointercancel", endPointer);

window.addEventListener("keydown", (event) => {
  const key = event.key.toLowerCase();
  if (["arrowup", "arrowdown", "arrowleft", "arrowright", " "].includes(key)) event.preventDefault();
  keys.add(key);
  sendInput();
});

window.addEventListener("keyup", (event) => {
  keys.delete(event.key.toLowerCase());
  sendInput();
});

socket.on("connect", () => {
  document.getElementById("net").hidden = true;
  tryRejoin();
});

socket.on("disconnect", () => {
  if (!leftOnPurpose) document.getElementById("net").hidden = false;
});

socket.on("world", onWorld);

window.addEventListener("resize", resize);
resize();
syncChrome();
setInterval(sendInput, 80);
requestAnimationFrame(frame);

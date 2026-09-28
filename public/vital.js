"use strict";

const socket = io("/vital", { transports: ["websocket", "polling"] });
const canvas = document.getElementById("ward");
const ctx = canvas.getContext("2d");
const hud = document.getElementById("hud");
const panel = document.getElementById("panel");
const net = document.getElementById("net");
const toastEl = document.getElementById("toast");

const SESSION = "vital";
const invited = (new URLSearchParams(location.search).get("room") || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4);

let world = null;
let panelMode = "";
let panelKey = "";
let hudKey = "";
let draftName = localStorage.getItem("vital.name") || "";
let draftCode = invited;
let leftOnPurpose = false;
let toastTimer = 0;

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  }[ch]));
}

function loadSession() {
  try { return JSON.parse(sessionStorage.getItem(SESSION) || "null"); }
  catch { return null; }
}

function saveSession(session) {
  sessionStorage.setItem(SESSION, JSON.stringify(session));
  localStorage.setItem("vital.name", session.name || "");
}

function clearSession() {
  sessionStorage.removeItem(SESSION);
}

function toast(message) {
  toastEl.textContent = message;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, 2400);
}

function me() {
  return world && world.players.find((player) => player.id === world.you);
}

function inviteLinks() {
  if (!world) return [];
  const local = /^(localhost|127\.0\.0\.1)$/i.test(location.hostname);
  const origins = !local
    ? [location.origin]
    : (world.lanOrigins && world.lanOrigins.length ? world.lanOrigins : [location.origin]);
  return origins.map((origin) => `${origin}/vital?room=${world.code}`);
}

function rulesHtml() {
  return `
    <ol class="steps">
      <li>Your phone holds one or two vitals. You see their number. The others are only a word.</li>
      <li>Tap when yours is low. Tapping a steady vital makes the others fall.</li>
      <li>Keep every vital alive until the night ends.</li>
    </ol>`;
}

function homeHtml() {
  return `
    <p class="eyebrow">${invited ? `Ward ${esc(invited)}` : "One patient, split across every phone"}</p>
    <h1>VIT<i>A</i>L</h1>
    <p class="lede">Each phone holds a different vital sign. The night ends if any of them reaches zero.</p>
    <label for="name">Your name</label>
    <input id="name" maxlength="16" placeholder="Name" value="${esc(draftName)}" autocomplete="nickname">
    <button type="button" class="primary" data-act="create">Open a ward</button>
    <div class="row">
      <input id="code" maxlength="4" placeholder="CODE" value="${esc(draftCode)}" autocapitalize="characters" autocomplete="off" aria-label="Room code">
      <button type="button" class="primary" data-act="join">Join</button>
    </div>
    ${rulesHtml()}
    <p class="links"><a href="/keyhole">Play Keyhole</a> · <a href="/">Play Mercury</a> · <a href="/fathom">Play Fathom</a> · <a href="/bloom">Play Bloom</a></p>`;
}

function lobbyHtml() {
  const self = me();
  const here = world.players.filter((player) => player.connected).length;
  return `
    <p class="eyebrow">Ward</p>
    <button type="button" class="code" data-act="copy-code">${esc(world.code)}</button>
    <p class="share">${esc(inviteLinks()[0] || "")}</p>
    <button type="button" class="ghost" data-act="copy-link">Copy the invite</button>
    <ul class="roster">
      ${world.players.map((player) => `<li><i class="swatch" style="background:${esc(player.color)}"></i><span>${esc(player.name)}${player.host ? " · host" : ""}${player.connected ? "" : " · away"}</span></li>`).join("")}
    </ul>
    ${self && self.host
      ? `<button type="button" class="primary" data-act="start" ${here < 2 ? "disabled" : ""}>Start the night</button>
         <p class="wait">${here < 2 ? "Need one more phone." : `${here} here. Each phone will hold a different vital.`}</p>`
      : `<p class="wait">Waiting for the host to start.</p>`}
    ${rulesHtml()}
    <button type="button" class="ghost" data-act="leave">Leave</button>`;
}

function waitHtml() {
  return `
    <p class="eyebrow">The night is going</p>
    <h1>Next shift</h1>
    <p class="lede">This patient already has a team. You will join the next night.</p>
    <button type="button" class="ghost" data-act="leave">Leave</button>`;
}

function nightHtml() {
  const now = Date.now();
  const ready = !world.readyAt || world.readyAt <= now;
  return `
    <p class="hint">Tap only when your number is low. A steady vital is not yours to treat.</p>
    <div class="cares">
      ${(world.vitals || []).filter((vital) => vital.mine).map((vital) => `
        <button type="button" class="care ${esc(vital.word)}" data-act="care" data-vital="${esc(vital.id)}" ${ready ? "" : "disabled"}>
          <b>${esc(vital.label)}</b>
          <strong>${vital.value}</strong>
          <span>${ready ? "Treat" : "Hands full"}</span>
        </button>`).join("")}
    </div>`;
}

function resultHtml() {
  const self = me();
  const held = !world.failed;
  const seconds = Math.round((world.survived || 0) / 1000);
  const broken = (world.vitals || []).find((vital) => vital.id === world.failed);
  const who = broken ? broken.owners.map((owner) => owner.name).join(" and ") : "";
  const ranked = world.players.slice().sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return `
    <p class="eyebrow">${held ? "The night held" : "The night broke"}</p>
    <h1>${seconds}s</h1>
    <p class="lede">${held ? "Every vital stayed alive." : `${esc(broken ? broken.label : "A vital")} failed on ${esc(who)}'s phone.`}</p>
    <ul class="chart">
      ${(world.vitals || []).map((vital) => `<li><span>${esc(vital.label)}</span><b class="${esc(vital.word)}">${vital.value}</b></li>`).join("")}
    </ul>
    <ul class="score-list">
      ${ranked.map((player) => `<li><span><i class="swatch" style="background:${esc(player.color)}"></i> ${esc(player.name)}</span><b>${player.score}</b></li>`).join("")}
    </ul>
    ${self && self.host
      ? `<button type="button" class="primary" data-act="start">Stay for another night</button>`
      : `<p class="wait">Waiting for the host.</p>`}
    <button type="button" class="ghost" data-act="leave">Leave</button>`;
}

function clockText() {
  if (!world || world.status !== "night" || !world.endsAt) return "";
  return String(Math.max(0, Math.ceil((world.endsAt - Date.now()) / 1000)));
}

function syncChrome() {
  const mode = !world
    ? "home"
    : world.waiting
      ? "wait"
      : world.status === "lobby"
        ? "lobby"
        : world.status === "result"
          ? "result"
          : world.status === "night"
            ? "night"
            : "home";
  panel.hidden = false;
  panel.classList.toggle("sheet", mode === "night" || mode === "result");
  const mine = (world && world.vitals || []).filter((vital) => vital.mine).map((vital) => `${vital.id}:${vital.value}:${vital.word}`).join(",");
  const key = mode === "night"
    ? `${mine}:${world.readyAt && world.readyAt > Date.now() ? "wait" : "go"}`
    : mode === "result"
      ? `${world.failed}:${world.survived}`
      : mode === "lobby"
        ? world.players.map((player) => `${player.id}:${player.connected}:${player.host}`).join(",")
        : mode;
  if (mode !== panelMode || key !== panelKey) {
    panelMode = mode;
    panelKey = key;
    if (mode === "home") panel.innerHTML = homeHtml();
    else if (mode === "lobby") panel.innerHTML = lobbyHtml();
    else if (mode === "wait") panel.innerHTML = waitHtml();
    else if (mode === "night") panel.innerHTML = nightHtml();
    else panel.innerHTML = resultHtml();
  }
  const urgent = world && world.status === "night" && world.endsAt && world.endsAt - Date.now() < 15000;
  const hudText = clockText();
  const nextHud = world && mode !== "home" && mode !== "wait"
    ? `VITAL|${hudText}|${(world.vitals || []).filter((vital) => !vital.mine).map((vital) => vital.word).join("")}`
    : "off";
  if (nextHud !== hudKey) {
    hudKey = nextHud;
    if (!world || mode === "home") {
      hud.hidden = true;
      hud.innerHTML = "";
    } else {
      hud.hidden = false;
      const others = (world.vitals || []).filter((vital) => !vital.mine);
      hud.innerHTML = `
        <div class="hud-row">
          <div class="brand">VIT<i>A</i>L</div>
          <div class="clock${urgent ? " urgent" : ""}">${esc(hudText)}</div>
          <button type="button" class="leave" data-act="leave">Leave</button>
        </div>
        ${others.length ? `<p class="others">${others.map((vital) => `<span class="${esc(vital.word)}">${esc(vital.label)} ${esc(vital.word)}</span>`).join("")}</p>` : ""}`;
    }
  } else if (world && world.status === "night") {
    const clock = hud.querySelector(".clock");
    if (clock) {
      clock.textContent = hudText;
      clock.classList.toggle("urgent", Boolean(urgent));
    }
  }
}

function onWorld(next) {
  world = next;
  const self = me();
  if (self) saveSession({ playerId: self.id, code: world.code, name: self.name });
  syncChrome();
}

function tryRejoin() {
  const session = loadSession();
  if (!session || !session.code || !session.playerId) return;
  socket.emit("joinRoom", session, (res) => {
    if (!res || !res.ok) clearSession();
  });
}

function copyText(value) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(value).then(() => toast("Copied")).catch(() => toast(value));
  } else toast(value);
}

document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-act]");
  if (!button) return;
  const act = button.dataset.act;
  if (act === "create" || act === "join") {
    const name = (document.getElementById("name").value || "").trim();
    draftName = name;
    if (act === "join") draftCode = (document.getElementById("code").value || "").trim();
    const payload = act === "create"
      ? { name }
      : { name, code: draftCode };
    socket.emit(act === "create" ? "createRoom" : "joinRoom", payload, (res) => {
      if (res && res.error) toast(res.error);
      if (res && res.ok) saveSession({ playerId: res.playerId, code: res.code, name: res.name });
    });
  } else if (act === "start") {
    socket.emit("start", {}, (res) => { if (res && res.error) toast(res.error); });
  } else if (act === "care") {
    socket.emit("care", { vital: button.dataset.vital }, (res) => {
      if (res && res.error) toast(res.error);
      else if (res && res.overtreat) toast("Too soon. The others dipped.");
    });
  } else if (act === "copy-code") {
    copyText(world.code);
  } else if (act === "copy-link") {
    copyText(inviteLinks()[0] || "");
  } else if (act === "leave") {
    if (world && world.status === "night" && !window.confirm("Leave this night?")) return;
    leftOnPurpose = true;
    clearSession();
    socket.emit("leave", {}, () => {
      world = null;
      leftOnPurpose = false;
      history.replaceState(null, "", "/vital");
      syncChrome();
    });
  }
});

document.addEventListener("input", (event) => {
  if (event.target.id === "name") draftName = event.target.value;
  if (event.target.id === "code") draftCode = event.target.value;
});

function vitalById(id) {
  return (world && world.vitals || []).find((vital) => vital.id === id);
}

function strength(id) {
  const vital = vitalById(id);
  if (!vital) return 0.7;
  if (typeof vital.value === "number") return clamp(vital.value / 100, 0, 1);
  return vital.level === 2 ? 0.8 : vital.level === 1 ? 0.5 : 0.22;
}

function roundRect(x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function drawWard(width, height, live) {
  const night = world && (world.status === "night" || world.status === "result");
  const top = night ? 78 : 16;
  const bottom = night ? Math.min(250, height * 0.34) : 18;
  const w = Math.min(width - 28, 520);
  const h = Math.max(180, height - top - bottom);
  const x = (width - w) / 2;
  const y = top;
  const breath = strength("breath");
  const pulse = strength("pulse");
  const bleed = strength("bleed");
  const calm = strength("calm");
  const beat = 1.1 + (1 - pulse) * 2.4;
  const thump = Math.pow(Math.max(0, Math.sin(live * beat * Math.PI)), 10);

  ctx.fillStyle = "#07141c";
  ctx.fillRect(0, 0, width, height);
  const glow = ctx.createRadialGradient(x + w * 0.5, y + h * 0.35, 20, x + w * 0.5, y + h * 0.4, w * 0.7);
  glow.addColorStop(0, `rgba(40, 78, 92, ${0.55 + thump * 0.25})`);
  glow.addColorStop(1, "#07141c");
  ctx.fillStyle = glow;
  roundRect(x, y, w, h, 28);
  ctx.fill();

  ctx.fillStyle = "#12303a";
  roundRect(x + w * 0.18, y + h * 0.58, w * 0.64, h * 0.28, 18);
  ctx.fill();

  const chest = 1 + Math.sin(live * (1.2 + breath * 1.6)) * (0.015 + breath * 0.03);
  ctx.save();
  ctx.translate(x + w * 0.5, y + h * 0.62);
  ctx.scale(chest, 1);
  ctx.fillStyle = "#f2c7b8";
  ctx.beginPath();
  ctx.ellipse(0, 0, w * 0.16, h * 0.11, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  const headY = y + h * 0.4 + Math.sin(live * 1.4) * (2 + calm * 3);
  ctx.fillStyle = "#f2c7b8";
  ctx.beginPath();
  ctx.ellipse(x + w * 0.5, headY, w * 0.11, h * 0.1, 0, 0, Math.PI * 2);
  ctx.fill();
  const blink = Math.sin(live * (0.8 + (1 - calm) * 2)) > 0.92;
  ctx.fillStyle = "#1b2430";
  if (blink || calm < 0.3) {
    ctx.fillRect(x + w * 0.46, headY, w * 0.025, 2);
    ctx.fillRect(x + w * 0.52, headY, w * 0.025, 2);
  } else {
    ctx.beginPath();
    ctx.arc(x + w * 0.47, headY, 2.4, 0, Math.PI * 2);
    ctx.arc(x + w * 0.53, headY, 2.4, 0, Math.PI * 2);
    ctx.fill();
  }
  if (calm < 0.45) {
    ctx.strokeStyle = "rgba(180, 214, 230, 0.8)";
    ctx.beginPath();
    ctx.arc(x + w * 0.42, headY + 8, 3, 0, Math.PI);
    ctx.stroke();
  }

  const heartX = x + w * 0.62;
  const heartY = y + h * 0.48;
  ctx.save();
  ctx.translate(heartX, heartY);
  ctx.scale(1 + thump * 0.45, 1 + thump * 0.45);
  ctx.fillStyle = `rgba(255, 91, 110, ${0.45 + pulse * 0.5})`;
  ctx.beginPath();
  ctx.arc(-7, -2, 8, 0, Math.PI * 2);
  ctx.arc(7, -2, 8, 0, Math.PI * 2);
  ctx.moveTo(-14, 0);
  ctx.lineTo(0, 16);
  ctx.lineTo(14, 0);
  ctx.fill();
  ctx.restore();

  const bagX = x + w * 0.78;
  ctx.strokeStyle = "#8eb7ff";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(bagX, y + 18);
  ctx.lineTo(bagX, y + h * 0.42);
  ctx.stroke();
  ctx.fillStyle = `rgba(142, 183, 255, ${0.35 + (1 - bleed) * 0.4})`;
  roundRect(bagX - 16, y + 8, 32, 36, 8);
  ctx.fill();
  const drops = 4 + Math.round((1 - bleed) * 4);
  for (let i = 0; i < drops; i += 1) {
    const fall = (live * (40 + (1 - bleed) * 90) + i * 28) % (h * 0.34);
    ctx.globalAlpha = 1 - fall / (h * 0.34);
    ctx.fillStyle = "#ff8b7b";
    ctx.beginPath();
    ctx.arc(bagX, y + h * 0.2 + fall, 2.4, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  ctx.fillStyle = "rgba(125, 206, 160, 0.16)";
  for (let i = 0; i < 10; i += 1) {
    const py = y + ((live * 18 + i * 37) % h);
    ctx.fillRect(x + 16 + (i * 47) % (w - 32), py, 2, 2);
  }
}

function frame() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = window.innerWidth;
  const height = window.innerHeight;
  if (canvas.width !== Math.floor(width * dpr) || canvas.height !== Math.floor(height * dpr)) {
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  drawWard(width, height, performance.now() / 1000);
  if (world && world.status === "night") syncChrome();
  requestAnimationFrame(frame);
}

socket.on("world", onWorld);
socket.on("connect", () => {
  net.hidden = true;
  tryRejoin();
});
socket.on("disconnect", () => {
  if (!leftOnPurpose) net.hidden = false;
});

syncChrome();
requestAnimationFrame(frame);

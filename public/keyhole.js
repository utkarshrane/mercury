"use strict";

const socket = io("/keyhole", { transports: ["websocket", "polling"] });
const canvas = document.getElementById("room");
const ctx = canvas.getContext("2d");
const hud = document.getElementById("hud");
const panel = document.getElementById("panel");
const net = document.getElementById("net");
const toastEl = document.getElementById("toast");

const SESSION = "keyhole";
const invited = (new URLSearchParams(location.search).get("room") || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4);

let world = null;
let panelMode = "";
let panelKey = "";
let hudKey = "";
let draftName = localStorage.getItem("keyhole.name") || "";
let draftCode = invited;
let leftOnPurpose = false;
let toastTimer = 0;
let lastFrame = performance.now();

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
  localStorage.setItem("keyhole.name", session.name || "");
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

function ackOrToast(res) {
  if (res && res.error) toast(res.error);
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
  return origins.map((origin) => `${origin}/keyhole?room=${world.code}`);
}

function rulesHtml() {
  return `
    <ol class="steps">
      <li>Watch. Your phone hides part of the room.</li>
      <li>Answer together. A choice locks when two of you tap it.</li>
      <li>The room opens. You score what you agreed, and the one who saw it scores more.</li>
    </ol>`;
}

function homeHtml() {
  return `
    <p class="eyebrow">${invited ? `Room ${esc(invited)}` : "One room, split across every phone"}</p>
    <h1>KEYH<i>O</i>LE</h1>
    <p class="lede">You each see a different slice of the same evening. An answer counts only when two of you agree.</p>
    <label for="name">Your name</label>
    <input id="name" maxlength="16" placeholder="Name" value="${esc(draftName)}" autocomplete="nickname">
    <button type="button" class="primary" data-act="create">Open a room</button>
    <div class="row">
      <input id="code" maxlength="4" placeholder="CODE" value="${esc(draftCode)}" autocapitalize="characters" autocomplete="off" aria-label="Room code">
      <button type="button" class="primary" data-act="join">Join</button>
    </div>
    ${rulesHtml()}
    <p class="links"><a href="/">Play Mercury</a> · <a href="/fathom">Play Fathom</a> · <a href="/bloom">Play Bloom</a> · <a href="/dice">Play Call it</a></p>`;
}

function lobbyHtml() {
  const self = me();
  const here = world.players.filter((player) => player.connected).length;
  const canStart = self && self.host;
  return `
    <p class="eyebrow">Room</p>
    <button type="button" class="code" data-act="copy-code">${esc(world.code)}</button>
    <p class="share">${esc(inviteLinks()[0] || "")}</p>
    <button type="button" class="ghost" data-act="copy-link">Copy the invite</button>
    <ul class="roster">
      ${world.players.map((player) => `<li><i class="swatch" style="background:${esc(player.color)}"></i><span>${esc(player.name)}${player.host ? " · host" : ""}${player.connected ? "" : " · away"}</span></li>`).join("")}
    </ul>
    ${canStart
      ? `<button type="button" class="primary" data-act="start" ${here < 2 ? "disabled" : ""}>Start the watch</button>
         <p class="wait">${here < 2 ? "Need one more phone." : `${here} here. Each phone will hide a different part.`}</p>`
      : `<p class="wait">Waiting for the host to start.</p>`}
    ${rulesHtml()}
    <button type="button" class="ghost" data-act="leave">Leave</button>`;
}

function waitHtml() {
  return `
    <p class="eyebrow">Round ${world.round} of ${world.rounds}</p>
    <h1>Next round</h1>
    <p class="lede">This evening already started. You will see the next one.</p>
    <button type="button" class="ghost" data-act="leave">Leave</button>`;
}

function askHtml() {
  const self = me();
  return `
    <p class="hint">Two taps on the same choice lock it. Tell each other what you saw.</p>
    ${(world.questions || []).map((question) => `
      <article class="q">
        <h2>${esc(question.prompt)}</h2>
        <div class="choices">
          ${question.choices.map((choice, index) => {
            const people = (question.picks || []).filter((pick) => pick.choice === index);
            const mine = people.some((pick) => pick.id === world.you);
            const locked = question.lock === index;
            return `<button type="button" class="choice${mine ? " mine" : ""}${locked ? " locked" : ""}" data-act="pick" data-q="${esc(question.id)}" data-i="${index}" ${question.lock != null || !self || !self.inRound ? "disabled" : ""}>
              <span>${esc(choice)}</span>
              <span class="who">${people.map((pick) => esc(pick.name)).join(" · ")}</span>
            </button>`;
          }).join("")}
        </div>
      </article>`).join("")}`;
}

function reviewLine(review) {
  const locked = review.detail.filter((item) => item.locked != null).length;
  if (!locked) return "Time ran out before two of you agreed.";
  if (review.agreed === review.of) return `All ${review.of} were right.`;
  if (!review.agreed) return `You locked ${locked}. None were right.`;
  return `${review.agreed} of ${review.of} were right.`;
}

function revealHtml() {
  const review = world.review;
  if (!review) return "";
  return `
    <p class="eyebrow">The room opens</p>
    <p class="lede">${esc(reviewLine(review))}</p>
    ${review.detail.map((item) => `
      <article class="review">
        <b>${esc(item.prompt)}</b>
        ${item.ok
          ? `<span class="ok">Agreed: ${esc(item.lockedLabel)}. ${item.credited.map((credit) => `${esc(credit.name)} +${credit.points}`).join(" · ")}</span>`
          : `<span class="miss">${item.lockedLabel ? `Agreed: ${esc(item.lockedLabel)}. ` : "No agreement. "}It was ${esc(item.answerLabel)}.</span>`}
      </article>`).join("")}`;
}

function galleryHtml() {
  const self = me();
  const verdict = world.verdict || { line: "", evening: 0, possible: 12 };
  const ranked = world.players.slice().sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return `
    <p class="eyebrow">The evening holds</p>
    <h1>${verdict.evening}/${verdict.possible}</h1>
    <p class="lede">${esc(verdict.line)}</p>
    <ul class="score-list">
      ${ranked.map((player) => `<li><span><i class="swatch" style="background:${esc(player.color)}"></i> ${esc(player.name)}</span><b>${player.score}</b></li>`).join("")}
    </ul>
    ${self && self.host
      ? `<button type="button" class="primary" data-act="start">Watch again</button>`
      : `<p class="wait">Waiting for the host to watch again.</p>`}
    <button type="button" class="ghost" data-act="leave">Leave</button>`;
}

function syncChrome() {
  const mode = !world
    ? "home"
    : world.waiting
      ? "wait"
      : world.status === "lobby"
        ? "lobby"
        : world.status === "gallery"
          ? "gallery"
          : world.status === "ask"
            ? "ask"
            : world.status === "reveal"
              ? "reveal"
              : "hidden";
  panel.hidden = mode === "hidden";
  panel.classList.toggle("sheet", mode === "ask" || mode === "reveal");
  panel.classList.toggle("reveal", mode === "reveal");
  const key = mode === "ask"
    ? JSON.stringify(world.questions)
    : mode === "reveal"
      ? JSON.stringify(world.review)
      : mode === "lobby"
        ? world.players.map((player) => `${player.id}:${player.connected}:${player.host}`).join(",")
        : mode;
  if (mode !== panelMode || key !== panelKey) {
    panelMode = mode;
    panelKey = key;
    if (mode === "home") panel.innerHTML = homeHtml();
    else if (mode === "lobby") panel.innerHTML = lobbyHtml();
    else if (mode === "wait") panel.innerHTML = waitHtml();
    else if (mode === "ask") panel.innerHTML = askHtml();
    else if (mode === "reveal") panel.innerHTML = revealHtml();
    else if (mode === "gallery") panel.innerHTML = galleryHtml();
  }
  const live = world && world.status !== "lobby" && world.status !== "gallery" && !world.waiting;
  hud.hidden = !live;
  if (live) {
    const hidden = (world.hidden || []).map((item) => item.label);
    const nextKey = `${world.status}|${world.round}|${hidden.join(",")}`;
    if (nextKey !== hudKey) {
      hudKey = nextKey;
      hud.innerHTML = `
        <div class="hud-row">
          <div class="brand">KEYH<i>O</i>LE</div>
          <div class="clock"></div>
          <button type="button" class="leave" data-act="leave">Leave</button>
        </div>
        <p class="blind-line"></p>`;
    }
    const clock = hud.querySelector(".clock");
    const line = hud.querySelector(".blind-line");
    if (clock && world.endsAt && (world.status === "watch" || world.status === "ask")) {
      const seconds = Math.max(0, Math.ceil((world.endsAt - Date.now()) / 1000));
      clock.textContent = String(seconds);
      clock.classList.toggle("urgent", seconds <= 5);
    } else if (clock) clock.textContent = "";
    if (line) {
      line.textContent = world.status === "watch"
        ? (hidden.length ? `Your keyhole hides ${hidden.join(" and ")}.` : "Watch the room.")
        : "Agree on what happened.";
    }
  } else {
    hudKey = "";
  }
  document.title = world ? `KEYHOLE · ${world.code}` : "KEYHOLE";
}

function onWorld(next) {
  if (leftOnPurpose) return;
  const player = next.players.find((item) => item.id === next.you);
  if (player) saveSession({ playerId: next.you, code: next.code, name: player.name });
  history.replaceState(null, "", `/keyhole?room=${next.code}`);
  world = next;
  syncChrome();
}

function readFields() {
  const nameInput = document.getElementById("name");
  const codeInput = document.getElementById("code");
  if (nameInput) draftName = nameInput.value;
  if (codeInput) draftCode = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4);
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
      panelKey = "";
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
  panelMode = "";
  panelKey = "";
  history.replaceState(null, "", "/keyhole");
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
    if (world && (world.status === "watch" || world.status === "ask") && !window.confirm("Leave this evening?")) return;
    return leave();
  }
  if (!world) return;
  if (act === "copy-code") return copyText(world.code, "Code copied");
  if (act === "copy-link") return copyText(inviteLinks()[0] || world.code, "Link copied");
  if (act === "start") return socket.emit("start", {}, ackOrToast);
  if (act === "pick") {
    socket.emit("pick", { questionId: button.dataset.q, choice: Number(button.dataset.i) }, ackOrToast);
  }
});

document.body.addEventListener("input", (event) => {
  if (event.target.id === "name") draftName = event.target.value;
  if (event.target.id === "code") {
    draftCode = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4);
    event.target.value = draftCode;
  }
});

document.body.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || world) return;
  readFields();
  if (event.target.id === "code" || draftCode.trim()) joinRoom();
  else createRoom();
});

function sceneTime() {
  if (!world || world.waiting) return 0;
  const span = 8.2;
  if (world.status === "ask") return span;
  if (world.status === "watch" || world.status === "reveal") {
    const length = world.length || 1;
    const left = Math.max(0, (world.endsAt || 0) - Date.now());
    return clamp(1 - left / length, 0, 1) * span;
  }
  return 0;
}

function layout(width, height) {
  const live = world && !world.waiting && world.status !== "lobby" && world.status !== "gallery";
  const reveal = world && world.status === "reveal";
  const ask = world && world.status === "ask";
  const top = live ? 82 : 16;
  const bottom = reveal ? Math.min(280, height * 0.4) : ask ? Math.min(height * 0.48, 420) : 18;
  const availW = width - 28;
  const availH = Math.max(120, height - top - bottom);
  let rw = availW;
  let rh = rw * 1.15;
  if (rh > availH) {
    rh = availH;
    rw = rh / 1.15;
  }
  const x = (width - rw) / 2;
  const y = top + Math.max(0, (availH - rh) / 2);
  return {
    x, y, w: rw, h: rh,
    door: { x: x + rw * 0.06, y: y + rh * 0.16, w: rw * 0.24, h: rh * 0.5 },
    window: { x: x + rw * 0.68, y: y + rh * 0.12, w: rw * 0.24, h: rh * 0.32 },
    shelf: { x: x + rw * 0.34, y: y + rh * 0.1, w: rw * 0.28, h: rh * 0.22 },
    table: { x: x + rw * 0.28, y: y + rh * 0.62, w: rw * 0.44, h: rh * 0.24 },
  };
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

function tag(text, x, y) {
  ctx.font = "600 13px Outfit, sans-serif";
  ctx.textAlign = "center";
  ctx.lineWidth = 4;
  ctx.strokeStyle = "rgba(18,12,10,0.88)";
  ctx.strokeText(text, x, y);
  ctx.fillStyle = "#f6f0e6";
  ctx.fillText(text, x, y);
}

function smooth(k) {
  const t = clamp(k, 0, 1);
  return t * t * (3 - 2 * t);
}

function drawHearth(x, y, live) {
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = "#241810";
  roundRectPath(-30, 6, 60, 24, 8);
  ctx.fill();
  ctx.fillStyle = "#5a3828";
  ctx.fillRect(-20, 12, 40, 7);
  for (let i = 0; i < 5; i += 1) {
    const flicker = 0.55 + Math.abs(Math.sin(live * (7 + i) + i * 1.7)) * 0.7;
    const lean = Math.sin(live * 5 + i * 1.2) * 5;
    ctx.save();
    ctx.translate(-16 + i * 8 + lean * 0.3, 12);
    ctx.scale(0.55 + flicker * 0.35, flicker);
    const flame = ctx.createLinearGradient(0, 4, 0, -28);
    flame.addColorStop(0, "#e07a2f");
    flame.addColorStop(0.45, "#f6e27a");
    flame.addColorStop(1, "rgba(246, 226, 122, 0)");
    ctx.fillStyle = flame;
    ctx.beginPath();
    ctx.moveTo(0, 4);
    ctx.bezierCurveTo(-10, -6, -6, -18, lean * 0.15, -26);
    ctx.bezierCurveTo(8, -16, 10, -4, 0, 4);
    ctx.fill();
    ctx.restore();
  }
  ctx.globalAlpha = 1;
  for (let i = 0; i < 8; i += 1) {
    const rise = (live * 36 + i * 13) % 70;
    ctx.globalAlpha = Math.max(0, 1 - rise / 70);
    ctx.fillStyle = i % 2 ? "#fff4d2" : "#e07a2f";
    ctx.beginPath();
    ctx.arc(-18 + (i * 9) % 40 + Math.sin(live * 3 + i) * 6, 8 - rise, 1.8, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawPendant(x, y, live) {
  const swing = Math.sin(live * 1.35) * 0.42;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(swing);
  ctx.strokeStyle = "#c4a46a";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(0, 54);
  ctx.stroke();
  ctx.fillStyle = "#e7b15a";
  ctx.beginPath();
  ctx.moveTo(-18, 52);
  ctx.lineTo(18, 52);
  ctx.lineTo(11, 76);
  ctx.lineTo(-11, 76);
  ctx.closePath();
  ctx.fill();
  const bulb = 0.75 + Math.sin(live * 11) * 0.25;
  ctx.fillStyle = `rgba(246, 226, 122, ${bulb})`;
  ctx.beginPath();
  ctx.ellipse(0, 68, 6, 4, 0, 0, Math.PI * 2);
  ctx.fill();
  const glow = ctx.createRadialGradient(0, 86, 4, 0, 96, 90);
  glow.addColorStop(0, "rgba(246, 214, 140, 0.42)");
  glow.addColorStop(1, "rgba(246, 214, 140, 0)");
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(0, 96, 90, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  const tipX = x + Math.sin(swing) * 70;
  const tipY = y + Math.cos(swing) * 70;
  for (let i = 0; i < 5; i += 1) {
    const ang = live * (1.6 + i * 0.25) + i * 1.4;
    const rad = 16 + (i % 3) * 12;
    const mx = tipX + Math.cos(ang) * rad;
    const my = tipY + Math.sin(ang * 1.4) * rad * 0.4;
    const wing = 0.35 + Math.abs(Math.sin(live * 22 + i)) * 1.1;
    ctx.save();
    ctx.translate(mx, my);
    ctx.rotate(Math.sin(live * 3 + i));
    ctx.fillStyle = "rgba(246, 240, 230, 0.85)";
    ctx.beginPath();
    ctx.ellipse(-4, 0, 5 * wing, 2.2, -0.5, 0, Math.PI * 2);
    ctx.ellipse(4, 0, 5 * wing, 2.2, 0.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

function drawPerson(x, y, scale, token, k, elapsed, moving, facing) {
  const walking = moving !== false;
  const bob = walking ? Math.abs(Math.sin(elapsed * 12)) * -10 : Math.sin(elapsed * 2.4) * 3;
  const step = walking ? Math.sin(elapsed * 12) : Math.sin(elapsed * 2) * 0.2;
  const wave = Math.sin(elapsed * 6);
  ctx.save();
  ctx.translate(x, y + bob);
  ctx.scale(scale * (facing < 0 ? -1 : 1), scale);
  ctx.globalAlpha = clamp(k, 0, 1);
  ctx.fillStyle = "rgba(0,0,0,0.25)";
  ctx.beginPath();
  ctx.ellipse(0, 48, 18 + Math.abs(step) * 4, 6, 0, 0, Math.PI * 2);
  ctx.fill();
  const cloth = { red: "#b4332c", blue: "#243e73", yellow: "#e2b143", green: "#2f6b45" }[token] || "#b4332c";
  ctx.strokeStyle = cloth;
  ctx.lineWidth = 5;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(-7, 28);
  ctx.lineTo(-7 - step * 12, 46);
  ctx.moveTo(7, 28);
  ctx.lineTo(7 + step * 12, 46);
  ctx.moveTo(-14, 4);
  ctx.lineTo(-24, 16 + step * 10);
  ctx.moveTo(14, 4);
  ctx.lineTo(28, -6 + wave * 22);
  ctx.stroke();
  ctx.fillStyle = cloth;
  if (token === "blue" || token === "green") {
    roundRectPath(-16, -8, 32, 40, 8);
    ctx.fill();
    if (token === "blue") {
      ctx.fillStyle = "#1b2430";
      ctx.fillRect(-18, -30, 36, 10);
    } else {
      ctx.fillStyle = "#c4a46a";
      roundRectPath(8, 6, 14, 16, 3);
      ctx.fill();
    }
  } else {
    ctx.beginPath();
    ctx.moveTo(-18, 36);
    ctx.lineTo(0, -8);
    ctx.lineTo(18, 36);
    ctx.closePath();
    ctx.fill();
  }
  const head = token === "yellow" ? 11 : 13;
  ctx.fillStyle = "#2a211c";
  ctx.beginPath();
  ctx.arc(0, -22, head, Math.PI * 1.05, Math.PI * 1.95);
  ctx.fill();
  ctx.fillStyle = "#f3c7a8";
  ctx.beginPath();
  ctx.arc(0, -16, head * 0.82, 0, Math.PI * 2);
  ctx.fill();
  const blink = Math.sin(elapsed * 1.6) > 0.94;
  ctx.fillStyle = "#241810";
  if (blink) {
    ctx.fillRect(-6, -16, 5, 1.6);
    ctx.fillRect(2, -16, 5, 1.6);
  } else {
    ctx.beginPath();
    ctx.arc(-4, -16, 1.8, 0, Math.PI * 2);
    ctx.arc(4, -16, 1.8, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function roundRectPath(x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function drawTableItem(token, rect, k, elapsed) {
  const slide = token === "orange" ? (1 - k) * -28 : token === "letter" ? (1 - k) * -18 : 0;
  const x = rect.x + rect.w * 0.5 + slide;
  const y = rect.y + rect.h * 0.42 + (1 - k) * -16;
  ctx.save();
  ctx.globalAlpha = clamp(k, 0, 1);
  ctx.translate(x, y);
  if (token === "orange") ctx.translate(Math.sin(elapsed * 2.4) * 16, Math.abs(Math.sin(elapsed * 4.8)) * -6);
  else if (token === "letter") ctx.rotate(Math.sin(elapsed * 4.5) * 0.16);
  else if (token === "cup") ctx.rotate(Math.sin(elapsed * 3.2) * 0.12);
  else if (token === "key") ctx.rotate(Math.sin(elapsed * 2.1) * 0.55);
  else ctx.rotate(Math.sin(elapsed * 3) * 0.06);
  ctx.scale(0.7 + 0.3 * k, 0.7 + 0.3 * k);
  if (token === "cup") {
    ctx.fillStyle = "#f4efe6";
    roundRectPath(-10, -8, 20, 16, 4);
    ctx.fill();
    ctx.strokeStyle = "#f4efe6";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(14, 0, 6, -1.2, 1.2);
    ctx.stroke();
  } else if (token === "letter") {
    ctx.fillStyle = "#f7f1e4";
    ctx.fillRect(-16, -12, 32, 24);
    ctx.strokeStyle = "#c4a46a";
    ctx.beginPath();
    ctx.moveTo(-16, -12);
    ctx.lineTo(0, 2);
    ctx.lineTo(16, -12);
    ctx.stroke();
  } else if (token === "orange") {
    ctx.fillStyle = "#e07a2f";
    ctx.beginPath();
    ctx.arc(0, 0, 12, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#6b8f3a";
    ctx.save();
    ctx.rotate(elapsed * 2.4);
    ctx.beginPath();
    ctx.ellipse(0, -10, 3, 6, 0.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.fillStyle = "rgba(255, 236, 210, 0.7)";
    ctx.beginPath();
    ctx.arc(-4, -3, 3, 0, Math.PI * 2);
    ctx.fill();
  } else if (token === "key") {
    ctx.strokeStyle = "#e7b15a";
    ctx.fillStyle = "#e7b15a";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(-8, 0, 7, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(-2, 0);
    ctx.lineTo(16, 0);
    ctx.moveTo(10, 0);
    ctx.lineTo(10, 6);
    ctx.moveTo(15, 0);
    ctx.lineTo(15, 6);
    ctx.stroke();
  } else {
    const flick = 0.7 + Math.abs(Math.sin(elapsed * 16)) * 0.55;
    ctx.fillStyle = "#f4efe6";
    ctx.fillRect(-4, -2, 8, 18);
    for (let i = 0; i < 4; i += 1) {
      const spark = (elapsed * 30 + i * 8) % 24;
      ctx.globalAlpha = clamp(k, 0, 1) * (1 - spark / 24);
      ctx.fillStyle = "#f6e27a";
      ctx.fillRect(-6 + i * 4, -16 - spark, 2, 2);
    }
    ctx.globalAlpha = clamp(k, 0, 1);
    ctx.save();
    ctx.translate(0, -6);
    ctx.scale(0.75 + flick * 0.35, flick);
    ctx.fillStyle = "#e07a2f";
    ctx.beginPath();
    ctx.ellipse(0, -6, 5, 9, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#f6e27a";
    ctx.beginPath();
    ctx.ellipse(0, -4, 2.2, 5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  if (token === "cup") {
    ctx.strokeStyle = "rgba(246,240,230,0.45)";
    ctx.lineWidth = 1.4;
    for (let i = 0; i < 3; i += 1) {
      const rise = (elapsed * 16 + i * 9) % 22;
      ctx.globalAlpha = clamp(k, 0, 1) * (1 - rise / 22);
      ctx.beginPath();
      ctx.arc(-4 + i * 4, -12 - rise, 2.2, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  if (token === "key") {
    const glint = (elapsed * 40) % 28;
    ctx.strokeStyle = "rgba(255,244,214,0.9)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(-12 + glint, -6);
    ctx.lineTo(-6 + glint, 2);
    ctx.stroke();
  }
  ctx.restore();
}

function drawWindowEvent(token, rect, k, elapsed) {
  ctx.save();
  roundRect(rect.x, rect.y, rect.w, rect.h, 8);
  ctx.clip();
  if (token === "rain") {
    ctx.strokeStyle = "rgba(190, 214, 230, 0.9)";
    ctx.lineWidth = 1.6;
    ctx.globalAlpha = k;
    for (let i = 0; i < 36; i += 1) {
      const x = rect.x + ((i * 29) % rect.w);
      const y = rect.y + ((i * 17 + elapsed * 110) % (rect.h + 20)) - 10;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x - 5, y + 14);
      ctx.stroke();
    }
    if (Math.sin(elapsed * 1.7) > 0.9) {
      ctx.fillStyle = "rgba(230, 240, 255, 0.45)";
      ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
    }
    ctx.fillStyle = "rgba(190, 214, 230, 0.55)";
    for (let i = 0; i < 8; i += 1) {
      const splash = (elapsed * 3 + i * 0.4) % 1;
      const x = rect.x + ((i * 37) % (rect.w - 10)) + 4;
      ctx.globalAlpha = k * (1 - splash);
      ctx.beginPath();
      ctx.ellipse(x, rect.y + rect.h - 4, 3 + splash * 8, 1.4, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  } else if (token === "bicycle") {
    const travel = (elapsed % 4.2) / 4.2;
    const x = rect.x - 36 + (rect.w + 72) * travel;
    const y = rect.y + rect.h * 0.66;
    const spin = elapsed * 16;
    const bob = Math.abs(Math.sin(elapsed * 10)) * -2;
    ctx.globalAlpha = k;
    ctx.strokeStyle = "#f4efe6";
    ctx.fillStyle = "#f4efe6";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x - 14, y, 9, 0, Math.PI * 2);
    ctx.arc(x + 16, y, 9, 0, Math.PI * 2);
    ctx.moveTo(x - 14, y);
    ctx.lineTo(x + 2, y - 14);
    ctx.lineTo(x + 16, y);
    ctx.moveTo(x - 14, y);
    ctx.lineTo(x - 14 + Math.cos(spin) * 7, y + Math.sin(spin) * 7);
    ctx.moveTo(x + 16, y);
    ctx.lineTo(x + 16 + Math.cos(spin + 1) * 7, y + Math.sin(spin + 1) * 7);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x + 1, y - 22 + bob, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(x + 1, y - 18 + bob);
    ctx.lineTo(x + 4, y - 8);
    ctx.moveTo(x + 1, y - 14 + bob);
    ctx.lineTo(x + 8, y - 16 + Math.sin(elapsed * 10) * 3);
    ctx.stroke();
  } else if (token === "moon") {
    const pulse = 12 + Math.sin(elapsed * 2.4) * 1.4;
    const mx = rect.x + rect.w * 0.62;
    const my = rect.y + rect.h * 0.38;
    ctx.globalAlpha = k;
    ctx.fillStyle = "rgba(244,239,226,0.28)";
    ctx.beginPath();
    ctx.arc(mx, my, pulse + 10, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#f4efe2";
    ctx.beginPath();
    ctx.arc(mx, my, pulse, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "rgba(20, 32, 44, 0.92)";
    for (let i = 0; i < 3; i += 1) {
      const drift = ((elapsed * 18 + i * rect.w * 0.4) % (rect.w + 40)) - 20;
      ctx.beginPath();
      ctx.ellipse(rect.x + drift, rect.y + 10 + i * 8, 16, 6, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  } else {
    const x = rect.x + rect.w * 0.5 + Math.sin(elapsed * 1.15) * rect.w * 0.22;
    const y = rect.y + rect.h * 0.62 + Math.abs(Math.sin(elapsed * 3.2)) * -16;
    const wag = Math.sin(elapsed * 9) * 14;
    ctx.globalAlpha = k;
    ctx.fillStyle = "#f7f4ee";
    ctx.beginPath();
    ctx.ellipse(x, y, 14, 8, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x + 10, y - 6, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(x + 6, y - 11);
    ctx.lineTo(x + 4, y - 17);
    ctx.lineTo(x + 10, y - 11);
    ctx.moveTo(x + 12, y - 11);
    ctx.lineTo(x + 16, y - 17);
    ctx.lineTo(x + 15, y - 10);
    ctx.fill();
    ctx.strokeStyle = "#f7f4ee";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x - 12, y);
    ctx.quadraticCurveTo(x - 26, y - 16, x - 8 + wag * 0.55, y - 22);
    ctx.stroke();
    ctx.fillStyle = "#241810";
    ctx.beginPath();
    ctx.arc(x + 12, y - 6, 1, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawShelfEvent(token, rect, k, elapsed) {
  const x = rect.x + rect.w * 0.5;
  const y = rect.y + rect.h * 0.48;
  ctx.save();
  ctx.translate(x, y);
  ctx.globalAlpha = clamp(k, 0, 1);
  if (token === "book") {
    const fall = smooth(Math.min(1, elapsed / 0.55));
    const bounce = Math.sin(Math.min(elapsed, 1.2) * 16) * Math.max(0, 0.35 - elapsed * 0.2);
    const flutter = elapsed > 0.7 ? Math.sin(elapsed * 9) * 0.18 : 0;
    ctx.translate(0, fall * 16);
    ctx.rotate(fall * 1.15 + bounce + flutter);
    ctx.fillStyle = "#8f3d3a";
    ctx.fillRect(-16, -20, 32, 8);
    ctx.fillStyle = "#f4efe6";
    for (let i = 0; i < 4; i += 1) {
      const page = Math.sin(elapsed * 8 + i) * 3;
      ctx.fillRect(-16, -19 + i * 2, 32, 1.4);
      ctx.fillStyle = "#f7f1e4";
      ctx.fillRect(-16 + page, -20 + i * 2.2, 14, 1.2);
      ctx.fillStyle = "#f4efe6";
    }
  } else if (token === "plant") {
    const sway = Math.sin(elapsed * 2.5) * 0.28;
    ctx.fillStyle = "#c48b5a";
    ctx.fillRect(-10, 4, 20, 12);
    ctx.save();
    ctx.rotate(sway);
    ctx.fillStyle = "#3f7a45";
    ctx.beginPath();
    ctx.ellipse(0, -10, 8, 14, 0, 0, Math.PI * 2);
    ctx.ellipse(-12, -2, 7, 9, -0.5, 0, Math.PI * 2);
    ctx.ellipse(12, -1, 7, 9, 0.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.strokeStyle = "rgba(180, 214, 230, 0.8)";
    ctx.lineWidth = 1.4;
    for (let i = 0; i < 3; i += 1) {
      const drop = (elapsed * 28 + i * 10) % 26;
      ctx.globalAlpha = clamp(k, 0, 1) * (1 - drop / 26);
      ctx.beginPath();
      ctx.moveTo(-4 + i * 4, -16 + drop);
      ctx.lineTo(-5 + i * 4, -10 + drop);
      ctx.stroke();
    }
  } else if (token === "photo") {
    const flip = smooth(Math.min(1, elapsed / 0.7));
    const rock = elapsed > 0.7 ? Math.sin(elapsed * 2.2) * 0.12 : 0;
    ctx.rotate(rock);
    ctx.scale(Math.cos(flip * Math.PI), 1);
    ctx.fillStyle = flip > 0.5 ? "#2a211c" : "#d9c7a4";
    ctx.fillRect(-14, -18, 28, 34);
    if (flip <= 0.5) {
      ctx.fillStyle = "#8fbf7a";
      ctx.fillRect(-8, -8, 16, 12);
      ctx.fillStyle = "#f6e27a";
      ctx.beginPath();
      ctx.arc(-2 + Math.sin(elapsed * 3) * 4, -12, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  } else {
    ctx.strokeStyle = "#e7b15a";
    ctx.fillStyle = "#2a2118";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(0, 0, 18, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    const hour = token === "seven" ? 7 : token === "eleven" ? 11 : 3;
    const hourAngle = ((hour % 12) / 12) * Math.PI * 2 - Math.PI / 2;
    const second = elapsed * Math.PI * 2 - Math.PI / 2;
    const tick = Math.sin(elapsed * Math.PI * 2);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(Math.cos(hourAngle) * 9, Math.sin(hourAngle) * 9);
    ctx.moveTo(0, 0);
    ctx.lineTo(Math.cos(second) * (14 + tick), Math.sin(second) * (14 + tick));
    ctx.stroke();
    ctx.save();
    ctx.rotate(tick * 0.55);
    ctx.beginPath();
    ctx.moveTo(0, 16);
    ctx.lineTo(0, 34);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, 36, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  ctx.restore();
}

function drawBeat(beat, rects, time) {
  const elapsed = Math.max(0, time - beat.t);
  const k = smooth(Math.min(1, elapsed / 0.7));
  if (k <= 0) return;
  const rect = rects[beat.zone];
  if (!rect) return;
  if (elapsed < 0.85) {
    const ring = elapsed / 0.85;
    ctx.save();
    ctx.globalAlpha = (1 - ring) * 0.85;
    ctx.strokeStyle = "#f6e27a";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(rect.x + rect.w / 2, rect.y + rect.h / 2, 10 + ring * Math.max(rect.w, rect.h) * 0.85, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
  if (beat.zone === "door") {
    const paceWave = Math.sin((elapsed - 0.7) * 1.8);
    const pace = k < 0.98 ? k : 0.15 + (paceWave * 0.5 + 0.5) * 0.7;
    const x = rect.x + rect.w * (0.22 + 0.56 * pace);
    ctx.save();
    roundRect(rect.x - 6, rect.y - 6, rect.w + 12, rect.h + 10, 10);
    ctx.clip();
    drawPerson(x, rect.y + rect.h * 0.42, rect.h / 88, beat.token, k, elapsed, true, paceWave);
    ctx.restore();
  } else if (beat.zone === "table") {
    drawTableItem(beat.token, rect, k, elapsed);
  } else if (beat.zone === "window") {
    drawWindowEvent(beat.token, rect, k, elapsed);
  } else {
    drawShelfEvent(beat.token, rect, k, elapsed);
  }
  if (k > 0.35 && world && (world.status === "watch" || world.status === "reveal")) {
    tag(beat.label, rect.x + rect.w / 2, rect.y + rect.h + 16);
  }
}

function drawVeil(rect, live) {
  const breathe = 0.9 + Math.sin(live * 1.7 + rect.x * 0.01) * 0.05;
  ctx.save();
  ctx.fillStyle = `rgba(10, 8, 7, ${breathe})`;
  roundRect(rect.x - 8, rect.y - 8, rect.w + 16, rect.h + 28, 16);
  ctx.fill();
  const pulse = 1 + Math.sin(live * 2.4) * 0.08;
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(pulse, pulse);
  ctx.translate(-cx, -cy);
  ctx.strokeStyle = `rgba(231, 177, 90, ${0.35 + Math.sin(live * 3) * 0.2})`;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(cx, cy - 16, 14, 0, Math.PI * 2);
  ctx.moveTo(cx - 8, cy - 4);
  ctx.lineTo(cx - 16, cy + 28);
  ctx.lineTo(cx + 16, cy + 28);
  ctx.lineTo(cx + 8, cy - 4);
  ctx.stroke();
  ctx.restore();
  const scan = (live * 40) % (rect.h + 20);
  ctx.globalAlpha = 0.35;
  ctx.fillStyle = "#e7b15a";
  ctx.fillRect(rect.x, rect.y + scan - 10, rect.w, 2);
  for (let i = 0; i < 6; i += 1) {
    const py = rect.y + ((live * 22 + i * 28) % (rect.h + 10));
    ctx.globalAlpha = 0.45;
    ctx.fillStyle = "#f2d7a2";
    ctx.fillRect(rect.x + 10 + (i * 23) % Math.max(12, rect.w - 16), py, 2, 2);
  }
  ctx.restore();
  tag("Hidden", rect.x + rect.w / 2, rect.y + rect.h / 2);
}

function drawParlor(rects, live, time) {
  const { x, y, w, h } = rects;
  const flick = 0.9 + Math.sin(live * 2.4) * 0.05 + Math.sin(live * 9.5) * 0.03;
  const glow = ctx.createRadialGradient(x + w * 0.5, y + h * 0.08, 10, x + w * 0.5, y + h * 0.45, w * 0.75);
  glow.addColorStop(0, `rgba(${Math.round(90 * flick)}, ${Math.round(62 * flick)}, ${Math.round(40 * flick)}, 1)`);
  glow.addColorStop(1, "#1a120e");
  ctx.fillStyle = glow;
  roundRect(x, y, w, h, 28);
  ctx.fill();
  ctx.fillStyle = "#3a2a22";
  roundRect(x + 12, y + h * 0.72, w - 24, h * 0.24, 18);
  ctx.fill();
  ctx.fillStyle = "#6e2e2a";
  ctx.beginPath();
  ctx.ellipse(x + w * 0.5, y + h * 0.8, w * 0.28, h * 0.06, 0, 0, Math.PI * 2);
  ctx.fill();

  const shelf = rects.shelf;
  ctx.fillStyle = "#4a3428";
  ctx.fillRect(shelf.x, shelf.y + shelf.h * 0.7, shelf.w, 8);

  const win = rects.window;
  ctx.fillStyle = "#14202c";
  roundRect(win.x, win.y, win.w, win.h, 8);
  ctx.fill();
  ctx.save();
  roundRect(win.x, win.y, win.w, win.h, 8);
  ctx.clip();
  for (let i = 0; i < 8; i += 1) {
    const twinkle = 0.25 + Math.sin(live * 3 + i) * 0.25;
    ctx.globalAlpha = Math.max(0, twinkle);
    ctx.fillStyle = "#f4efe6";
    ctx.fillRect(win.x + 8 + (i * 17) % (win.w - 16), win.y + 8 + (i * 13) % (win.h - 16), 2, 2);
  }
  const sway = Math.sin(live * 1.6) * 12;
  ctx.globalAlpha = 0.55;
  ctx.fillStyle = "#6e3b3a";
  ctx.beginPath();
  ctx.moveTo(win.x, win.y);
  ctx.quadraticCurveTo(win.x + 16 + sway, win.y + win.h * 0.5, win.x, win.y + win.h);
  ctx.lineTo(win.x + 14, win.y + win.h);
  ctx.quadraticCurveTo(win.x + 28 + sway, win.y + win.h * 0.45, win.x + 10, win.y);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(win.x + win.w, win.y);
  ctx.quadraticCurveTo(win.x + win.w - 16 - sway, win.y + win.h * 0.5, win.x + win.w, win.y + win.h);
  ctx.lineTo(win.x + win.w - 14, win.y + win.h);
  ctx.quadraticCurveTo(win.x + win.w - 28 - sway, win.y + win.h * 0.45, win.x + win.w - 10, win.y);
  ctx.fill();
  ctx.restore();
  ctx.strokeStyle = "#c4a46a";
  ctx.lineWidth = 4;
  roundRect(win.x, win.y, win.w, win.h, 8);
  ctx.stroke();

  const door = rects.door;
  const beat = (world && !world.waiting ? world.beats || [] : []).find((item) => item.zone === "door");
  const opened = beat ? smooth(clamp((time - beat.t) / 0.65, 0, 1)) : 0;
  const swing = 0.12 + opened * 0.78 + Math.sin(live * 2.4) * 0.035;
  ctx.fillStyle = "#2a1c14";
  roundRect(door.x - 5, door.y - 4, door.w + 10, door.h + 6, 8);
  ctx.fill();
  if (swing > 0.2) {
    ctx.save();
    ctx.globalAlpha = 0.28 * swing;
    ctx.fillStyle = "#f0c27a";
    ctx.fillRect(door.x + 6, door.y + 6, door.w * swing, door.h - 10);
    ctx.restore();
  }
  ctx.save();
  ctx.translate(door.x, door.y);
  ctx.transform(Math.max(0.16, 1 - swing), 0, swing * 0.18, 1, 0, 0);
  ctx.fillStyle = "#4a3122";
  roundRectPath(0, 0, door.w, door.h, 6);
  ctx.fill();
  ctx.strokeStyle = "#2a1c14";
  ctx.lineWidth = 2;
  ctx.strokeRect(door.w * 0.16, door.h * 0.08, door.w * 0.68, door.h * 0.34);
  ctx.strokeRect(door.w * 0.16, door.h * 0.5, door.w * 0.68, door.h * 0.34);
  ctx.fillStyle = "#e7b15a";
  ctx.beginPath();
  ctx.arc(door.w * 0.84, door.h * 0.55, 3.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  const table = rects.table;
  ctx.fillStyle = "#5a3b28";
  ctx.beginPath();
  ctx.ellipse(table.x + table.w / 2, table.y + table.h * 0.55, table.w / 2, table.h * 0.28, 0, 0, Math.PI * 2);
  ctx.fill();

  const lamp = ctx.createRadialGradient(x + w * 0.5, y + 10, 0, x + w * 0.5, y + 18, w * 0.5);
  lamp.addColorStop(0, `rgba(231, 177, 90, ${0.34 * flick})`);
  lamp.addColorStop(1, "rgba(231, 177, 90, 0)");
  ctx.fillStyle = lamp;
  ctx.fillRect(x, y, w, h);
  ctx.save();
  roundRect(x, y, w, h, 28);
  ctx.clip();
  ctx.translate(x + w * 0.5, y);
  ctx.rotate(Math.sin(live * 0.85) * 0.6);
  ctx.fillStyle = "rgba(246, 220, 150, 0.16)";
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(-80, h * 1.3);
  ctx.lineTo(80, h * 1.3);
  ctx.fill();
  ctx.restore();
  drawHearth(x + w * 0.84, y + h * 0.78, live);
  drawPendant(x + w * 0.5, y + 4, live);
  ctx.save();
  roundRect(x, y, w, h, 28);
  ctx.clip();
  for (let i = 0; i < 22; i += 1) {
    const rise = (live * 26 + i * 37) % (h + 24);
    const px = x + ((i * 53 + Math.sin(live + i) * 18) % w);
    ctx.globalAlpha = 0.15 + (i % 4) * 0.08;
    ctx.fillStyle = i % 2 ? "#f6e27a" : "#f2d7a2";
    ctx.beginPath();
    ctx.arc(px, y + h - rise, 1.6 + (i % 3), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

let holdScene = 0;
let holdLive = 0;

function motionNow() {
  const live = performance.now() / 1000;
  if (!world || world.waiting || world.status === "lobby" || world.status === "gallery") return live;
  const scene = sceneTime();
  if (world.status === "watch" || world.status === "reveal") {
    holdScene = scene;
    holdLive = live;
    return scene;
  }
  return holdScene + (live - holdLive);
}

function frame(now) {
  lastFrame = now;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = window.innerWidth;
  const height = window.innerHeight;
  if (canvas.width !== Math.floor(width * dpr) || canvas.height !== Math.floor(height * dpr)) {
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#120e0c";
  ctx.fillRect(0, 0, width, height);
  const rects = layout(width, height);
  const live = performance.now() / 1000;
  const time = motionNow();
  const driftX = Math.sin(live * 0.7) * 12;
  const driftY = Math.cos(live * 0.5) * 7;
  ctx.save();
  ctx.translate(driftX, driftY);
  drawParlor(rects, live, time);
  const beats = world && !world.waiting ? world.beats || [] : [];
  for (const beat of beats) drawBeat(beat, rects, time);
  if (world && world.status !== "reveal" && world.status !== "lobby" && world.status !== "gallery" && !world.waiting) {
    for (const hidden of world.hidden || []) {
      if (rects[hidden.zone]) drawVeil(rects[hidden.zone], live);
    }
  }
  ctx.restore();
  if (world && (world.status === "watch" || world.status === "ask")) syncChrome();
  requestAnimationFrame(frame);
}

window.addEventListener("resize", () => {});
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

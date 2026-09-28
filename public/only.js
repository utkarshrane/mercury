"use strict";

const socket = io("/only", { transports: ["websocket", "polling"] });
const app = document.querySelector("#app");
const sessionKey = "only";
let world = null;
let name = localStorage.getItem("only.name") || "";
let error = "";
let painted = "";

function session() {
  try { return JSON.parse(sessionStorage.getItem(sessionKey) || "null"); }
  catch { return null; }
}
function saveSession(next) {
  if (next) sessionStorage.setItem(sessionKey, JSON.stringify(next));
  else sessionStorage.removeItem(sessionKey);
}
function emit(event, payload = {}) {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}
function shell(inner) {
  app.innerHTML = `<header class="brand"><div class="mark">ONLY</div><div id="clock"></div></header>${inner}`;
}
function clock(ms) {
  return `${Math.max(0, Math.ceil(ms / 1000))}s`;
}
function home() {
  const params = new URLSearchParams(location.search);
  const code = (params.get("room") || "").toUpperCase();
  shell(`
    <section>
      <h1>One card. One phone. Or nobody scores.</h1>
      <p class="lede">Your hand stays on your phone. A point lands only when a single card fits the line.</p>
    </section>
    <section class="sheet">
      <ol class="steps">
        <li>Each phone is dealt five cards. Nobody else can see them.</li>
        <li>Play one card that fits the line, or hold.</li>
        <li>Two fitting cards cancel. Exactly one scores.</li>
      </ol>
    </section>
    <form class="sheet" id="join">
      <label for="name">Your name</label>
      <input id="name" maxlength="16" value="${name.replace(/"/g, "")}" placeholder="Mira" />
      <label for="code">Room code</label>
      <input id="code" maxlength="4" value="${code}" placeholder="ABCD" />
      <div class="buttons pair">
        <button class="primary" type="submit" data-act="create">Open a table</button>
        <button class="ghost" type="submit" data-act="join">Join</button>
      </div>
      <p class="error" id="error">${error}</p>
    </form>
    <nav class="links">
      <a href="/keyhole">Keyhole</a>
      <a href="/nest">Nest</a>
      <a href="/">Mercury</a>
    </nav>
  `);
}
const WASH = {
  tea: "#c47a1a", soup: "#c4553a", lamp: "#d4a017", mango: "#e08a2c",
  cake: "#c46b8a", ice: "#3d7ea6", coin: "#a67c2d", key: "#8a6a3b",
  bell: "#2f6f4e", drum: "#1d4e89", moon: "#5b4b8a", wool: "#8d6e63",
};
function chip(card) {
  const wash = WASH[card.id] || "#1c2430";
  return `<i class="chip" style="background:${wash}">${card.name.slice(0, 1)}</i>`;
}
function seatLine(player) {
  const you = player.id === world.you;
  const lock = world.status === "play" && player.ready ? (you ? " · played" : " · locked") : "";
  return `${player.name}${player.host ? " · host" : ""} · ${player.score}${lock}`;
}
function seats() {
  return `<div class="seats">${world.players.map((player) => `<span class="seat${world.status === "play" && player.ready ? " locked" : ""}">${seatLine(player)}</span>`).join("")}</div>`;
}
function statusLine() {
  const others = world.players.filter((player) => player.id !== world.you && player.ready);
  const mine = world.choice === "hold"
    ? "You are holding."
    : world.choice
      ? `You played ${((world.hand || []).find((card) => card.key === world.choice) || {}).name || "a card"}.`
      : (world.hand || []).some((card) => card.fit)
        ? "Tap a card that fits, or hold."
        : "Nothing in your hand fits.";
  const them = others.length ? ` ${others.map((player) => player.name).join(" and ")} locked in.` : "";
  return mine + them;
}
function lobby() {
  const you = world.players.find((player) => player.id === world.you);
  const ready = world.players.filter((player) => player.connected).length >= 2;
  shell(`
    <section class="sheet">
      <p class="quiet">Room</p>
      <div class="code">${world.code}</div>
      <p class="quiet">Open this on the other phone, or share the code.</p>
      ${seats()}
      <p class="error" id="error">${error}</p>
      ${you && you.host ? `<button class="primary" id="start" ${ready ? "" : "disabled"}>Deal five cards</button>` : `<p class="quiet">Waiting for the host.</p>`}
      <button class="ghost" id="leave">Leave</button>
    </section>
  `);
}
function play() {
  if (world.waiting) {
    shell(`<section class="sheet"><h2>This hand already started.</h2><p class="quiet">You'll be dealt in on the next table.</p></section>`);
    return;
  }
  const key = `${world.round}:${world.hand.map((card) => card.key).join(",")}`;
  if (painted === key && app.querySelector(".hand")) {
    mark();
    return;
  }
  painted = key;
  const any = world.hand.some((card) => card.fit);
  const cards = [...world.hand].sort((a, b) => Number(b.fit) - Number(a.fit) || a.name.localeCompare(b.name));
  shell(`
    <section class="prompt">
      <div>Round ${world.round} of ${world.rounds}</div>
      <p>Play ${world.line}.</p>
    </section>
    ${seats()}
    <p class="status" id="status"></p>
    <div class="hand">${cards.map((card) => `
      <button class="tile${card.fit ? " fit" : " off"}" data-key="${card.key}" ${card.fit ? "" : "disabled"}>
        ${chip(card)}
        <span class="kind">${card.fit ? "Fits" : "Stays"}</span>
        <strong>${card.name}</strong>
      </button>
    `).join("")}</div>
    <button class="hold" id="hold">${any ? "Hold" : "Nothing fits. Hold."}</button>
    <p class="error" id="error"></p>
  `);
  mark();
}
function mark() {
  app.querySelectorAll(".tile").forEach((tile) => tile.classList.toggle("on", tile.dataset.key === world.choice));
  const hold = app.querySelector("#hold");
  if (hold) hold.classList.toggle("on", world.choice === "hold");
  app.querySelectorAll(".seat").forEach((node, index) => {
    const player = world.players[index];
    if (!player) return;
    node.textContent = seatLine(player);
    node.classList.toggle("locked", world.status === "play" && player.ready);
  });
  const status = app.querySelector("#status");
  if (status) status.textContent = statusLine();
}
function reveal() {
  painted = "";
  if (world.waiting) {
    shell(`<section class="sheet"><h2>This hand already started.</h2></section>`);
    return;
  }
  shell(`
    <section class="prompt"><p>${world.verdict}</p></section>
    <div class="table">${world.table.map((play) => `
      <div class="played${play.fit ? " fit" : ""}${play.playerId === world.awarded ? " scored" : ""}">
        <span>${play.name}</span>
        <b>${play.card ? play.card.name : "Held"}</b>
        <em>${play.card ? (play.fit ? "Fit" : "Missed") : ""}</em>
      </div>
    `).join("")}</div>
    <p class="quiet">The line was ${world.line}.</p>
  `);
}
function result() {
  painted = "";
  const ranked = [...world.players].sort((a, b) => b.score - a.score);
  const top = ranked[0] && ranked[0].score;
  const winners = ranked.filter((player) => player.score === top).map((player) => player.name);
  const you = world.players.find((player) => player.id === world.you);
  shell(`
    <section class="sheet">
      <h2>${winners.length === 1 ? `${winners[0]} takes the table.` : "The table is tied."}</h2>
      <p class="lede">${world.verdict}</p>
      ${ranked.map((player) => `<div class="score"><span>${player.name}</span><strong>${player.score}</strong></div>`).join("")}
      <p class="error" id="error">${error}</p>
      ${you && you.host ? `<button class="primary" id="start">Deal again</button>` : `<p class="quiet">Waiting for the host.</p>`}
      <button class="ghost" id="leave">Leave</button>
    </section>
  `);
}
function draw() {
  if (!world) return home();
  if (world.status === "lobby") return lobby();
  if (world.status === "play") return play();
  if (world.status === "reveal") return reveal();
  if (world.status === "result") return result();
  home();
}
function tickClock() {
  const node = document.querySelector("#clock");
  if (!node) return;
  if (!world || !world.endsAt || (world.status !== "play" && world.status !== "reveal")) {
    node.textContent = "";
    return;
  }
  node.textContent = clock(world.endsAt - Date.now());
}
setInterval(tickClock, 200);

app.addEventListener("click", async (event) => {
  const tile = event.target.closest(".tile");
  if (tile && !tile.disabled) {
    const ack = await emit("choose", { card: tile.dataset.key, round: world && world.round });
    error = ack && ack.ok ? "" : (ack && ack.error) || "";
    const node = document.querySelector("#error");
    if (node) node.textContent = error;
    return;
  }
  if (event.target.id === "hold") {
    const ack = await emit("choose", { card: "hold", round: world && world.round });
    error = ack && ack.ok ? "" : (ack && ack.error) || "";
    const node = document.querySelector("#error");
    if (node) node.textContent = error;
    return;
  }
  if (event.target.id === "start") {
    const ack = await emit("start", {});
    error = ack && ack.ok ? "" : (ack && ack.error) || "";
    if (error) draw();
    return;
  }
  if (event.target.id === "leave") {
    await emit("leave", {});
    world = null;
    saveSession(null);
    painted = "";
    draw();
  }
});
app.addEventListener("submit", async (event) => {
  if (!event.target.closest("#join")) return;
  event.preventDefault();
  name = document.querySelector("#name").value.trim();
  localStorage.setItem("only.name", name);
  const act = event.submitter && event.submitter.dataset.act;
  const ack = act === "join"
    ? await emit("joinRoom", { name, code: document.querySelector("#code").value, playerId: session() && session().playerId })
    : await emit("createRoom", { name });
  error = ack && ack.ok ? "" : (ack && ack.error) || "Could not open the table.";
  if (ack && ack.ok) saveSession({ playerId: ack.playerId, code: ack.code });
  draw();
});

socket.on("world", (next) => {
  world = next;
  error = "";
  draw();
  tickClock();
});
socket.on("connect", async () => {
  const saved = session();
  const params = new URLSearchParams(location.search);
  const code = (params.get("room") || (saved && saved.code) || "").toUpperCase();
  if (!saved || !code) return;
  const ack = await emit("joinRoom", { code, playerId: saved.playerId, name });
  if (ack && ack.ok) saveSession({ playerId: ack.playerId, code: ack.code });
});

draw();

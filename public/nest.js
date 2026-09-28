"use strict";

const socket = io("/nest", { transports: ["websocket", "polling"] });
const app = document.querySelector("#app");
const sessionKey = "nest";
let world = null;
let name = localStorage.getItem("nest.name") || "";
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
function clock(ms) {
  const left = Math.max(0, Math.ceil(ms / 1000));
  const m = String(Math.floor(left / 60)).padStart(1, "0");
  const s = String(left % 60).padStart(2, "0");
  return `${m}:${s}`;
}
function chickFace(id) {
  const fills = { pip: "#e7a15a", moth: "#7eb6c9", lumen: "#e28b8b" };
  const fill = fills[id] || "#e7a15a";
  return `<svg class="face" viewBox="0 0 64 64" aria-hidden="true">
    <ellipse cx="32" cy="46" rx="20" ry="8" fill="#c4a574"/>
    <circle cx="32" cy="28" r="14" fill="${fill}"/>
    <circle cx="27" cy="26" r="1.7" fill="#2c2416"/>
    <circle cx="37" cy="26" r="1.7" fill="#2c2416"/>
    <path d="M30 32h4l-2 3z" fill="#d4654a"/>
  </svg>`;
}
function shell(inner) {
  app.innerHTML = `<header class="brand"><div class="mark">NEST</div><div id="clock"></div></header>${inner}`;
}
function home() {
  const params = new URLSearchParams(location.search);
  const code = (params.get("room") || "").toUpperCase();
  shell(`
    <section class="hero">
      <h1>One nest. Three chicks. Split across phones.</h1>
      <p class="lede">Every bar is on every screen. You can only care for the chick with your name.</p>
    </section>
    <section class="card">
      <ol class="steps">
        <li>Your phone holds one chick. With two phones, the third chick is open to both.</li>
        <li>Tap the lowest bar. Warm also lifts a little warmth on the other chicks.</li>
        <li>Keep every bar above zero for one minute.</li>
      </ol>
    </section>
    <form class="card" id="join">
      <label for="name">Your name</label>
      <input id="name" maxlength="16" value="${name.replace(/"/g, "")}" placeholder="Mira" />
      <div class="row">
        <button class="primary" type="submit" data-act="create">Open a nest</button>
        <button class="ghost" type="submit" data-act="join">Join</button>
      </div>
      <label for="code">Room code</label>
      <input id="code" maxlength="4" value="${code}" placeholder="ABCD" />
      <p class="error" id="error">${error}</p>
    </form>
    <nav class="links">
      <a href="/keyhole">Keyhole</a>
      <a href="/vital">Vital</a>
      <a href="/">Mercury</a>
    </nav>
  `);
}
function lobby() {
  const you = world.players.find((player) => player.id === world.you);
  const host = you && you.host;
  shell(`
    <section class="sheet">
      <p class="quiet">Room</p>
      <div class="code">${world.code}</div>
      <p class="quiet">Open this on the other phone, or share the code.</p>
      <div class="seats">${world.players.map((player) => `<span class="seat">${player.name}${player.host ? " · host" : ""}</span>`).join("")}</div>
      <p class="error" id="error">${error}</p>
      ${host ? `<button class="primary" id="start" ${world.players.filter((player) => player.connected).length < 2 ? "disabled" : ""}>Start the minute</button>` : `<p class="quiet">Waiting for the host.</p>`}
      <button class="ghost" id="leave">Leave</button>
    </section>
  `);
}
function bars(chick) {
  return chick.needs.map((need) => `
    <div class="meter">
      <span>${need.label}</span>
      <span class="track"><i class="${need.tone}" style="width:${need.value}%"></i></span>
      <span>${need.value}%</span>
    </div>
  `).join("");
}
function actions(chick) {
  const lowest = chick.needs.reduce((best, need) => (need.value < best.value ? need : best), chick.needs[0]);
  return chick.needs.map((need) => `
    <button class="care${need.id === lowest.id && need.value < 70 ? " hot" : ""}" data-chick="${chick.id}" data-need="${need.id}" ${chick.mine ? "" : "disabled"}>
      ${need.label}
    </button>
  `).join("");
}
function card(chick) {
  const other = (chick.owners || []).filter((owner) => owner.id !== world.you).map((owner) => owner.name);
  const who = chick.shared ? "Either phone" : chick.mine ? "Your chick" : `${other[0] || "Someone"}'s chick`;
  const badge = chick.shared ? "Shared" : chick.mine ? "Yours" : "Locked";
  const lowest = chick.needs.reduce((best, need) => (need.value < best.value ? need : best), chick.needs[0]);
  return `
    <article class="chick ${chick.mine ? "mine" : "theirs"}${lowest.value < 40 ? " urgent" : ""}" data-id="${chick.id}">
      <div class="head">
        ${chickFace(chick.id)}
        <div>
          <p class="who">${who}</p>
          <h2>${chick.name}</h2>
        </div>
        <span class="badge">${badge}</span>
      </div>
      <div class="meters">${bars(chick)}</div>
      ${chick.mine ? `<div class="actions">${actions(chick)}</div>` : `<p class="quiet">Only ${other[0] || "the other phone"} can tap ${chick.name}.</p>`}
    </article>
  `;
}
function shift() {
  if (world.waiting) {
    shell(`<section class="sheet"><h2>The minute already started.</h2><p class="quiet">You'll be in the next one.</p></section>`);
    return;
  }
  const chicks = ordered(world.chicks);
  const worst = worstNeed(chicks);
  const key = chicks.map((chick) => `${chick.id}:${chick.mine}:${chick.shared}`).join("|");
  if (painted === `shift:${key}` && app.querySelector(".floor")) {
    chicks.forEach((chick) => {
      const node = app.querySelector(`[data-id="${chick.id}"]`);
      if (!node) return;
      node.querySelector(".meters").innerHTML = bars(chick);
      const lowest = chick.needs.reduce((best, need) => (need.value < best.value ? need : best), chick.needs[0]);
      node.classList.toggle("urgent", lowest.value < 40);
      node.querySelectorAll(".care").forEach((button) => {
        button.classList.toggle("hot", button.dataset.need === lowest.id && lowest.value < 70);
      });
    });
    const err = app.querySelector("#error");
    if (err && Date.now() >= (world.readyAt || 0)) err.textContent = "";
    const note = app.querySelector(".note");
    if (note) {
      note.textContent = worst && worst.value < 40
        ? `${worst.chick} needs ${worst.label.toLowerCase()} now.`
        : (world.note || "Tap the lowest bar on your chick.");
      note.classList.toggle("urgent", Boolean(worst && worst.value < 40));
    }
    return;
  }
  painted = `shift:${key}`;
  const banner = worst && worst.value < 40
    ? `${worst.chick} needs ${worst.label.toLowerCase()} now.`
    : (world.note || "Tap the lowest bar on your chick.");
  shell(`
    <p class="note${worst && worst.value < 40 ? " urgent" : ""}">${banner}</p>
    <p class="error" id="error"></p>
    <section class="floor">${chicks.map(card).join("")}</section>
  `);
}
function ordered(chicks) {
  return [...chicks].sort((a, b) => rank(a) - rank(b));
}
function rank(chick) {
  if (chick.mine && !chick.shared) return 0;
  if (chick.shared) return 1;
  return 2;
}
function worstNeed(chicks) {
  let worst = null;
  for (const chick of chicks) {
    if (!chick.mine) continue;
    for (const need of chick.needs) {
      if (!worst || need.value < worst.value) worst = { chick: chick.name, label: need.label, value: need.value };
    }
  }
  return worst;
}
function result() {
  painted = "";
  const held = !world.failed;
  const fail = world.failed;
  const chick = fail && world.chicks.find((item) => item.id === fail.chick);
  const need = chick && chick.needs.find((item) => item.id === fail.need);
  const lines = world.chicks.flatMap((item) => item.needs.map((needItem) => `<div><span>${item.name} · ${needItem.label}</span><strong>${needItem.value}%</strong></div>`));
  const owners = chick ? (chick.owners || []).map((owner) => owner.name).join(" and ") : "";
  const why = !chick ? "A bar hit zero." : chick.shared
    ? `${chick.name} lost ${need ? need.label.toLowerCase() : "a need"}. Either phone could have saved it.`
    : `${chick.name} lost ${need ? need.label.toLowerCase() : "a need"}. Only ${owners || "one phone"} could tap it.`;
  shell(`
    <section class="sheet result">
      <h2>${held ? "The nest held." : "The nest broke."}</h2>
      <p class="lede">${held ? `Every chick lasted ${Math.round((world.survived || 0) / 1000)} seconds.` : why}</p>
      <div class="grid">${lines.join("")}</div>
      <p class="error" id="error">${error}</p>
      ${world.players.find((player) => player.id === world.you && player.host) ? `<button class="primary" id="start">Play again</button>` : `<p class="quiet">Waiting for the host.</p>`}
      <button class="ghost" id="leave">Leave</button>
    </section>
  `);
}
function draw() {
  if (!world) return home();
  if (world.status === "lobby") return lobby();
  if (world.status === "shift") return shift();
  if (world.status === "result") return result();
  home();
}
function tickClock() {
  const node = document.querySelector("#clock");
  if (!node || !world || world.status !== "shift" || !world.endsAt) {
    if (node) node.textContent = "";
    return;
  }
  node.textContent = clock(world.endsAt - Date.now());
}
setInterval(tickClock, 200);

app.addEventListener("click", async (event) => {
  const care = event.target.closest(".care");
  if (care && !care.disabled) {
    const ack = await emit("care", { chick: care.dataset.chick, need: care.dataset.need });
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
  const form = event.target.closest("#join");
  if (!form) return;
  event.preventDefault();
  name = document.querySelector("#name").value.trim();
  localStorage.setItem("nest.name", name);
  const act = event.submitter && event.submitter.dataset.act;
  const ack = act === "join"
    ? await emit("joinRoom", { name, code: document.querySelector("#code").value, playerId: session() && session().playerId })
    : await emit("createRoom", { name });
  error = ack && ack.ok ? "" : (ack && ack.error) || "Could not open the nest.";
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

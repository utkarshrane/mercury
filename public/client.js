"use strict";

const app = document.getElementById("app");
const params = new URLSearchParams(location.search);
const invited = (params.get("room") || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4);

let state = null;
let shown = null;
let rulesOpen = false;
let draftKey = "";
let draft = { qty: 1, face: 2 };
let dealtRound = 0;
let dealOnce = false;
let leftOnPurpose = false;
let muted = localStorage.getItem("callit-sound") !== "on";
let draftName = localStorage.getItem("callit-name") || "";
let draftCode = invited;
let audioCtx = null;
let toastTimer = null;

const socket = io({ autoConnect: true });

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[ch]));
}

function safeColor(color) {
  return /^#[0-9a-fA-F]{6}$/.test(color || "") ? color : "#d4a574";
}

function loadSession() {
  try {
    return JSON.parse(sessionStorage.getItem("callit") || "null");
  } catch {
    return null;
  }
}

function saveSession(session) {
  sessionStorage.setItem("callit", JSON.stringify(session));
  if (session.name) localStorage.setItem("callit-name", session.name);
}

function clearSession() {
  sessionStorage.removeItem("callit");
}

function toast(message) {
  const node = document.getElementById("toast");
  node.textContent = message;
  node.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove("show"), 3200);
}

function tone(freq, duration, type, gain) {
  if (muted) return;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return;
  if (!audioCtx) audioCtx = new Ctx();
  if (audioCtx.state === "suspended") audioCtx.resume();
  const osc = audioCtx.createOscillator();
  const amp = audioCtx.createGain();
  osc.type = type || "sine";
  osc.frequency.value = freq;
  amp.gain.value = gain || 0.03;
  osc.connect(amp);
  amp.connect(audioCtx.destination);
  osc.start();
  amp.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + duration);
  osc.stop(audioCtx.currentTime + duration);
}

function dieHtml(face, extra) {
  return `<span class="die ${extra || ""}" data-face="${face}" aria-hidden="true">${"<i></i>".repeat(9)}</span>`;
}

function cupsHtml(count) {
  if (!count) return `<span class="tag">out</span>`;
  const cups = Array.from({ length: Math.min(count, 5) }, () => `<i class="cup"></i>`).join("");
  return `<span class="cups" aria-label="${count} hidden dice">${cups}</span>`;
}

function rulesCopy() {
  return `
    <ol class="steps">
      <li><strong>Hide five dice.</strong> You see only yours. Everyone else is a cup.</li>
      <li><strong>Bid or call.</strong> On your turn, claim how many of one face are hidden around the whole table, higher than the last bid. Or call the last bid a lie.</li>
      <li><strong>Pay a die.</strong> If the bid was too high, the bidder loses a die. If it was true, the caller loses a die.</li>
      <li><strong>Last dice win.</strong> Drop to zero and you are out. The last player still holding dice takes the table.</li>
    </ol>
    <h3>What counts as higher</h3>
    <p>More dice of any face, or the same number of a higher face. Twos are lowest, then threes, fours, fives, sixes.</p>
    <p>Ones are wild. They count toward whatever face was bid. A bid of ones is different: only real ones count, and you need at least half the previous bid, rounded up.</p>
    <p>After a bid of ones, the next face bid has to be at least double that number, plus one.</p>
    <p class="example">The bid is 3 fives. You may bid 3 sixes, 4 of any face, or 2 ones.</p>
    <p class="example">The bid is 2 ones. You may bid 3 ones, or 5 of any other face.</p>
    <h3>Last die</h3>
    <p>When any player starts a round on one die, it is Palifico. Ones are not wild. Whoever opens chooses the face, and everyone else may only raise the quantity.</p>
    <h3>The clock</h3>
    <p>You have 50 seconds. If it runs out on the opening bid, you bid one two. If it runs out after a bid exists, you call. The player who lost a die opens the next round.</p>`;
}

function shortRules() {
  return `
    <ol class="steps compact">
      <li>Bid how many of one face are hidden on the whole table, or call the last bid a lie.</li>
      <li>A false bid costs the bidder a die. A true bid costs the caller a die.</li>
      <li>Ones are wild. The last player with dice wins.</li>
    </ol>`;
}

function homeHtml() {
  return `
    <main class="wrap">
      <p class="eyebrow">${invited ? `Table ${esc(invited)}` : "A table for two to six"}</p>
      <h1>Call <em>it</em></h1>
      <p class="lede">Bluff the dice you cannot see. Share a code, play from any phone or laptop. No accounts.</p>
      <div class="poster-dice" aria-hidden="true">${[5, 1, 6, 1, 3].map((face) => dieHtml(face)).join("")}</div>
      <label for="name">Your name</label>
      <div class="field"><input id="name" maxlength="16" autocomplete="nickname" placeholder="Name" value="${esc(draftName)}"></div>
      <div class="home-actions">
        <button type="button" class="primary" data-act="create">Create a table</button>
        <div class="join-row">
          <input id="code" maxlength="4" autocapitalize="characters" autocomplete="off" placeholder="CODE" value="${esc(draftCode)}" aria-label="Room code">
          <button type="button" class="ghost" data-act="join">Join</button>
        </div>
      </div>
      <h3>Rules</h3>
      ${rulesCopy()}
    </main>`;
}

function me() {
  return state.players.find((player) => player.id === state.you);
}

function canDealNow() {
  const host = state.players.find((player) => player.id === state.hostId);
  return state.you === state.hostId || !host || !host.connected;
}

function inviteLinks() {
  const local = /^(localhost|127\.0\.0\.1)$/i.test(location.hostname);
  const origins = !local
    ? [location.origin]
    : (state.lanOrigins && state.lanOrigins.length ? state.lanOrigins : [location.origin]);
  return origins.map((origin) => `${origin}/?room=${state.code}`);
}

function topbar() {
  const round = state.status === "lobby" ? "" : `<span class="pill">Round ${state.round}</span>`;
  const palifico = state.palifico && state.status === "playing" ? `<span class="pill">Palifico</span>` : "";
  return `
    <header class="topbar">
      <div class="brand">Call <em>it</em></div>
      <button type="button" class="pill" data-act="copy-code">${esc(state.code)}</button>
      ${round}
      ${palifico}
      <button type="button" data-act="rules">Rules</button>
      <button type="button" data-act="mute">${muted ? "Sound off" : "Sound on"}</button>
      <button type="button" data-act="leave">Leave</button>
    </header>`;
}

function lobbyHtml() {
  const here = state.players.filter((player) => player.connected).length;
  const deal = canDealNow();
  const links = inviteLinks();
  const start = deal
    ? `<button type="button" class="primary" data-act="start" ${here < 2 ? "disabled" : ""}>Deal five dice</button>
       ${here < 2 ? `<p class="wait">Need at least two players.</p>` : `<p class="wait">${here} here. Deal when everyone has read the rules.</p>`}`
    : `<p class="wait">Waiting for the host to deal.</p>`;
  return `
    <section class="felt">
      <p class="eyebrow">Table</p>
      <button type="button" class="ticket" data-act="copy-code">${esc(state.code)}</button>
      <p class="hint">Tap the code to copy it. No accounts, no install.</p>
      ${links.map((link) => `<p class="share">${esc(link)}</p>`).join("")}
      <button type="button" class="ghost" data-act="copy-link">Copy invite link</button>
      <ul class="roster">
        ${state.players.map((player) => {
          const marks = [
            player.id === state.you ? "you" : "",
            player.id === state.hostId ? "host" : "",
            player.connected ? "" : "away",
          ].filter(Boolean).join(" · ");
          return `<li><span class="dot" style="background:${safeColor(player.color)}"></span><span>${esc(player.name)}${marks ? ` · ${esc(marks)}` : ""}</span></li>`;
        }).join("")}
      </ul>
      ${shortRules()}
      <p><button type="button" class="ghost" data-act="rules">Full rules</button></p>
      ${start}
    </section>`;
}

function matchClass(face) {
  if ((state.status !== "reveal" && state.status !== "gameover") || !state.reveal) return "";
  return CallRules.dieMatches(face, state.reveal.bid.face, !state.palifico) ? "match" : "dim";
}

function seatHtml(player) {
  const active = state.turnPlayerId === player.id && state.status === "playing";
  const exposed = state.status === "reveal" || state.status === "gameover";
  let dice = "";
  if (exposed && player.dice && player.dice.length) {
    dice = player.dice.map((face) => dieHtml(face, matchClass(face))).join("");
  } else if (player.alive) {
    dice = cupsHtml(player.diceCount);
  }
  let tag = player.alive ? String(player.diceCount) : (player.waiting ? "next" : "out");
  if (!player.connected && player.alive) tag = "away";
  return `
    <article class="seat ${active ? "active" : ""} ${player.alive ? "" : "dead"}">
      <header>
        <span class="dot" style="background:${safeColor(player.color)}"></span>
        <strong>${esc(player.name)}</strong>
        <em>${esc(tag)}</em>
      </header>
      <div class="seat-dice">${dice}</div>
    </article>`;
}

function clockHtml() {
  if (!state.turnDeadline || !state.turnBudget) return "";
  const label = state.status === "reveal" ? "Next round" : "Clock";
  return `<div class="timer-bar"><span id="timer-fill"></span></div><p class="clock-line"><span>${label}</span> <strong id="clock"></strong></p>`;
}

function slipHtml() {
  if (state.status === "gameover") {
    const winner = state.players.find((player) => player.id === state.winnerId);
    const youWon = state.winnerId === state.you;
    const last = state.reveal
      ? `<p>${esc(CallRules.bidPhrase(state.reveal.bid.qty, state.reveal.bid.face))} · ${state.reveal.count} on the table.</p>`
      : "";
    return `
      <div class="slip win">
        <p class="eyebrow">${youWon ? "The table is yours" : "Showdown"}</p>
        <h2>${youWon ? "You take it" : `${esc(winner ? winner.name : "Nobody")} takes it`}</h2>
        ${last}
      </div>`;
  }
  if (state.status === "reveal" && state.reveal) {
    const loser = state.players.find((player) => player.id === state.reveal.loserId);
    const name = loser ? loser.name : "Someone";
    const line = state.reveal.eliminatedId ? `${name} is out.` : `${name} loses a die.`;
    return `
      <div class="slip ${state.reveal.holds ? "stood" : "bluff"}">
        <p class="eyebrow">${state.reveal.holds ? "The bid stands" : "The bid was a bluff"}</p>
        <h2>${esc(CallRules.bidPhrase(state.reveal.bid.qty, state.reveal.bid.face))}</h2>
        <p>${state.reveal.count} on the table. ${esc(line)}</p>
        ${clockHtml()}
      </div>`;
  }
  if (!state.bid) {
    return `
      <div class="slip">
        <p class="eyebrow">Round ${state.round}</p>
        <h2>Table is open</h2>
        <p>${state.palifico ? "Palifico. The opening face locks in for the round." : "The first bid can be any face."}</p>
        ${clockHtml()}
      </div>`;
  }
  return `
    <div class="slip">
      <p class="eyebrow">${esc(state.bid.name)} bids</p>
      <h2>${esc(CallRules.bidPhrase(state.bid.qty, state.bid.face))}</h2>
      ${clockHtml()}
    </div>`;
}

function facePossible(face) {
  const max = state.totalDice || 1;
  for (let qty = 1; qty <= max; qty += 1) {
    if (CallRules.isLegalBid(state.bid, { qty, face }, { palifico: state.palifico, maxQty: max }).ok) return true;
  }
  return false;
}

function dockHtml() {
  const player = me();
  if (state.status === "gameover") {
    if (canDealNow()) return `<div class="dock"><button type="button" class="primary" data-act="rematch">Deal again</button></div>`;
    return `<div class="dock"><p class="wait">Waiting for the host to deal again.</p></div>`;
  }
  if (state.status === "reveal" && state.reveal) {
    const out = state.reveal.eliminatedId === state.you;
    const lost = state.reveal.loserId === state.you;
    const note = out ? "You're out." : lost ? "You lose a die." : "Dice up.";
    return `<div class="dock"><p class="wait">${note}</p><button type="button" class="primary" data-act="continue">Continue</button></div>`;
  }
  if (!player || !player.alive) {
    const note = player && player.waiting ? "You'll join the next game." : "You're out. Watch the table.";
    return `<div class="dock"><p class="wait">${note}</p></div>`;
  }
  if (state.turnPlayerId !== state.you) {
    const turn = state.players.find((p) => p.id === state.turnPlayerId);
    return `<div class="dock"><p class="wait">${esc(turn ? turn.name : "Someone")} is on the clock.</p></div>`;
  }
  const max = state.totalDice || 1;
  const verdict = CallRules.isLegalBid(state.bid, draft, { palifico: state.palifico, maxQty: max });
  const faces = [1, 2, 3, 4, 5, 6].map((face) => `
    <button type="button" class="face-btn ${draft.face === face ? "on" : ""}" data-act="face" data-face="${face}" aria-label="${esc(CallRules.faceName(face))}" ${facePossible(face) ? "" : "disabled"}>
      ${dieHtml(face, "mini")}
    </button>`).join("");
  return `
    <div class="dock">
      <div class="faces">${faces}</div>
      <div class="qty">
        <button type="button" data-act="qty" data-dir="-1" aria-label="Fewer">−</button>
        <strong>${draft.qty}</strong>
        <button type="button" data-act="qty" data-dir="1" aria-label="More">+</button>
      </div>
      <p class="hint">${esc(verdict.ok ? `Bid ${CallRules.bidPhrase(draft.qty, draft.face)}` : verdict.reason)}</p>
      <button type="button" class="primary" data-act="raise" ${verdict.ok ? "" : "disabled"}>${verdict.ok ? `Bid ${esc(CallRules.bidPhrase(draft.qty, draft.face))}` : "Bid"}</button>
      <button type="button" class="ghost" data-act="call" ${state.bid ? "" : "disabled"}>${state.bid ? "Call it a lie" : "Bid first"}</button>
    </div>`;
}

function youHtml() {
  const player = me();
  if (!player) return "";
  const active = state.turnPlayerId === player.id && state.status === "playing";
  const dice = player.dice && player.dice.length
    ? player.dice.map((face) => dieHtml(face, matchClass(face))).join("")
    : `<p class="wait">No dice</p>`;
  let note = "Only you can see these. Ones are wild.";
  if (state.palifico) note = "Palifico. Ones are not wild, and the face stays locked.";
  return `
    <section class="you ${active ? "active" : ""}">
      <header>
        <span class="dot" style="background:${safeColor(player.color)}"></span>
        <h3>Your dice</h3>
      </header>
      <div class="your-dice ${dealOnce ? "deal" : ""}">${dice}</div>
      ${state.status === "playing" ? `<p class="hint">${note}</p>` : ""}
    </section>`;
}

function logHtml() {
  const lines = (state.log || []).slice(-6);
  return `<ol class="log" aria-live="polite">${lines.map((line) => `<li>${esc(line)}</li>`).join("")}</ol>`;
}

function rulesOverlay() {
  if (!rulesOpen) return "";
  return `
    <div class="sheet-back" data-act="close-rules">
      <article class="sheet" data-act="noop" role="dialog" aria-labelledby="rules-title">
        <p class="eyebrow">Read this once</p>
        <h2 id="rules-title">How to play</h2>
        ${rulesCopy()}
        <button type="button" class="primary" data-act="close-rules">Back to the table</button>
      </article>
    </div>`;
}

function syncDraft() {
  if (!state || state.status !== "playing") return;
  const key = [
    state.round,
    state.turnPlayerId,
    state.bid && state.bid.qty,
    state.bid && state.bid.face,
    state.bid && state.bid.playerId,
  ].join("|");
  if (key === draftKey) return;
  draftKey = key;
  const maxQty = state.totalDice || 1;
  const suggested = CallRules.nextSuggested(state.bid, { palifico: state.palifico, maxQty });
  draft = suggested || {
    qty: state.bid ? state.bid.qty : 1,
    face: state.bid ? state.bid.face : 2,
  };
}

function tableHtml() {
  const others = state.players.filter((player) => player.id !== state.you);
  return `
    <section class="felt">
      <div class="seats">${others.map(seatHtml).join("")}</div>
      ${slipHtml()}
      ${youHtml()}
      ${dockHtml()}
      ${logHtml()}
    </section>`;
}

function paintClock() {
  const clock = document.getElementById("clock");
  const fill = document.getElementById("timer-fill");
  if (!state || !state.turnDeadline || !state.turnBudget) return;
  const left = Math.max(0, state.turnDeadline - Date.now());
  const seconds = Math.ceil(left / 1000);
  if (clock) {
    clock.textContent = String(seconds);
    clock.classList.toggle("urgent", seconds <= 10 && state.status === "playing");
  }
  if (fill) fill.style.width = `${Math.max(0, Math.min(1, left / state.turnBudget)) * 100}%`;
}

function render() {
  const mode = state ? "room" : "home";
  if (mode === "home") {
    if (shown !== "home") {
      shown = "home";
      app.innerHTML = homeHtml();
    }
    document.title = "CALL IT";
    return;
  }
  if (state.status === "playing" && state.round !== dealtRound) {
    dealtRound = state.round;
    dealOnce = true;
  } else {
    dealOnce = false;
  }
  syncDraft();
  shown = "room";
  app.innerHTML = `<main class="wrap">${topbar()}${state.status === "lobby" ? lobbyHtml() : tableHtml()}${rulesOverlay()}</main>`;
  document.title = `CALL IT · ${state.code}`;
  paintClock();
}

function showHome() {
  state = null;
  shown = null;
  rulesOpen = false;
  render();
}

function ackOrToast(res) {
  if (!res || res.ok) return;
  toast(res.error || "Something went wrong.");
}

function readHomeFields() {
  const nameInput = document.getElementById("name");
  const codeInput = document.getElementById("code");
  if (nameInput) draftName = nameInput.value;
  if (codeInput) draftCode = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4);
}

function createRoom() {
  readHomeFields();
  const name = draftName.trim();
  if (!name) return toast("Enter your name.");
  leftOnPurpose = false;
  socket.emit("createRoom", { name }, (res) => {
    if (!res || !res.ok) return ackOrToast(res);
    saveSession({ playerId: res.playerId, code: res.code, name: res.name });
  });
}

function joinRoom() {
  readHomeFields();
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
      showHome();
      if (res && res.error) toast(res.error);
    }
  });
}

function leave() {
  leftOnPurpose = true;
  socket.emit("leave");
  clearSession();
  history.replaceState(null, "", "/");
  showHome();
}

function copyText(text, message) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => toast(message)).catch(() => toast(text));
  } else {
    toast(text);
  }
}

function onState(next) {
  if (leftOnPurpose) return;
  const prev = state;
  const player = next.players.find((p) => p.id === next.you);
  if (player) saveSession({ playerId: next.you, code: next.code, name: player.name });
  if (!leftOnPurpose) history.replaceState(null, "", `/?room=${next.code}`);
  if (prev && prev.code === next.code) {
    const prevBid = prev.bid ? `${prev.bid.qty}-${prev.bid.face}-${prev.bid.playerId}` : "";
    const nextBid = next.bid ? `${next.bid.qty}-${next.bid.face}-${next.bid.playerId}` : "";
    if (prev.status === "playing" && next.status === "reveal") tone(150, 0.22, "triangle", 0.05);
    else if (nextBid && nextBid !== prevBid) tone(540, 0.08, "sine", 0.035);
    if (next.status === "gameover" && prev.status !== "gameover") {
      tone(523, 0.12, "sine", 0.04);
      setTimeout(() => tone(659, 0.14, "sine", 0.04), 130);
      setTimeout(() => tone(784, 0.2, "sine", 0.04), 260);
    }
  }
  state = next;
  render();
}

document.body.addEventListener("input", (event) => {
  if (event.target.id === "name") draftName = event.target.value;
  if (event.target.id === "code") {
    draftCode = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4);
    event.target.value = draftCode;
  }
});

document.body.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && rulesOpen) {
    rulesOpen = false;
    render();
    return;
  }
  if (event.key !== "Enter" || state) return;
  if (event.target.id === "code") {
    event.preventDefault();
    joinRoom();
  } else if (event.target.id === "name") {
    event.preventDefault();
    if (draftCode.trim()) joinRoom();
    else createRoom();
  }
});

document.body.addEventListener("click", (event) => {
  const button = event.target.closest("[data-act]");
  if (!button || button.disabled) return;
  const act = button.dataset.act;
  if (act === "noop") return;
  if (act === "create") return createRoom();
  if (act === "join") return joinRoom();
  if (act === "rules") {
    rulesOpen = true;
    render();
    return;
  }
  if (act === "close-rules") {
    rulesOpen = false;
    render();
    return;
  }
  if (act === "mute") {
    muted = !muted;
    localStorage.setItem("callit-sound", muted ? "off" : "on");
    if (!muted) tone(620, 0.08, "sine", 0.04);
    render();
    return;
  }
  if (act === "leave") {
    const live = state && (state.status === "playing" || state.status === "reveal");
    if (live && !window.confirm("Leave the table? You forfeit your dice.")) return;
    leave();
    return;
  }
  if (!state) return;
  if (act === "copy-code") return copyText(state.code, "Code copied");
  if (act === "copy-link") return copyText(inviteLinks()[0], "Link copied");
  if (act === "start") return socket.emit("startGame", {}, ackOrToast);
  if (act === "rematch") return socket.emit("rematch", {}, ackOrToast);
  if (act === "continue") return socket.emit("continue", {}, ackOrToast);
  if (act === "face") {
    draft = { qty: draft.qty, face: Number(button.dataset.face) };
    render();
    return;
  }
  if (act === "qty") {
    const max = state.totalDice || 1;
    const qty = Math.min(max, Math.max(1, draft.qty + Number(button.dataset.dir)));
    draft = { qty, face: draft.face };
    render();
    return;
  }
  if (act === "raise") return socket.emit("raise", draft, ackOrToast);
  if (act === "call") return socket.emit("call", {}, ackOrToast);
});

socket.on("state", onState);
socket.on("connect", () => {
  document.getElementById("net").hidden = true;
  tryRejoin();
});
socket.on("disconnect", () => {
  if (!leftOnPurpose) document.getElementById("net").hidden = false;
});

setInterval(paintClock, 200);
render();

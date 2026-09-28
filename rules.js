"use strict";

/**
 * Shared rules for CALL IT, a Perudo-style bluff dice game.
 * Loaded by Node and by the browser (as /rules.js).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.CallRules = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const SINGULAR = [null, "one", "two", "three", "four", "five", "six"];
  const PLURAL = [null, "ones", "twos", "threes", "fours", "fives", "sixes"];

  let rollFn = function defaultRoll() {
    return 1 + Math.floor(Math.random() * 6);
  };

  function setRoll(fn) {
    rollFn = typeof fn === "function" ? fn : function defaultRoll() {
      return 1 + Math.floor(Math.random() * 6);
    };
  }

  function rollDie() {
    const face = rollFn();
    return face;
  }

  function rollDice(count) {
    const dice = [];
    for (let i = 0; i < count; i += 1) dice.push(rollDie());
    dice.sort((a, b) => a - b);
    return dice;
  }

  function bidPhrase(qty, face) {
    const word = qty === 1 ? SINGULAR[face] : PLURAL[face];
    return `${qty} ${word}`;
  }

  function faceName(face) {
    return PLURAL[face] || "";
  }

  /**
   * @param {number[]} dice
   * @param {number} face
   * @param {boolean} onesWild  when true, ones count toward any face except a bid of ones
   */
  function countFace(dice, face, onesWild) {
    let count = 0;
    for (const die of dice) {
      if (die === face) count += 1;
      else if (onesWild && face !== 1 && die === 1) count += 1;
    }
    return count;
  }

  function dieMatches(face, bidFace, onesWild) {
    if (face === bidFace) return true;
    return Boolean(onesWild && bidFace !== 1 && face === 1);
  }

  /**
   * A raise is legal when it is strictly stronger than the previous bid.
   * Faces rank 2 < 3 < 4 < 5 < 6. Ones are a separate bid:
   * switching to ones needs at least half the previous quantity (rounded up);
   * switching off ones needs at least double plus one.
   * During Palifico the face is locked and only the quantity may rise.
   */
  function isLegalBid(prev, next, opts) {
    const maxQty = opts && Number.isInteger(opts.maxQty) ? opts.maxQty : 30;
    const palifico = Boolean(opts && opts.palifico);

    if (!next || !Number.isInteger(next.qty) || !Number.isInteger(next.face)) {
      return { ok: false, reason: "That bid is not a real bid." };
    }
    if (next.face < 1 || next.face > 6) {
      return { ok: false, reason: "Faces run from ones to sixes." };
    }
    if (next.qty < 1) return { ok: false, reason: "Bid at least one die." };
    if (next.qty > maxQty) {
      return { ok: false, reason: `There are only ${maxQty} dice on the table.` };
    }
    if (!prev) return { ok: true, reason: "" };

    if (palifico) {
      if (next.face !== prev.face) {
        return { ok: false, reason: "Palifico: the face stays locked." };
      }
      if (next.qty <= prev.qty) return { ok: false, reason: "Raise the quantity." };
      return { ok: true, reason: "" };
    }

    if (prev.face !== 1 && next.face !== 1) {
      if (next.qty > prev.qty) return { ok: true, reason: "" };
      if (next.qty === prev.qty && next.face > prev.face) return { ok: true, reason: "" };
      return { ok: false, reason: "Raise the quantity, or the face at the same quantity." };
    }

    if (prev.face !== 1 && next.face === 1) {
      const need = Math.ceil(prev.qty / 2);
      if (next.qty < need) return { ok: false, reason: `A ones bid needs at least ${need}.` };
      return { ok: true, reason: "" };
    }

    if (prev.face === 1 && next.face === 1) {
      if (next.qty <= prev.qty) return { ok: false, reason: "Raise the number of ones." };
      return { ok: true, reason: "" };
    }

    const need = prev.qty * 2 + 1;
    if (next.qty < need) {
      return { ok: false, reason: `After ones, bid at least ${need} of a face.` };
    }
    return { ok: true, reason: "" };
  }

  function nextSuggested(prev, opts) {
    const maxQty = opts && Number.isInteger(opts.maxQty) ? opts.maxQty : 30;
    const palifico = Boolean(opts && opts.palifico);
    if (!prev) return { qty: 1, face: 2 };
    const found = [];
    for (let qty = 1; qty <= maxQty; qty += 1) {
      for (let face = 1; face <= 6; face += 1) {
        if (isLegalBid(prev, { qty, face }, { palifico, maxQty }).ok) {
          found.push({ qty, face });
        }
      }
    }
    if (!found.length) return null;
    found.sort((a, b) => {
      const aAce = a.face === 1 ? 1 : 0;
      const bAce = b.face === 1 ? 1 : 0;
      if (aAce !== bAce) return aAce - bAce;
      if (a.qty !== b.qty) return a.qty - b.qty;
      return a.face - b.face;
    });
    return found[0];
  }

  return {
    setRoll,
    rollDice,
    bidPhrase,
    faceName,
    countFace,
    dieMatches,
    isLegalBid,
    nextSuggested,
  };
});

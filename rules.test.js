"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const rules = require("./rules");

const opts = { palifico: false, maxQty: 10 };

test("ones are wild for every face except a bid of ones", () => {
  const dice = [1, 1, 5, 2, 6];
  assert.equal(rules.countFace(dice, 5, true), 3);
  assert.equal(rules.countFace(dice, 1, true), 2);
  assert.equal(rules.countFace(dice, 5, false), 1);
});

test("matching dice include wild ones only when the bid is not ones", () => {
  assert.equal(rules.dieMatches(1, 5, true), true);
  assert.equal(rules.dieMatches(1, 1, true), true);
  assert.equal(rules.dieMatches(1, 5, false), false);
  assert.equal(rules.dieMatches(4, 5, true), false);
});

test("an opening bid is any face and any positive quantity up to the table", () => {
  assert.equal(rules.isLegalBid(null, { qty: 1, face: 1 }, opts).ok, true);
  assert.equal(rules.isLegalBid(null, { qty: 11, face: 2 }, opts).ok, false);
  assert.equal(rules.isLegalBid(null, { qty: 0, face: 3 }, opts).ok, false);
});

test("a normal raise is more dice, or the same number of a higher face", () => {
  const prev = { qty: 4, face: 5 };
  assert.equal(rules.isLegalBid(prev, { qty: 4, face: 6 }, opts).ok, true);
  assert.equal(rules.isLegalBid(prev, { qty: 5, face: 2 }, opts).ok, true);
  assert.equal(rules.isLegalBid(prev, { qty: 4, face: 5 }, opts).ok, false);
  assert.equal(rules.isLegalBid(prev, { qty: 4, face: 3 }, opts).ok, false);
  assert.equal(rules.isLegalBid(prev, { qty: 3, face: 6 }, opts).ok, false);
});

test("switching to and from ones follows the half and double-plus-one rules", () => {
  const fives = { qty: 3, face: 5 };
  assert.equal(rules.isLegalBid(fives, { qty: 2, face: 1 }, opts).ok, true);
  assert.equal(rules.isLegalBid(fives, { qty: 1, face: 1 }, opts).ok, false);

  const ones = { qty: 2, face: 1 };
  assert.equal(rules.isLegalBid(ones, { qty: 3, face: 1 }, opts).ok, true);
  assert.equal(rules.isLegalBid(ones, { qty: 5, face: 6 }, opts).ok, true);
  assert.equal(rules.isLegalBid(ones, { qty: 4, face: 6 }, opts).ok, false);
});

test("palifico locks the face", () => {
  const prev = { qty: 2, face: 3 };
  const palifico = { palifico: true, maxQty: 8 };
  assert.equal(rules.isLegalBid(prev, { qty: 3, face: 3 }, palifico).ok, true);
  assert.equal(rules.isLegalBid(prev, { qty: 3, face: 4 }, palifico).ok, false);
  assert.equal(rules.isLegalBid(prev, { qty: 2, face: 3 }, palifico).ok, false);
});

test("the suggested raise is the smallest natural step", () => {
  assert.deepEqual(rules.nextSuggested(null, opts), { qty: 1, face: 2 });
  assert.deepEqual(rules.nextSuggested({ qty: 4, face: 5 }, opts), { qty: 4, face: 6 });
  assert.deepEqual(rules.nextSuggested({ qty: 4, face: 6 }, opts), { qty: 5, face: 2 });
  assert.deepEqual(rules.nextSuggested({ qty: 2, face: 1 }, opts), { qty: 5, face: 2 });
  assert.deepEqual(
    rules.nextSuggested({ qty: 2, face: 3 }, { palifico: true, maxQty: 8 }),
    { qty: 3, face: 3 }
  );
  assert.equal(rules.nextSuggested({ qty: 10, face: 6 }, { palifico: true, maxQty: 10 }), null);
});

test("bid phrases use singular and plural face names", () => {
  assert.equal(rules.bidPhrase(1, 5), "1 five");
  assert.equal(rules.bidPhrase(4, 1), "4 ones");
});

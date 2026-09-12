import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "../src/domain/errors.js";
import { InMemoryCreditLedger } from "../src/wallet/credit-ledger.js";

function assertDomainError(fn: () => unknown, code: string, message?: RegExp): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof DomainError, "expected a DomainError");
    assert.equal(error.code, code);
    if (message) assert.match(error.message, message);
    return true;
  });
}

test("unknown users have a zero balance and no entries", () => {
  const ledger = new InMemoryCreditLedger();
  assert.equal(ledger.balance("nobody"), 0);
  assert.deepEqual(ledger.entries("nobody"), []);
  assert.deepEqual(ledger.allUserIds(), []);
});

test("credits and debits record signed entries with running balances", () => {
  const ledger = new InMemoryCreditLedger();
  const deposit = ledger.credit("alice", 100, { type: "deposit", method: "virtual", at: 1_000 });
  const buy = ledger.debit("alice", 2.5, {
    type: "buy",
    raceId: "race-1",
    racerId: "racer-1",
    side: "yes",
    quantity: 10,
    price: 0.25,
    at: 2_000,
  });

  assert.match(deposit.id, /^[0-9a-f-]{36}$/);
  assert.notEqual(deposit.id, buy.id);
  assert.deepEqual(
    { ...deposit, id: "x" },
    {
      id: "x",
      at: 1_000,
      userId: "alice",
      type: "deposit",
      amount: 100,
      balanceAfter: 100,
      method: "virtual",
    },
  );
  assert.deepEqual(
    { ...buy, id: "x" },
    {
      id: "x",
      at: 2_000,
      userId: "alice",
      type: "buy",
      amount: -2.5,
      balanceAfter: 97.5,
      raceId: "race-1",
      racerId: "racer-1",
      side: "yes",
      quantity: 10,
      price: 0.25,
    },
  );
  assert.equal(ledger.balance("alice"), 97.5);
  assert.deepEqual(ledger.entries("alice").map((entry) => entry.type), ["deposit", "buy"]);
});

test("debits beyond the balance fail without changing state", () => {
  const ledger = new InMemoryCreditLedger();
  ledger.credit("alice", 1, { type: "deposit" });
  assertDomainError(
    () => ledger.debit("alice", 1.000001, { type: "withdraw" }),
    "insufficient_balance",
    /insufficient virtual credits/,
  );
  assert.equal(ledger.balance("alice"), 1);
  assert.equal(ledger.entries("alice").length, 1);
  ledger.debit("alice", 1, { type: "withdraw" });
  assert.equal(ledger.balance("alice"), 0);
});

test("record appends a zero-amount entry", () => {
  const ledger = new InMemoryCreditLedger();
  ledger.credit("bob", 5, { type: "deposit" });
  const loss = ledger.record("bob", {
    type: "loss",
    raceId: "race-1",
    racerId: "racer-2",
    side: "no",
    quantity: 3,
    price: 0.6,
    at: 9_000,
  });
  assert.equal(loss.amount, 0);
  assert.equal(Object.is(loss.amount, -0), false);
  assert.equal(loss.balanceAfter, 5);
  assert.equal(loss.side, "no");
  assert.equal(ledger.balance("bob"), 5);
});

test("rounds amounts to six decimal places", () => {
  const ledger = new InMemoryCreditLedger();
  ledger.credit("alice", 0.1, { type: "deposit" });
  ledger.credit("alice", 0.2, { type: "deposit" });
  assert.equal(ledger.balance("alice"), 0.3);
  const entry = ledger.credit("alice", 0.1234567, { type: "deposit" });
  assert.equal(entry.amount, 0.123457);
  assert.equal(ledger.balance("alice"), 0.423457);
});

test("rejects non-finite and negative amounts", () => {
  const ledger = new InMemoryCreditLedger();
  for (const amount of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
    assertDomainError(() => ledger.credit("alice", amount, { type: "deposit" }), "invalid");
    assertDomainError(() => ledger.debit("alice", amount, { type: "withdraw" }), "invalid");
  }
  assertDomainError(() => ledger.credit("", 1, { type: "deposit" }), "invalid");
  assert.equal(ledger.balance("alice"), 0);
});

test("defaults the entry timestamp and lists every user", () => {
  const ledger = new InMemoryCreditLedger();
  const before = Date.now();
  const entry = ledger.credit("alice", 1, { type: "deposit" });
  assert.ok(entry.at >= before && entry.at <= Date.now());
  ledger.record("bob", { type: "loss" });
  assert.deepEqual(ledger.allUserIds(), ["alice", "bob"]);
});

test("returns copies of entries", () => {
  const ledger = new InMemoryCreditLedger();
  ledger.credit("alice", 1, { type: "deposit" });
  const [entry] = ledger.entries("alice");
  entry.amount = 999;
  assert.equal(ledger.entries("alice")[0].amount, 1);
});

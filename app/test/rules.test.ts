import assert from "node:assert/strict";
import { test } from "node:test";
import { fullyLocked, LAUNCH_WAIT_GRACE_MS, launchWaitDeadline } from "../src/lib/launchRules";
import { saveBlocker, type SaveGate } from "../src/lib/xAutomation";

const NOW = 1_762_000_000_000;
const LATER = NOW + 3 * 86_400_000;

test('"Verified locks only" needs the ticker, name and tweet locks all still held', () => {
  assert.equal(fullyLocked({ ticker: LATER, name: LATER, tweet: LATER }, NOW), true);
  // A coin launched without an announcement tweet has no tweet lock.
  assert.equal(fullyLocked({ ticker: LATER, name: LATER, tweet: null }, NOW), false);
  // Each lock on its own decides it; the old filter only looked at the tweet.
  assert.equal(fullyLocked({ ticker: NOW - 1, name: LATER, tweet: LATER }, NOW), false);
  assert.equal(fullyLocked({ ticker: LATER, name: NOW - 1, tweet: LATER }, NOW), false);
  assert.equal(fullyLocked({ ticker: LATER, name: LATER, tweet: NOW - 1 }, NOW), false);
  // A lock that ends exactly now has lapsed.
  assert.equal(fullyLocked({ ticker: NOW, name: LATER, tweet: LATER }, NOW), false);
});

test("the launch wait ends at the ticket's on-chain expiry plus a short grace", () => {
  const requestedAt = 1_762_000_000; // unix seconds
  const expiresAt = requestedAt + 600; // the program's default 10-minute ticket TTL
  assert.equal(launchWaitDeadline(expiresAt), expiresAt * 1000 + LAUNCH_WAIT_GRACE_MS);
  assert.equal(LAUNCH_WAIT_GRACE_MS, 30_000);
  // Well inside the old 11 minutes from the request.
  assert.ok(launchWaitDeadline(expiresAt) < requestedAt * 1000 + 11 * 60_000);
  assert.equal(launchWaitDeadline(expiresAt, 0), expiresAt * 1000);
});

test("X automation saves only for the on-chain creator, never the coin list's", () => {
  const base: SaveGate = { demo: false, ready: true, ticker: "BULL", signer: "Creator111", isCreator: true, canSignMessages: true };
  assert.equal(saveBlocker(base), null, "the on-chain creator can save");
  // The coin list may name someone else (it is demo data); only the on-chain answer counts.
  assert.match(saveBlocker({ ...base, isCreator: false }) ?? "", /Only the wallet that launched \$BULL/);
  assert.match(saveBlocker({ ...base, signer: null, isCreator: false }) ?? "", /Connect the wallet that launched \$BULL/);
  assert.match(saveBlocker({ ...base, canSignMessages: false }) ?? "", /can't sign messages/);
  assert.equal(saveBlocker({ ...base, ready: false, isCreator: false }), null, "nothing to say until the sentinel answers");
  assert.match(saveBlocker({ ...base, demo: true }) ?? "", /demo coin/);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Coin } from "../src/lib/types";
import { activeScreenerFilters, FEED_PAGE, nextFeedCount, NO_SCREENER_FILTERS, passesScreener } from "../src/lib/screener";

const NOW = 1_762_000_000_000;
const LATER = NOW + 86_400_000;
const coin = (over: Partial<Coin>): Coin =>
  ({ mcapUsd: 50_000, socials: {}, locks: { ticker: LATER, name: LATER, tweet: LATER }, ...over }) as Coin;

test("screener filters: locks, socials and minimum market cap each narrow the list", () => {
  assert.equal(activeScreenerFilters(NO_SCREENER_FILTERS), 0);
  assert.equal(passesScreener(coin({ locks: { ticker: LATER, name: LATER, tweet: null } }), NO_SCREENER_FILTERS, NOW), true);

  const locked = { ...NO_SCREENER_FILTERS, lockedOnly: true };
  assert.equal(passesScreener(coin({}), locked, NOW), true);
  assert.equal(passesScreener(coin({ locks: { ticker: LATER, name: LATER, tweet: null } }), locked, NOW), false);

  const socials = { ...NO_SCREENER_FILTERS, socialsOnly: true };
  assert.equal(passesScreener(coin({}), socials, NOW), false);
  assert.equal(passesScreener(coin({ socials: { x: "https://x.com/bull" } }), socials, NOW), true);
  assert.equal(passesScreener(coin({ socials: { website: "https://bull.xyz" } }), socials, NOW), true);

  const big = { ...NO_SCREENER_FILTERS, minMcapUsd: 100_000 };
  assert.equal(passesScreener(coin({ mcapUsd: 99_999 }), big, NOW), false);
  assert.equal(passesScreener(coin({ mcapUsd: 100_000 }), big, NOW), true);
  assert.equal(activeScreenerFilters({ lockedOnly: true, socialsOnly: true, minMcapUsd: 1 }), 3);
});

test('"Show more updates" grows the feed a page at a time and stops at the end', () => {
  assert.equal(nextFeedCount(FEED_PAGE, 16), FEED_PAGE * 2);
  assert.equal(nextFeedCount(12, 16), 16);
  assert.equal(nextFeedCount(16, 16), 16);
  assert.equal(nextFeedCount(0, 3), 3);
});

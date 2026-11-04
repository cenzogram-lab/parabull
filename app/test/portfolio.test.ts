import { test } from "node:test";
import assert from "node:assert/strict";
import { generateCoins } from "../src/mock/coins";
import { closedPositions, DEMO_CASH_SOL, equityHistory, positionNote, type PortfolioPeriod } from "../src/mock/portfolio";

const NOW = 1_800_000_000_000;
const PERIODS: PortfolioPeriod[] = ["1D", "1W", "1M", "ALL"];

test("equity history is deterministic and ends exactly at today's equity", () => {
  for (const [equity, change] of [
    [662.71, -0.078],
    [1190.93, 1.598],
    [48.2, 0.004],
  ]) {
    for (const p of PERIODS) {
      const a = equityHistory(equity, change, p, NOW);
      assert.deepEqual(a, equityHistory(equity, change, p, NOW), p);
      assert.equal(a[a.length - 1].v, equity, `${p} ends at equity`);
      assert.equal(a[a.length - 1].t, NOW, `${p} ends now`);
      assert.ok(a.length >= 48 && a.length <= 120, `${p} has ${a.length} points`);
      assert.ok(
        a.every((x, i) => Number.isFinite(x.v) && x.v > 0 && (i === 0 || x.t > a[i - 1].t)),
        `${p} is time-sorted and positive`,
      );
    }
    const day = equityHistory(equity, change, "1D", NOW);
    assert.equal(day[0].v, equity / (1 + change), "1D starts 24h back");
    assert.equal(NOW - day[0].t, 86_400_000);
  }
});

test("longer periods reach further back and agree with the 1D start", () => {
  const span = (p: PortfolioPeriod) => {
    const h = equityHistory(662.71, -0.078, p, NOW);
    return h[h.length - 1].t - h[0].t;
  };
  assert.ok(span("1D") < span("1W") && span("1W") < span("1M") && span("1M") < span("ALL"));
  const dayAgo = 662.71 / (1 - 0.078);
  for (const p of ["1W", "1M", "ALL"] as const) {
    const at = equityHistory(662.71, -0.078, p, NOW).find((x) => x.t === NOW - 86_400_000);
    assert.ok(at && Math.abs(at.v - dayAgo) < 1e-9, `${p} passes through the 1D start`);
  }
  assert.ok(DEMO_CASH_SOL > 0);
});

test("closed positions realize exit minus entry", () => {
  const coins = generateCoins(NOW);
  const closed = closedPositions(coins, NOW);
  assert.deepEqual(closed, closedPositions(generateCoins(NOW), NOW));
  assert.ok(closed.length >= 3 && closed.length <= 8, `${closed.length} closed`);
  const mints = new Map(coins.map((c) => [c.mint, c]));
  assert.equal(new Set(closed.map((c) => c.mint)).size, closed.length, "one closed position per coin");
  for (const c of closed) {
    assert.equal(c.pnlUsd, c.exitUsd - c.entryUsd);
    assert.ok(Math.abs(c.pnlPct - c.pnlUsd / c.entryUsd) < 1e-12);
    assert.ok(c.entryUsd > 0 && c.exitUsd > 0 && c.tokens > 0);
    const coin = mints.get(c.mint);
    assert.ok(coin, "references a demo coin");
    assert.ok(c.closedAt <= NOW && c.closedAt > coin.createdAt, "sold after launch");
  }
  assert.ok(closed.every((c, i) => i === 0 || c.closedAt <= closed[i - 1].closedAt), "newest first");
  assert.ok(closed.some((c) => c.pnlUsd > 0) && closed.some((c) => c.pnlUsd < 0), "wins and losses");
});

test("position notes are deterministic and some positions have none", () => {
  const mints = generateCoins(NOW).map((c) => c.mint);
  const notes = mints.map((m) => positionNote(m, NOW));
  assert.deepEqual(notes, mints.map((m) => positionNote(m, NOW)));
  assert.ok(notes.some((n) => n === null), "some are null");
  assert.ok(notes.some((n) => n !== null), "some have a thesis");
  for (const n of notes) {
    if (!n) continue;
    assert.ok(n.text.length > 10 && n.updatedAt < NOW && n.likes >= 0 && n.reposts >= 0 && n.views >= n.likes);
  }
});

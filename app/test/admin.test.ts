import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import { checkNominee, checkParams, curveKpis, formFromGlobal, lamportsToSolInput, owedToEpochs, pctInputToBps, solInputToLamports, spendable } from "../src/lib/admin";
import { bpsLabel, dexTargetUsd, DEFAULT_PARAMS, durationLabel, mayOpenConsole, paramsFromGlobal, rolesOf, splitLabel, usdToLamports, type GlobalView } from "../src/lib/protocolParams";
import { fetchSolUsd, saneSolUsd, type PriceSource } from "../src/lib/price";

const ADMIN = Keypair.generate().publicKey.toBase58();
const CRANK = Keypair.generate().publicKey.toBase58();
const OTHER = Keypair.generate().publicKey.toBase58();
const NONE = PublicKey.default.toBase58();

/** Global as deploy_and_init.ts sets it. */
const global = (over: Partial<GlobalView> = {}): GlobalView => ({
  paused: false,
  admin: ADMIN,
  pendingAdmin: NONE,
  launchAuthority: OTHER,
  crankAuthority: CRANK,
  treasury: OTHER,
  parabullMint: OTHER,
  parabullPool: NONE,
  launchFeeLamports: 200_000_000n,
  ticketDepositLamports: 230_000_000n,
  ticketTtlSeconds: 600,
  platformFeeBps: 100,
  buybackBps: 5_000,
  holderBps: 4_000,
  dexTargetLamports: 1_993_333_333n,
  dexTargetUpdatedAt: 1_762_000_000,
  tradingOpenDelaySlots: 2n,
  registryLockSeconds: 259_200,
  launchCount: 12n,
  migrationReserveLamports: 250_000_000n,
  rewardClaimWindowSeconds: 30 * 86_400,
  ...over,
});

test("labels: bps, split, durations", () => {
  assert.equal(bpsLabel(100), "1%");
  assert.equal(bpsLabel(5_000), "50%");
  assert.equal(bpsLabel(25), "0.25%");
  assert.equal(bpsLabel(3_333), "33.33%");
  assert.equal(splitLabel(DEFAULT_PARAMS), "50 / 40 / 10");
  assert.equal(splitLabel({ buybackBps: 6_000, holderBps: 2_500 }), "60 / 25 / 15");
  assert.equal(durationLabel(259_200), "3 days");
  assert.equal(durationLabel(86_400), "1 day");
  assert.equal(durationLabel(5_400), "1.5 hours");
  assert.equal(durationLabel(3_600), "1 hour");
  assert.equal(durationLabel(600), "10 minutes", "the ticket TTL");
  assert.equal(durationLabel(60), "1 minute");
});

test("protocol params: defaults in demo mode, Global in chain mode", () => {
  assert.equal(DEFAULT_PARAMS.platformFeeBps, 100);
  assert.equal(DEFAULT_PARAMS.ticketDepositLamports, 230_000_000n);
  assert.equal(dexTargetUsd(DEFAULT_PARAMS, 150), 299, "demo keeps the flat $299");
  const p = paramsFromGlobal(global({ platformFeeBps: 80, buybackBps: 6_000, dexTargetLamports: 2_000_000_000n, tradingOpenDelaySlots: 3n }));
  assert.equal(p.platformFeeBps, 80);
  assert.equal(p.buybackBps, 6_000);
  assert.equal(p.tradingOpenDelaySlots, 3);
  assert.equal(dexTargetUsd(p, 150), 300, "chain: the lamport target at today's price");
  assert.equal(usdToLamports(299, 150), 1_993_333_333n);
});

test("roles: admin, crank and nominated admin open the console; anyone else and no wallet don't", () => {
  const g = global({ pendingAdmin: OTHER });
  assert.deepEqual(rolesOf(g, ADMIN), { admin: true, pendingAdmin: false, crank: false });
  assert.deepEqual(rolesOf(g, CRANK), { admin: false, pendingAdmin: false, crank: true });
  assert.deepEqual(rolesOf(g, OTHER), { admin: false, pendingAdmin: true, crank: false });
  for (const w of [ADMIN, CRANK, OTHER]) assert.ok(mayOpenConsole(rolesOf(g, w)), w);
  const stranger = Keypair.generate().publicKey.toBase58();
  assert.ok(!mayOpenConsole(rolesOf(g, stranger)));
  assert.ok(!mayOpenConsole(rolesOf(g, null)));
  // With no nomination, the default key matches nobody, not even a wallet that is the default key.
  assert.ok(!rolesOf(global(), NONE).pendingAdmin);
  // One wallet can be admin and crank at once.
  assert.deepEqual(rolesOf(global({ crankAuthority: ADMIN }), ADMIN), { admin: true, pendingAdmin: false, crank: true });
});

test("curve KPIs: stages, SOL held and unswept fees by bucket", () => {
  const c = (over: Partial<Parameters<typeof curveKpis>[0][number]> = {}) => ({
    complete: false,
    migrated: false,
    escrowReleased: false,
    realSolReserves: 0n,
    escrowAccrued: 0n,
    buybackAccrued: 0n,
    holderAccrued: 0n,
    treasuryAccrued: 0n,
    ...over,
  });
  const k = curveKpis([
    c({ realSolReserves: 10n, escrowAccrued: 5n, buybackAccrued: 1n }),
    c({ complete: true, realSolReserves: 85n, escrowAccrued: 7n }),
    // Escrow released: what's left in escrow_accrued is not owed to a listing any more.
    c({ complete: true, migrated: true, escrowReleased: true, escrowAccrued: 0n, buybackAccrued: 3n, holderAccrued: 2n, treasuryAccrued: 1n }),
  ]);
  assert.equal(k.curves, 3);
  assert.equal(k.active, 1);
  assert.equal(k.graduating, 1);
  assert.equal(k.graduated, 1);
  assert.equal(k.solInCurves, 95n);
  assert.deepEqual(k.unswept, { escrow: 12n, buyback: 4n, holder: 2n, treasury: 1n, total: 19n });
  assert.equal(k.escrowsReleased, 1);
  assert.deepEqual(curveKpis([]).unswept.total, 0n);
});

test("vaults: spendable above rent, owed to epochs never negative", () => {
  assert.equal(spendable(5_000_000n, 1_000_000n), 4_000_000n);
  assert.equal(spendable(900n, 1_000n), 0n);
  const v = { totalDepositedLamports: 100n, totalCommittedLamports: 80n, totalClaimedLamports: 50n, totalExpiredLamports: 10n, nextEpoch: 3n };
  assert.equal(owedToEpochs(v), 20n);
  assert.equal(owedToEpochs({ ...v, totalClaimedLamports: 80n }), 0n);
});

test("SOL and percentage inputs parse exactly", () => {
  assert.equal(solInputToLamports("0.25"), 250_000_000n);
  assert.equal(solInputToLamports("1.999999999"), 1_999_999_999n);
  assert.equal(solInputToLamports("2"), 2_000_000_000n);
  assert.equal(solInputToLamports("2."), 2_000_000_000n);
  for (const bad of ["", "-1", "1.0000000001", "1e3", "abc", "1,5"]) assert.equal(solInputToLamports(bad), null, bad);
  for (const l of [0n, 1n, 250_000_000n, 1_993_333_333n, 12_000_000_000n]) assert.equal(solInputToLamports(lamportsToSolInput(l)), l);
  assert.equal(pctInputToBps("50"), 5_000);
  assert.equal(pctInputToBps("12.5"), 1_250);
  assert.equal(pctInputToBps("0.01"), 1);
  for (const bad of ["101", "12.345", "-1", "", "x"]) assert.equal(pctInputToBps(bad), null, bad);
});

test("params: an unchanged form changes nothing; edits produce only the changed GlobalUpdate fields", () => {
  const g = global();
  const same = checkParams(g, formFromGlobal(g));
  assert.ok(same.ok);
  assert.deepEqual(same.update, {});
  assert.equal(same.changes.length, 0);

  const r = checkParams(g, { ...formFromGlobal(g), buybackPct: "60", holderPct: "30", dexTargetSol: "2.5" });
  assert.ok(r.ok);
  assert.deepEqual(r.update, { buybackBps: 6_000, holderBps: 3_000, dexTargetLamports: 2_500_000_000n });
  assert.deepEqual(
    r.changes.map((c) => `${c.label}: ${c.from} -> ${c.to}`),
    ["Buyback share: 50% -> 60%", "Holder share: 40% -> 30%", "Treasury share (the rest): 10% -> 10%", "DexScreener listing target: 1.993333333 SOL -> 2.5 SOL"],
  );

  const w = checkParams(g, { ...formFromGlobal(g), claimWindowDays: "14", migrationReserveSol: "0.1" });
  assert.ok(w.ok);
  assert.deepEqual(w.update, { rewardClaimWindowSeconds: 1_209_600n, migrationReserveLamports: 100_000_000n });
  assert.equal(w.warnings.length, 2, "a reserve under the pool fee and a new claim window both warn");
  assert.match(w.warnings[0], /every graduation will fail/);

  // Above the 0.15 SOL pool fee but under the 0.25 SOL default, rent may not be covered: still warns.
  const thin = checkParams(g, { ...formFromGlobal(g), migrationReserveSol: "0.16" });
  assert.ok(thin.ok && thin.warnings.length === 1 && /rent/.test(thin.warnings[0]), "0.16 SOL warns about rent");
  const raised = checkParams(g, { ...formFromGlobal(g), migrationReserveSol: "0.3" });
  assert.ok(raised.ok && raised.warnings.length === 0, "at or above the default, no warning");
});

test("params: the program's rules (and the console's slot floor) are refused before signing", () => {
  const g = global();
  const bad = (over: Partial<ReturnType<typeof formFromGlobal>>) => {
    const r = checkParams(g, { ...formFromGlobal(g), ...over });
    assert.ok(!r.ok, JSON.stringify(over));
    return r.errors;
  };
  assert.ok(bad({ buybackPct: "70", holderPct: "40" }).split, "split over 100%");
  assert.ok(bad({ claimWindowDays: "6" }).claimWindowDays, "under the 7-day minimum");
  assert.ok(bad({ migrationReserveSol: "0" }).migrationReserveSol, "zero reserve");
  assert.ok(bad({ dexTargetSol: "0" }).dexTargetSol, "zero target");
  assert.ok(bad({ tradingOpenDelaySlots: "0" }).tradingOpenDelaySlots, "no trading in the creation slot");
  assert.ok(bad({ tradingOpenDelaySlots: "1.5" }).tradingOpenDelaySlots, "whole slots only");
  assert.ok(bad({ buybackPct: "abc" }).buybackPct);
});

test("admin nominee: valid, distinct, and off-curve addresses warn", () => {
  const g = global({ pendingAdmin: OTHER });
  const fresh = Keypair.generate().publicKey.toBase58();
  const ok = checkNominee(g, `  ${fresh} `);
  assert.ok(ok.ok && ok.key.toBase58() === fresh && ok.warning === null);
  assert.ok(!checkNominee(g, "").ok);
  assert.ok(!checkNominee(g, "not-an-address").ok);
  assert.ok(!checkNominee(g, NONE).ok, "the default key is how you cancel, not a nominee");
  assert.ok(!checkNominee(g, ADMIN).ok, "already the admin");
  assert.ok(!checkNominee(g, OTHER).ok, "already nominated");
  const pda = PublicKey.findProgramAddressSync([Buffer.from("vault")], new PublicKey(OTHER))[0].toBase58();
  const offCurve = checkNominee(g, pda);
  assert.ok(offCurve.ok && offCurve.warning !== null, "a PDA can only accept through a program, so it warns");
});

test("SOL/USD: first plausible source wins, bad answers fall through, all failing gives null", async () => {
  assert.equal(saneSolUsd(147.2), 147.2);
  assert.equal(saneSolUsd("152.5"), 152.5);
  for (const bad of [0, -5, 1e9, NaN, null, undefined, "x", {}]) assert.equal(saneSolUsd(bad), null, String(bad));

  const sources: PriceSource[] = [
    { name: "A", url: "a", read: (j) => (j as { a?: number }).a },
    { name: "B", url: "b", read: (j) => (j as { solana?: { usd?: number } }).solana?.usd },
  ];
  const fake = (answers: Record<string, unknown>) =>
    (async (url: string) => {
      const a = answers[url];
      if (a instanceof Error) throw a;
      return { ok: a !== 500, json: async () => a } as Response;
    }) as unknown as typeof fetch;

  assert.deepEqual(await fetchSolUsd(sources, fake({ a: { a: 140 }, b: { solana: { usd: 150 } } })), { price: 140, source: "A" });
  assert.deepEqual(await fetchSolUsd(sources, fake({ a: new Error("offline"), b: { solana: { usd: 150 } } })), { price: 150, source: "B" });
  assert.deepEqual(await fetchSolUsd(sources, fake({ a: 500, b: { solana: { usd: 150 } } })), { price: 150, source: "B" });
  assert.deepEqual(await fetchSolUsd(sources, fake({ a: { a: 0 }, b: { solana: { usd: 151 } } })), { price: 151, source: "B" }, "an implausible price is skipped");
  assert.equal(await fetchSolUsd(sources, fake({ a: new Error("x"), b: { nope: 1 } })), null);
});

test("SOL/USD: rate limits, hung requests and bad JSON fall through without throwing", async () => {
  const src = (name: string): PriceSource => ({ name, url: name, read: (j) => (j as { p?: number }).p });
  let aborted = 0;
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (url === "ratelimited") return { ok: false, status: 429, json: async () => ({ p: 999 }) } as Response;
    if (url === "hangs")
      // Never answers; only the timeout's abort ends it.
      return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => (aborted++, reject(new DOMException("aborted", "AbortError")))));
    if (url === "badjson") return { ok: true, json: async () => JSON.parse("<html>") } as Response;
    return { ok: true, json: async () => ({ p: 150 }) } as Response;
  }) as unknown as typeof fetch;

  const t0 = Date.now();
  assert.deepEqual(await fetchSolUsd([src("ratelimited"), src("hangs"), src("badjson"), src("good")], fetchImpl, 50), { price: 150, source: "good" });
  assert.equal(aborted, 1, "the hung request was aborted by the timeout");
  assert.ok(Date.now() - t0 < 2_000, "a hung source costs one timeout, not forever");
  // Every source failing resolves to null (the provider keeps its fallback price); it never rejects.
  assert.equal(await fetchSolUsd([src("ratelimited"), src("hangs"), src("badjson")], fetchImpl, 50), null);
});

test("SOL/USD: the real sources read their documented shapes", async () => {
  const { PRICE_SOURCES, WSOL_MINT } = await import("../src/lib/price");
  const [jup, gecko] = PRICE_SOURCES;
  assert.equal(jup.read({ [WSOL_MINT]: { usdPrice: 147.48, blockId: 1, decimals: 9, priceChange24h: 1.2 } }), 147.48);
  assert.equal(gecko.read({ solana: { usd: 147.23 } }), 147.23);
  assert.equal(jup.read({}), undefined);
  assert.equal(gecko.read(null), undefined);
});

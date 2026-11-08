import { test } from "node:test";
import assert from "node:assert/strict";
import { AnchorProvider, BN, BorshCoder, Program, Wallet } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransactionResponse } from "@solana/web3.js";
import type { Parabull } from "../../target/types/parabull";
import { quoteBuyExactTokens, quoteSell } from "./curve";
import { MAINNET_CURVE, smallCurve } from "./curveParams";
import { Checks, e2eOptions, eventsIn, field, fundingFor, lamportDelta, oneEvent, partialSellAmount, solToLamports, tokensForBudget, u64 } from "./e2e";
import { loadIdl } from "./program";

const fresh = (p = MAINNET_CURVE) => ({ virtualToken: p.initialVirtualTokenReserves, virtualSol: p.initialVirtualSolReserves, realToken: p.initialRealTokenReserves, realSol: 0n });

test("e2e: SOL amounts parse exactly", () => {
  assert.equal(solToLamports("0.230"), 230_000_000n);
  assert.equal(solToLamports("0.23"), 230_000_000n);
  assert.equal(solToLamports("1"), 1_000_000_000n);
  assert.equal(solToLamports("0.000000001"), 1n);
  for (const bad of ["", "-1", "0.1234567891", "1e9", ".5", "abc"]) assert.throws(() => solToLamports(bad), /not a SOL amount/, bad);
});

test("e2e: options (0.230 SOL buy and a half sell by default; refused on mainnet)", () => {
  assert.deepEqual(e2eOptions({}, "devnet"), { buyLamports: 230_000_000n, sellBps: 5_000n, slippageBps: 200n, uri: null, indexerUrl: null, keepFunds: false });
  assert.deepEqual(
    e2eOptions({ E2E_BUY_SOL: "0.5", E2E_SELL_BPS: "2500", E2E_SLIPPAGE_BPS: "0", E2E_URI: " https://arweave.net/m.json ", E2E_INDEXER_URL: "http://127.0.0.1:8790/", E2E_KEEP_FUNDS: "1" }, "localnet"),
    { buyLamports: 500_000_000n, sellBps: 2_500n, slippageBps: 0n, uri: "https://arweave.net/m.json", indexerUrl: "http://127.0.0.1:8790", keepFunds: true },
  );
  assert.throws(() => e2eOptions({}, "mainnet-beta"), /devnet/);
  assert.throws(() => e2eOptions({ E2E_SELL_BPS: "10000" }, "devnet"), /E2E_SELL_BPS/, "a full sell isn't partial");
  assert.throws(() => e2eOptions({ E2E_SELL_BPS: "0" }, "devnet"), /E2E_SELL_BPS/);
  assert.throws(() => e2eOptions({ E2E_BUY_SOL: "0" }, "devnet"), /above 0/);
  assert.throws(() => e2eOptions({ E2E_BUY_SOL: "3" }, "devnet"), /capped/);
  assert.throws(() => e2eOptions({ E2E_INDEXER_URL: "ftp://x" }, "devnet"), /http/);
});

test("e2e: a 0.230 SOL budget buys the most tokens whose cost + 1% fee fits (vector computed independently)", () => {
  const r = fresh();
  const q = tokensForBudget(r, 230_000_000n, 100n);
  // Python, same formulas: max t with floor(t*vs/(vt-t)) + 1 + ceil(cost/100) <= 230_000_000.
  assert.deepEqual(q, { tokensOut: 8_083_524_392_460n, solCost: 227_722_772n, fee: 2_277_228n, total: 230_000_000n });
  assert.ok(quoteBuyExactTokens(r, q.tokensOut + 1n, 100n).total > 230_000_000n, "one more unit doesn't fit");
  // The half sell that follows, against the curve after the buy.
  const after = { virtualToken: r.virtualToken - q.tokensOut, virtualSol: r.virtualSol + q.solCost, realToken: r.realToken - q.tokensOut, realSol: q.solCost };
  const s = quoteSell(after, partialSellAmount(q.tokensOut, 5_000n), 100n);
  assert.deepEqual(s, { tokensIn: 4_041_762_196_230n, solGross: 114_291_899n, fee: 1_142_919n, solNet: 113_148_980n });
});

test("e2e: a budget that would buy out the curve is refused (the test needs it still trading)", () => {
  const small = fresh(smallCurve(200_000_000n, 50_000_000n));
  assert.throws(() => tokensForBudget(small, 230_000_000n, 100n), /buy out the whole curve/);
  assert.ok(tokensForBudget(small, 100_000_000n, 100n).tokensOut < small.realToken);
  assert.throws(() => tokensForBudget(fresh(), 1n, 100n), /single token unit/);
});

test("e2e: partial sell amounts always leave some held", () => {
  assert.equal(partialSellAmount(1_000n, 5_000n), 500n);
  assert.equal(partialSellAmount(3n, 1n), 1n, "at least one unit");
  assert.equal(partialSellAmount(2n, 9_999n), 1n, "never all of it");
  assert.equal(partialSellAmount(10n, 10_000n), 9n, "even when asked for all of it");
  assert.throws(() => partialSellAmount(1n, 5_000n), /at least 2/);
});

test("e2e: funding covers the deposit, the buy at its slippage ceiling, and rent + fees", () => {
  assert.equal(fundingFor(230_000_000n, 230_000_000n, 200n), 230_000_000n + 234_600_000n + 30_000_000n);
});

test("e2e: lamport deltas come from the transaction's own metadata", () => {
  const a = Keypair.generate().publicKey;
  const b = Keypair.generate().publicKey;
  const message = new TransactionMessage({
    payerKey: a,
    recentBlockhash: PublicKey.default.toBase58(),
    instructions: [SystemProgram.transfer({ fromPubkey: a, toPubkey: b, lamports: 7 })],
  }).compileToV0Message();
  const keys = message.staticAccountKeys;
  const pre = keys.map((k) => (k.equals(a) ? 100_000 : k.equals(b) ? 0 : 1));
  const post = keys.map((k) => (k.equals(a) ? 89_993 : k.equals(b) ? 7 : 1));
  const tx = { transaction: { message, signatures: [] }, meta: { preBalances: pre, postBalances: post, loadedAddresses: { writable: [], readonly: [] }, fee: 5_000 } } as unknown as VersionedTransactionResponse;
  assert.equal(lamportDelta(tx, a), -10_007n);
  assert.equal(lamportDelta(tx, b), 7n);
  assert.equal(lamportDelta(tx, Keypair.generate().publicKey), 0n, "not in the transaction");
  assert.throws(() => lamportDelta({ ...tx, meta: null }, a), /metadata/);
});

test("e2e: events are read from the program's own log lines, by name and field", () => {
  const program = new Program<Parabull>(loadIdl(), new AnchorProvider(new Connection("http://127.0.0.1:8899"), new Wallet(Keypair.generate()), {}));
  const coder = program.coder as BorshCoder;
  const mint = Keypair.generate().publicKey;
  const user = Keypair.generate().publicKey;
  const disc = Buffer.from(program.idl.events!.find((e) => e.name === "tradeEvent")!.discriminator);
  const data = {
    mint, user, isBuy: true, tokenAmount: new BN(8_083_524_392_460), solAmount: new BN(227_722_772), fee: new BN(2_277_228),
    feeToEscrow: new BN(2_277_228), feeToBuyback: new BN(0), feeToHolders: new BN(0), feeToTreasury: new BN(0),
    virtualTokenReserves: new BN(1), virtualSolReserves: new BN(2), realTokenReserves: new BN(3), realSolReserves: new BN(227_722_772),
    slot: new BN(9), timestamp: new BN(10),
  };
  // Program<> camelCases the IDL, event type names included ("tradeEvent"); lookups below are case-insensitive.
  const line = `Program data: ${Buffer.concat([disc, coder.types.encode("tradeEvent", data)]).toString("base64")}`;
  const id = program.programId.toBase58();
  const other = Keypair.generate().publicKey.toBase58();
  const logs = [
    `Program ${id} invoke [1]`,
    line,
    // The same bytes logged by another program (a CPI) don't count as ours.
    `Program ${other} invoke [2]`,
    line,
    `Program ${other} success`,
    `Program ${id} success`,
  ];
  const events = eventsIn(logs, program.programId, coder);
  const ev = oneEvent(events, "trade_event");
  assert.equal(field(ev, "isBuy"), true);
  assert.ok((field(ev, "mint") as PublicKey).equals(mint));
  assert.equal(u64(field(ev, "tokenAmount")), 8_083_524_392_460n);
  assert.equal(u64(field(ev, "solAmount")), 227_722_772n);
  assert.throws(() => field(ev, "nope"), /no field nope/);
  assert.throws(() => oneEvent(events, "TokenCreated"), /expected one TokenCreated event, found 0/);
  assert.throws(() => oneEvent([...events, ...events], "TradeEvent"), /found 2/);
  // snake_case fields (another coder's convention) are found by their camelCase name.
  assert.equal(field({ name: "X", data: { token_amount: 5 } }, "tokenAmount"), 5);
});

test("e2e: checks record passes and stop at the first mismatch", () => {
  const lines: string[] = [];
  const c = new Checks((l) => lines.push(l));
  const k = Keypair.generate().publicKey;
  c.eq("bigint vs number", 100n, 100);
  c.eq("keys", new PublicKey(k.toBytes()), k);
  c.ok("truthy", 1);
  assert.deepEqual(c.passed, ["bigint vs number", "keys", "truthy"]);
  assert.equal(lines.length, 3);
  assert.throws(() => c.eq("fee", 99n, 100n), /FAIL fee: got 99, expected 100/);
  assert.throws(() => c.eq("key vs string", k, k.toBase58()), /FAIL key vs string/);
  assert.throws(() => c.ok("falsy", null, "why"), /FAIL falsy: why/);
});

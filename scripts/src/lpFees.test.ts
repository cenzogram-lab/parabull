import { test } from "node:test";
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";
import { fetchLpFeeAmount, parseLockPosition, uiToRaw } from "./lpFees";

const NFT = new PublicKey(Buffer.alloc(32, 3));
const ok = (body: unknown) => (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
const status = (s: number) => (async () => new Response("{}", { status: s })) as unknown as typeof fetch;
const position = (lp: number | string, decimals = 9) => ({ poolInfo: { lpMint: { decimals } }, positionInfo: { unclaimedFee: { lp, amountA: 0, amountB: 0, usdValue: 0 } } });

test("uiToRaw is exact for decimals and floors extra precision", () => {
  assert.equal(uiToRaw(1.5, 9), 1_500_000_000n);
  assert.equal(uiToRaw("0.000000001", 9), 1n);
  assert.equal(uiToRaw(1.2e-7, 9), 120n, "exponent notation input");
  assert.equal(uiToRaw(123456789.123456789, 9) !== null, true);
  assert.equal(uiToRaw(0, 9), null);
  assert.equal(uiToRaw(-1, 9), null);
  assert.equal(uiToRaw(Number.NaN, 9), null);
});

test("parse applies the safety margin and treats zero as nothing to claim", () => {
  assert.equal(parseLockPosition(position(2)), 1_998_000_000n, "2 LP minus 0.1%");
  assert.equal(parseLockPosition(position(2), 0n), 2_000_000_000n);
  assert.equal(parseLockPosition(position(0)), null);
  assert.equal(parseLockPosition(position("0.000000001")), null, "rounds to zero after margin");
  assert.equal(parseLockPosition({ foo: 1 }), null, "unexpected shape");
  assert.equal(parseLockPosition(position(1, 6)), 999_000n, "uses lpMint.decimals when present");
});

test("fetch falls back to null on HTTP errors, timeouts and bad JSON", async () => {
  const opts = { cluster: "devnet" as const, override: "" };
  assert.equal(await fetchLpFeeAmount(NFT, { ...opts, fetchImpl: status(404) }), null);
  assert.equal(await fetchLpFeeAmount(NFT, { ...opts, fetchImpl: status(429) }), null);
  assert.equal(await fetchLpFeeAmount(NFT, { ...opts, fetchImpl: (async () => new Response("not json", { status: 200 })) as unknown as typeof fetch }), null);
  const hang = ((_u: string, init: RequestInit) =>
    new Promise((_r, reject) => init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))))) as unknown as typeof fetch;
  assert.equal(await fetchLpFeeAmount(NFT, { ...opts, fetchImpl: hang, timeoutMs: 20 }), null);
  assert.equal(await fetchLpFeeAmount(NFT, { ...opts, fetchImpl: ok(position(3)) }), 2_997_000_000n);
});

test("override wins and must be a raw integer", async () => {
  const boom = (async () => {
    throw new Error("API must not be called");
  }) as unknown as typeof fetch;
  assert.equal(await fetchLpFeeAmount(NFT, { cluster: "devnet", override: "12345", fetchImpl: boom }), 12345n);
  assert.equal(await fetchLpFeeAmount(NFT, { cluster: "devnet", override: "0", fetchImpl: boom }), null);
  assert.equal(await fetchLpFeeAmount(NFT, { cluster: "devnet", override: "1.5", fetchImpl: boom }), null);
});

test("requests the SDK's endpoint with ?id=<NFT mint>", async () => {
  let seen = "";
  const spy = (async (u: string) => {
    seen = u;
    return new Response(JSON.stringify(position(1)), { status: 200 });
  }) as unknown as typeof fetch;
  await fetchLpFeeAmount(NFT, { cluster: "mainnet-beta", override: "", fetchImpl: spy });
  assert.equal(seen, `https://dynamic-ipfs.raydium.io/lock/cpmm/position?id=${NFT.toBase58()}`);
});

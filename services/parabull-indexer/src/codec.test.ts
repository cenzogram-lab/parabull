import assert from "node:assert/strict";
import { test } from "node:test";
import { base58Decode } from "../../../app/src/lib/chatMessage";
import { decodeAccount, decodeEvent, encodeAccount, encodeEvent, PROGRAM_ID } from "./borsh";
import { eventsFromLogs } from "./logs";
import { encodeMint, encodeTokenAccount, parseMint, parseOwnerAmount, parseTokenAccount } from "./token2022";

const MINT = "DrLUh4S9VS1rsJwPKexAmJsUhpZa89At8ea11ASTCUGn";
const USER = "7Z41mBaP2t5tbxJDRCGUdHC2Gw4dwbBgrmYzkFZq73cW";
const RAYDIUM = "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C";
const b64 = (s: string) => Uint8Array.from(Buffer.from(s, "base64"));

// Encoded by Anchor 0.31's own BorshCoder from the committed IDL (an independent encoder), then pinned here.
const ANCHOR_TRADE_EVENT =
  "vdt/007mYe6+77nYQcKaKDm54lfhnVDjh5Uom1TVA3fdesiGGQckl2FcHUn2puQl/Csa2sfeG0TpQsQW/+NXlpkEVKT5pIhDAQAwkRLVHwAAgHyBSgAAAAAgvL4AAAAAACC8vgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAOBGNQ6wAwCAKKVGBwAAAABINOl8sQIAgHyBSgAAAAA1pJoUAAAAAACIDmkAAAAA";
const ANCHOR_CURVE =
  "F7f4N2DYrGD+AAAAvu+52EHCmig5ueJX4Z1Q44eVKJtU1QN33XrIhhkHJJdhXB1J9qbkJfwrGtrH3htE6ULEFv/jV5aZBFSk+aSIQwDgRjUOsAMAgCilRgcAAAAASDTpfLECAIB8gUoAAAAAAIDGpH6NAwCwoJoUAAAAALSgmhQAAAAAGIQOaQAAAAAgvL4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const ANCHOR_TICKET =
  "68izz+Ly9KH9YVwdSfam5CX8Kxrax94bROlCxBb/41eWmQRUpPmkiEMHAAAAAAAAAICFtQ0AAAAAAMLrCwAAAAAOhA5pAAAAAGaGDmkAAAAAQlJPTlpFAAAAAAYBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAQMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

test("codec: decodes Anchor-encoded TradeEvent, BondingCurve and LaunchTicket from the IDL", () => {
  const ev = decodeEvent(b64(ANCHOR_TRADE_EVENT));
  assert.ok(ev);
  assert.equal(ev.name, "TradeEvent");
  assert.deepEqual(ev.data, {
    mint: MINT,
    user: USER,
    is_buy: true,
    token_amount: 35_000_000_000_000n,
    sol_amount: 1_250_000_000n,
    fee: 12_500_000n,
    fee_to_escrow: 12_500_000n,
    fee_to_buyback: 0n,
    fee_to_holders: 0n,
    fee_to_treasury: 0n,
    virtual_token_reserves: 1_038_000_000_000_000n,
    virtual_sol_reserves: 31_250_000_000n,
    real_token_reserves: 758_100_000_000_000n,
    real_sol_reserves: 1_250_000_000n,
    slot: 345_678_901n,
    timestamp: 1_762_560_000n,
  });

  const curveBytes = b64(ANCHOR_CURVE);
  const curve = decodeAccount<Record<string, unknown>>("BondingCurve", curveBytes)!;
  assert.equal(curve.mint, MINT);
  assert.equal(curve.creator, USER);
  assert.equal(curve.real_token_reserves, 758_100_000_000_000n);
  assert.equal(curve.token_total_supply, 1_000_000_000_000_000n);
  assert.equal(curve.trading_open_slot, 345_678_004n);
  assert.equal(curve.migration_stage, 0);
  // The layout the edge Worker reads by offset agrees: mint at 12..44.
  assert.deepEqual(curveBytes.subarray(12, 44), base58Decode(MINT));
  assert.equal(decodeAccount("LaunchTicket", curveBytes), null, "another account's discriminator is refused");

  const t = decodeAccount<Record<string, unknown>>("LaunchTicket", b64(ANCHOR_TICKET))!;
  assert.equal(t.payer, USER);
  assert.equal(t.nonce, 7n);
  assert.equal(t.deposit_lamports, 230_000_000n);
  assert.equal(t.expires_at, 1_762_559_590n);
  assert.equal(new TextDecoder().decode((t.ticker as Uint8Array).subarray(0, t.ticker_len as number)), "BRONZE");
  assert.deepEqual(t.tweet_id_hash, new Uint8Array(32).fill(3));
});

test("codec: the encoder is the decoder's exact inverse (and matches Anchor's bytes)", () => {
  const ev = decodeEvent(b64(ANCHOR_TRADE_EVENT))!;
  assert.equal(Buffer.from(encodeEvent("TradeEvent", ev.data)).toString("base64"), ANCHOR_TRADE_EVENT);
  const curve = decodeAccount("BondingCurve", b64(ANCHOR_CURVE))!;
  assert.equal(Buffer.from(encodeAccount("BondingCurve", curve)).toString("base64"), ANCHOR_CURVE);
  const t = decodeAccount("LaunchTicket", b64(ANCHOR_TICKET))!;
  assert.equal(Buffer.from(encodeAccount("LaunchTicket", t)).toString("base64"), ANCHOR_TICKET);
  // Strings and options (TokenCreated).
  const created = { mint: MINT, bonding_curve: USER, creator: USER, ticket: USER, name: "Bronze Bull 🐂", symbol: "BRONZE", uri: "https://media.parabull.test/meta/a.json", created_slot: 1n, trading_open_slot: 5n, launch_timestamp: 1_762_559_000n, virtual_token_reserves: 2n, virtual_sol_reserves: 3n, real_token_reserves: 4n, token_total_supply: 5n, launch_fee_lamports: 6n, rent_reimbursed: 7n, treasury_received: 8n, tweet_id_hash: null };
  assert.deepEqual(decodeEvent(encodeEvent("TokenCreated", created))?.data, created);
  assert.equal(decodeEvent(new Uint8Array(12)), null, "unknown discriminator");
  assert.equal(decodeEvent(encodeEvent("TokenCreated", created).subarray(0, 40)), null, "truncated payload");
});

test("logs: only this program's Program data lines, following the invoke stack", () => {
  const trade = `Program data: ${ANCHOR_TRADE_EVENT}`;
  const raydiumData = `Program data: ${Buffer.from(encodeEvent("TradeEvent", decodeEvent(b64(ANCHOR_TRADE_EVENT))!.data)).toString("base64")}`;
  const logs = [
    "Program ComputeBudget111111111111111111111111111111 invoke [1]",
    "Program ComputeBudget111111111111111111111111111111 success",
    `Program ${PROGRAM_ID} invoke [1]`,
    "Program log: Instruction: Buy",
    `Program TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb invoke [2]`,
    raydiumData, // a data line while another program runs (even one that decodes): not ours
    `Program TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb success`,
    trade,
    `Program ${PROGRAM_ID} consumed 41000 of 200000 compute units`,
    `Program ${PROGRAM_ID} success`,
    trade, // after our program returned: not ours
    `Program ${RAYDIUM} invoke [1]`,
    raydiumData,
    `Program ${RAYDIUM} success`,
  ];
  const evs = eventsFromLogs(logs, PROGRAM_ID);
  assert.equal(evs.length, 1);
  assert.equal(evs[0].name, "TradeEvent");
  // Garbage and unknown payloads are skipped, not thrown.
  assert.deepEqual(eventsFromLogs([`Program ${PROGRAM_ID} invoke [1]`, "Program data: !!!", "Program data: AAAAAAAAAAAAAAAA", "Log truncated"], PROGRAM_ID), []);
});

test("token-2022: mint metadata (name, symbol, uri) and token accounts", () => {
  const data = encodeMint({ mint: MINT, supply: 1_000_000_000_000_000n, name: "Bronze Bull", symbol: "BRONZE", uri: "https://media.parabull.test/meta/x.json" });
  assert.deepEqual(parseMint(data), { supply: 1_000_000_000_000_000n, decimals: 6, metadata: { name: "Bronze Bull", symbol: "BRONZE", uri: "https://media.parabull.test/meta/x.json" } });
  assert.deepEqual(parseMint(encodeMint({ mint: MINT, supply: 5n })), { supply: 5n, decimals: 6, metadata: null });
  assert.equal(parseMint(new Uint8Array(40)), null);
  const acct = encodeTokenAccount({ mint: MINT, owner: USER, amount: 42n });
  assert.deepEqual(parseTokenAccount(acct), { mint: MINT, owner: USER, amount: 42n });
  assert.deepEqual(parseOwnerAmount(acct.subarray(32, 72)), { owner: USER, amount: 42n });
  assert.equal(parseTokenAccount(data), null, "a mint isn't a token account");
});

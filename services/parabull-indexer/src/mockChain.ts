/**
 * A small simulated Solana cluster for tests and local runs: accounts and transactions in memory, served over the
 * JSON-RPC methods the indexer calls (as a fetch function, or over HTTP with `serve`), plus logsSubscribe pushes to
 * fake websockets. Launches, trades and graduation move real state: curves follow the repository's curve math
 * (scripts/src/curve.ts, the port of programs/parabull/src/math.rs), and every account and event is encoded from
 * the program's IDL, exactly as the indexer will decode it on a real cluster.
 */
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { base58Decode } from "../../../app/src/lib/chatMessage";
import { buyCost, sellProceeds, type Reserves } from "../../../scripts/src/curve";
import { base58Encode, bondingCurveAddress, findProgramAddress } from "../../parabull-edge/src/solana";
import { decodeAccount, encodeAccount, encodeEvent, PROGRAM_ID, zeroValue, type Decoded } from "./borsh";
import { encodeMint, encodeTokenAccount, TOKEN_2022_PROGRAM_ID } from "./token2022";

export const DEVNET_CPMM = "DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb";
const SPL_TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWxBwFLMaHvTNw4ZkN5";
const WSOL = "So11111111111111111111111111111111111111112";
const enc = (s: string) => new TextEncoder().encode(s);
export const addressOf = (seed: string) => base58Encode(createHash("sha256").update(seed).digest());

export const INITIAL = { virtualToken: 1_073_000_000_000_000n, virtualSol: 30_000_000_000n, realToken: 793_100_000_000_000n, supply: 1_000_000_000_000_000n };

interface Account {
  data: Uint8Array;
  owner: string;
  lamports: number;
}
interface Tx {
  signature: string;
  slot: number;
  blockTime: number;
  err: unknown;
  logs: string[];
}

/** What the fake websocket needs; the indexer passes this class where it would pass WebSocket. */
type Listener = (e: { data: unknown }) => void;

export class MockChain {
  readonly accounts = new Map<string, Account>();
  readonly txs: Tx[] = [];
  readonly calls: { method: string; params: unknown[] }[] = [];
  slot = 1_000;
  time = 1_762_560_000;
  private sigCounter = 0;
  private readonly sockets = new Set<{ emit: (type: string, e: { data: unknown }) => void; subscribed: boolean }>();
  /** When set, the RPC answers this method with an HTTP 500 (failure tests). */
  failing: string | null = null;

  constructor(readonly programId = PROGRAM_ID) {}

  // ---- state helpers ------------------------------------------------------------------------------------------

  private nextSignature() {
    const bytes = createHash("sha512").update(`sig:${++this.sigCounter}`).digest();
    return base58Encode(new Uint8Array(bytes));
  }

  /** Records a transaction whose top-level program is this program, emitting `events` (and any extra raw lines). */
  tx(events: { name: string; data: Decoded }[], opts: { err?: unknown; extraLines?: string[] } = {}): string {
    this.slot += 1;
    this.time += 2;
    const logs = [
      `Program ${this.programId} invoke [1]`,
      ...events.map((e) => `Program data: ${Buffer.from(encodeEvent(e.name, e.data)).toString("base64")}`),
      ...(opts.extraLines ?? []),
      `Program ${this.programId} ${opts.err ? "failed: custom program error: 0x1771" : "success"}`,
    ];
    const t: Tx = { signature: this.nextSignature(), slot: this.slot, blockTime: this.time, err: opts.err ?? null, logs };
    this.txs.push(t);
    for (const s of this.sockets)
      if (s.subscribed) s.emit("message", { data: JSON.stringify({ jsonrpc: "2.0", method: "logsNotification", params: { result: { context: { slot: t.slot }, value: { signature: t.signature, err: t.err, logs: t.logs } }, subscription: 1 } }) });
    return t.signature;
  }

  async initGlobal(over: Decoded = {}) {
    const g = {
      ...zeroValue("Global"),
      launch_fee_lamports: 200_000_000n,
      ticket_deposit_lamports: 230_000_000n,
      ticket_ttl_seconds: 600n,
      platform_fee_bps: 100,
      registry_lock_seconds: 259_200n,
      trading_open_delay_slots: 4n,
      initial_virtual_token_reserves: INITIAL.virtualToken,
      initial_virtual_sol_reserves: INITIAL.virtualSol,
      initial_real_token_reserves: INITIAL.realToken,
      token_total_supply: INITIAL.supply,
      cpmm_program: DEVNET_CPMM,
      ...over,
    };
    const { address } = await findProgramAddress([enc("global")], this.programId);
    this.accounts.set(address, { data: encodeAccount("Global", g), owner: this.programId, lamports: 1 });
  }

  /** request_launch: a LaunchTicket account and a LaunchRequested event. */
  requestLaunch(payer: string, ticker: string, nonce = 1n): string {
    const ticket = addressOf(`ticket:${payer}:${nonce}`);
    const t = { ...zeroValue("LaunchTicket"), payer, nonce, deposit_lamports: 230_000_000n, launch_fee_lamports: 200_000_000n, created_at: BigInt(this.time), expires_at: BigInt(this.time + 600), ticker: Uint8Array.from([...enc(ticker), ...new Uint8Array(10 - ticker.length)]), ticker_len: ticker.length };
    this.accounts.set(ticket, { data: encodeAccount("LaunchTicket", t), owner: this.programId, lamports: 230_000_000 });
    this.tx([{ name: "LaunchRequested", data: { ...zeroValue("LaunchRequested"), ticket, payer, nonce, ticker, deposit_lamports: 230_000_000n, expires_at: BigInt(this.time + 600) } }]);
    return ticket;
  }

  refund(ticket: string) {
    const payer = this.ticketPayer(ticket);
    this.accounts.delete(ticket);
    return this.tx([{ name: "TicketRefunded", data: { ticket, payer, refunded_by: payer, lamports: 230_000_000n } }]);
  }

  private ticketPayer(ticket: string) {
    const a = this.accounts.get(ticket);
    return a ? base58Encode(a.data.subarray(9, 41)) : addressOf("payer");
  }

  /** create: closes the ticket, makes the mint (with Token-2022 metadata), the curve and its token account. */
  async create(ticket: string, o: { mint: string; name: string; symbol: string; uri: string; tweet?: boolean }): Promise<{ curve: string; signature: string }> {
    const creator = this.ticketPayer(ticket);
    this.accounts.delete(ticket);
    const curve = (await bondingCurveAddress(o.mint, this.programId)).address;
    const c = {
      ...zeroValue("BondingCurve"),
      bump: 255,
      mint: o.mint,
      creator,
      virtual_token_reserves: INITIAL.virtualToken,
      virtual_sol_reserves: INITIAL.virtualSol,
      real_token_reserves: INITIAL.realToken,
      token_total_supply: INITIAL.supply,
      created_slot: BigInt(this.slot + 1),
      trading_open_slot: BigInt(this.slot + 5),
      launch_timestamp: BigInt(this.time + 2),
    };
    this.accounts.set(curve, { data: encodeAccount("BondingCurve", c), owner: this.programId, lamports: 2_000_000 });
    this.accounts.set(o.mint, { data: encodeMint({ mint: o.mint, supply: INITIAL.supply, name: o.name, symbol: o.symbol, uri: o.uri }), owner: TOKEN_2022_PROGRAM_ID, lamports: 3_000_000 });
    this.setTokenBalance(o.mint, curve, INITIAL.supply);
    const signature = this.tx([
      {
        name: "TokenCreated",
        data: {
          ...zeroValue("TokenCreated"),
          mint: o.mint,
          bonding_curve: curve,
          creator,
          ticket,
          name: o.name,
          symbol: o.symbol,
          uri: o.uri,
          created_slot: c.created_slot,
          trading_open_slot: c.trading_open_slot,
          launch_timestamp: c.launch_timestamp,
          virtual_token_reserves: INITIAL.virtualToken,
          virtual_sol_reserves: INITIAL.virtualSol,
          real_token_reserves: INITIAL.realToken,
          token_total_supply: INITIAL.supply,
          launch_fee_lamports: 200_000_000n,
          tweet_id_hash: o.tweet ? new Uint8Array(32).fill(9) : null,
        },
      },
    ]);
    return { curve, signature };
  }

  tokenAccountAddress(mint: string, owner: string) {
    return addressOf(`ata:${owner}:${mint}`);
  }
  setTokenBalance(mint: string, owner: string, amount: bigint, program = TOKEN_2022_PROGRAM_ID) {
    this.accounts.set(this.tokenAccountAddress(mint, owner), { data: encodeTokenAccount({ mint, owner, amount }), owner: program, lamports: 2_039_280 });
  }
  tokenBalance(mint: string, owner: string): bigint {
    const a = this.accounts.get(this.tokenAccountAddress(mint, owner));
    return a ? new DataView(a.data.buffer, a.data.byteOffset).getBigUint64(64, true) : 0n;
  }

  async curve(mint: string): Promise<{ address: string; data: Decoded }> {
    const address = (await bondingCurveAddress(mint, this.programId)).address;
    return { address, data: decodeAccount<Decoded>("BondingCurve", this.accounts.get(address)!.data)! };
  }

  private async writeCurve(mint: string, f: (c: Decoded) => void) {
    const { address, data } = await this.curve(mint);
    f(data);
    this.accounts.get(address)!.data = encodeAccount("BondingCurve", data);
    return { address, data };
  }

  /** buy (exact tokens, capped at what's left) or sell, through the curve math; 1% fee to the escrow counter. */
  async trade(mint: string, user: string, isBuy: boolean, tokens: bigint, opts: { err?: unknown } = {}): Promise<string> {
    let ev: Decoded = {};
    let sol = 0n;
    const { address, data } = await this.writeCurve(mint, (c) => {
      const r: Reserves = { virtualToken: c.virtual_token_reserves as bigint, virtualSol: c.virtual_sol_reserves as bigint, realToken: c.real_token_reserves as bigint, realSol: c.real_sol_reserves as bigint };
      const amount = isBuy && tokens > r.realToken ? r.realToken : tokens;
      sol = isBuy ? buyCost(r, amount) : sellProceeds(r, amount);
      const fee = (sol + 99n) / 100n;
      if (!opts.err) {
        c.virtual_token_reserves = isBuy ? r.virtualToken - amount : r.virtualToken + amount;
        c.virtual_sol_reserves = isBuy ? r.virtualSol + sol : r.virtualSol - sol;
        c.real_token_reserves = isBuy ? r.realToken - amount : r.realToken + amount;
        c.real_sol_reserves = isBuy ? r.realSol + sol : r.realSol - sol;
        c.escrow_accrued = (c.escrow_accrued as bigint) + fee;
        if (c.real_token_reserves === 0n) c.complete = true;
      }
      ev = { ...zeroValue("TradeEvent"), mint, user, is_buy: isBuy, token_amount: amount, sol_amount: sol, fee, fee_to_escrow: fee, virtual_token_reserves: c.virtual_token_reserves, virtual_sol_reserves: c.virtual_sol_reserves, real_token_reserves: c.real_token_reserves, real_sol_reserves: c.real_sol_reserves, slot: BigInt(this.slot + 1), timestamp: BigInt(this.time + 2) };
      tokens = amount;
    });
    if (!opts.err) {
      this.setTokenBalance(mint, user, this.tokenBalance(mint, user) + (isBuy ? tokens : -tokens));
      this.setTokenBalance(mint, address, this.tokenBalance(mint, address) + (isBuy ? -tokens : tokens));
    }
    const events = [{ name: "TradeEvent", data: ev }];
    if (!opts.err && data.complete && isBuy) events.push({ name: "GraduationReady", data: { ...zeroValue("GraduationReady"), mint, bonding_curve: address, real_sol_reserves: data.real_sol_reserves } });
    return this.tx(events, opts);
  }

  /** prepare_migration + migrate_raydium: tokens and SOL to a Raydium pool (with its own Program data in a CPI). */
  async migrate(mint: string): Promise<string> {
    const pool = addressOf(`pool:${mint}`);
    let sol = 0n;
    let tokensToPool = 0n;
    await this.writeCurve(mint, (c) => {
      sol = c.real_sol_reserves as bigint;
      tokensToPool = (c.token_total_supply as bigint) - INITIAL.realToken;
      c.migrated = true;
      c.complete = true;
      c.migration_stage = 2;
      c.raydium_pool = pool;
      c.real_sol_reserves = 0n;
    });
    const vault = async (m: string) => (await findProgramAddress([enc("pool_vault"), base58Decode(pool)!, base58Decode(m)!], DEVNET_CPMM)).address;
    const { address: auth } = await findProgramAddress([enc("vault_and_lp_mint_auth_seed")], DEVNET_CPMM);
    const tokenVault = await vault(mint);
    const wsolVault = await vault(WSOL);
    this.accounts.set(tokenVault, { data: encodeTokenAccount({ mint, owner: auth, amount: tokensToPool }), owner: TOKEN_2022_PROGRAM_ID, lamports: 2_039_280 });
    this.accounts.set(wsolVault, { data: encodeTokenAccount({ mint: WSOL, owner: auth, amount: sol }), owner: SPL_TOKEN, lamports: Number(sol) });
    const curveAddr = (await this.curve(mint)).address;
    this.setTokenBalance(mint, curveAddr, 0n);
    this.accounts.set(this.tokenAccountAddress(mint, auth), this.accounts.get(tokenVault)!);
    // Raydium's own event, logged inside its CPI: the indexer must not take it for one of ours.
    const raydiumLine = Buffer.from(encodeEvent("TradeEvent", { ...zeroValue("TradeEvent"), mint, user: auth, is_buy: true, token_amount: 1n, sol_amount: 1n })).toString("base64");
    return this.tx([{ name: "MigratedToRaydium", data: { ...zeroValue("MigratedToRaydium"), mint, pool, token_0: WSOL, token_1: mint, tokens_to_pool: tokensToPool, sol_to_pool: sol } }], {
      extraLines: [`Program ${DEVNET_CPMM} invoke [2]`, `Program data: ${raydiumLine}`, `Program ${DEVNET_CPMM} success`],
    });
  }

  // ---- JSON-RPC -----------------------------------------------------------------------------------------------

  private acct(a: Account, slice?: { offset: number; length: number }) {
    const data = slice ? a.data.subarray(slice.offset, slice.offset + slice.length) : a.data;
    return { data: [Buffer.from(data).toString("base64"), "base64"], owner: a.owner, lamports: a.lamports, executable: false, rentEpoch: 0 };
  }

  private matches(a: Account, filters: { memcmp?: { offset: number; bytes: string }; dataSize?: number }[]) {
    return filters.every((f) => {
      if (f.dataSize !== undefined) return a.data.length === f.dataSize;
      if (f.memcmp) {
        const want = base58Decode(f.memcmp.bytes)!;
        const got = a.data.subarray(f.memcmp.offset, f.memcmp.offset + want.length);
        return got.length === want.length && got.every((b, i) => b === want[i]);
      }
      return true;
    });
  }

  handle(method: string, params: unknown[]): unknown {
    this.calls.push({ method, params });
    const ctx = { slot: this.slot };
    switch (method) {
      case "getProgramAccounts": {
        const [program, cfg] = params as [string, { filters?: []; dataSlice?: { offset: number; length: number }; withContext?: boolean }];
        const value = [...this.accounts].filter(([, a]) => a.owner === program && this.matches(a, cfg.filters ?? [])).map(([pubkey, a]) => ({ pubkey, account: this.acct(a, cfg.dataSlice) }));
        return cfg.withContext ? { context: ctx, value } : value;
      }
      case "getAccountInfo": {
        const [key] = params as [string];
        const a = this.accounts.get(key);
        return { context: ctx, value: a ? this.acct(a) : null };
      }
      case "getMultipleAccounts": {
        const [keys] = params as [string[]];
        return { context: ctx, value: keys.map((k) => (this.accounts.has(k) ? this.acct(this.accounts.get(k)!) : null)) };
      }
      case "getSignaturesForAddress": {
        const [, o] = params as [string, { before?: string; until?: string; limit?: number }];
        let list = [...this.txs].reverse(); // newest first
        if (o.before) list = list.slice(list.findIndex((t) => t.signature === o.before) + 1);
        if (o.until) {
          const i = list.findIndex((t) => t.signature === o.until);
          if (i >= 0) list = list.slice(0, i);
        }
        return list.slice(0, o.limit ?? 1000).map((t) => ({ signature: t.signature, slot: t.slot, err: t.err, blockTime: t.blockTime, memo: null, confirmationStatus: "confirmed" }));
      }
      case "getTransaction": {
        const [sig] = params as [string];
        const t = this.txs.find((x) => x.signature === sig);
        return t ? { slot: t.slot, blockTime: t.blockTime, meta: { err: t.err, logMessages: t.logs }, transaction: {} } : null;
      }
      case "getTokenAccountsByOwner": {
        const [owner, { programId }, cfg] = params as [string, { programId: string }, { dataSlice?: { offset: number; length: number } }];
        const value = [...this.accounts].filter(([, a]) => a.owner === programId && a.data.length >= 72 && base58Encode(a.data.subarray(32, 64)) === owner).map(([pubkey, a]) => ({ pubkey, account: this.acct(a, cfg?.dataSlice) }));
        return { context: ctx, value };
      }
      case "getBalance":
        return { context: ctx, value: 5_000_000_000 };
      default:
        throw new Error(`mock RPC: no method ${method}`);
    }
  }

  /** A fetch function answering JSON-RPC from this chain. */
  readonly fetch = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const req = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] };
    if (this.failing === req.method) return new Response("down", { status: 500 });
    try {
      return Response.json({ jsonrpc: "2.0", id: req.id, result: this.handle(req.method, req.params) });
    } catch (e) {
      return Response.json({ jsonrpc: "2.0", id: req.id, error: { code: -32601, message: (e as Error).message } });
    }
  };

  /** A WebSocket stand-in for logsSubscribe: pass `chain.WebSocket` to Indexer.subscribe. */
  get WebSocket(): typeof WebSocket {
    const chain = this;
    class FakeSocket {
      private listeners = new Map<string, Listener[]>();
      subscribed = false;
      constructor(readonly url: string) {
        chain.sockets.add(this);
        queueMicrotask(() => this.emit("open", { data: null }));
      }
      addEventListener(type: string, f: Listener) {
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), f]);
      }
      emit(type: string, e: { data: unknown }) {
        for (const f of this.listeners.get(type) ?? []) f(e);
      }
      send(raw: string) {
        if ((JSON.parse(raw) as { method: string }).method === "logsSubscribe") this.subscribed = true;
      }
      close() {
        chain.sockets.delete(this);
        this.emit("close", { data: null });
      }
    }
    return FakeSocket as unknown as typeof WebSocket;
  }

  /** Serves this chain's JSON-RPC over HTTP (for the app's browser tests and local runs). */
  serve(port: number, host = "127.0.0.1"): Promise<Server> {
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      res.setHeader("access-control-allow-origin", "*");
      res.setHeader("access-control-allow-headers", "content-type");
      if (req.method === "OPTIONS") return void res.writeHead(204).end();
      const r = await this.fetch("", { method: "POST", body: Buffer.concat(chunks).toString() });
      res.writeHead(r.status, { "content-type": "application/json" }).end(await r.text());
    });
    return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
  }
}


/**
 * Indexes Parabull from Solana RPC (docs/BACKEND_SPEC.md §5):
 *
 * - Curves: every BondingCurve account by getProgramAccounts (discriminator filter), every CURVES_MS. Each curve's
 *   mint carries its name, symbol and URI in Token-2022 metadata, read once; the URI's JSON (image, description,
 *   links) is fetched only from allowed origins.
 * - Tickets: every open LaunchTicket the same way; LaunchRequested / TokenCreated / TicketRefunded events move them
 *   to pending / created / refunded, and a ticket that closes without an event seen is "closed".
 * - Trades and lifecycle: program events (TradeEvent, TokenCreated, GraduationReady, MigratedToRaydium, ...) from
 *   transaction logs, two ways that overlap and dedupe by signature:
 *     logsSubscribe over the RPC websocket, for latency (a coin appears as soon as `create` lands);
 *     getSignaturesForAddress(program) + getTransaction, polled, which also backfills on start and fills any gap
 *     the websocket left (it is the source of truth for ordering and completeness).
 *   A trade's own reserves update the curve only if newer than what was last seen (by slot).
 * - On demand: a mint nobody has seen yet (just created, between polls) is looked up directly: its curve PDA and mint.
 *   Holders (getProgramAccounts on Token-2022 by mint) and portfolios (getTokenAccountsByOwner) are read when asked,
 *   cached briefly, and coalesced so a burst of requests is one RPC call.
 */
import { EventEmitter } from "node:events";
import { base58Encode, bondingCurveAddress, findProgramAddress } from "../../parabull-edge/src/solana";
import { base58Decode } from "../../../app/src/lib/chatMessage";
import { accountDiscriminator, decodeAccount, PROGRAM_ID, type Decoded } from "./borsh";
import { eventsFromLogs } from "./logs";
import { priceSol, mcapOf, type CoinRecord, type HolderJson, type HolderLabel, type Socials, type TicketRecord, type TradeRecord } from "./model";
import type { Rpc, SignatureInfo } from "./rpc";
import { Store } from "./store";
import { parseMint, parseOwnerAmount, parseTokenAccount, TOKEN_2022_PROGRAM_ID } from "./token2022";

const WSOL_MINT = "So11111111111111111111111111111111111111112";
const DEFAULT_PUBKEY = "11111111111111111111111111111111";
const enc = (s: string) => new TextEncoder().encode(s);

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface GlobalParams {
  initialVirtualToken: bigint;
  initialVirtualSol: bigint;
  initialRealToken: bigint;
  tokenTotalSupply: bigint;
  registryLockSeconds: number;
  cpmmProgram: string;
}

export interface IndexerOptions {
  rpc: Rpc;
  programId?: string;
  /** Milliseconds since the epoch (tests pin it). */
  now?: () => number;
  /** How many of the program's most recent transactions to read on start. */
  backfillLimit?: number;
  /** Origins (https://host) the metadata JSON may be fetched from; others are never fetched. */
  metadataOrigins?: string[];
  fetchImpl?: Fetch;
  log?: (msg: string) => void;
  holdersTtlMs?: number;
  portfolioTtlMs?: number;
}

interface Cached<T> {
  at: number;
  value?: T;
  inflight?: Promise<T>;
}

export interface HoldersResult {
  mint: string;
  totalSupply: string;
  count: number;
  holders: HolderJson[];
}

export interface PortfolioResult {
  wallet: string;
  lamports: string;
  holdings: { mint: string; amount: string; valueSol: number }[];
}

const str = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
function httpsUrl(v: unknown): string | undefined {
  const s = str(v, 512);
  if (!s) return undefined;
  try {
    const u = new URL(s);
    return u.protocol === "https:" ? u.href : undefined;
  } catch {
    return undefined;
  }
}

/** Image, description and links from a metadata JSON (the shape parabull-edge's POST /metadata writes). */
export function metadataFields(json: unknown): { image: string | null; description: string | null; socials: Socials } {
  const m = (typeof json === "object" && json !== null ? json : {}) as Record<string, unknown>;
  const image = (() => {
    const s = str(m.image, 2048);
    if (!s) return null;
    try {
      const u = new URL(s);
      return u.protocol === "https:" || u.protocol === "ipfs:" || u.protocol === "ar:" ? u.href : null;
    } catch {
      return null;
    }
  })();
  const twitter = str(m.twitter ?? m.x, 256);
  const handle = twitter && /^@?[A-Za-z0-9_]{1,15}$/.test(twitter) ? `https://x.com/${twitter.replace(/^@/, "")}` : undefined;
  const socials: Socials = {};
  const x = handle ?? httpsUrl(twitter);
  const website = httpsUrl(m.website);
  const telegram = httpsUrl(m.telegram);
  if (x) socials.x = x;
  if (website) socials.website = website;
  if (telegram) socials.telegram = telegram;
  return { image, description: str(m.description, 1000), socials };
}

export class Indexer extends EventEmitter {
  readonly store = new Store();
  readonly programId: string;
  global: GlobalParams | null = null;
  /** The newest program signature processed in order: the poller's `until`. */
  newestSignature: string | null = null;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  private readonly fetchImpl: Fetch;
  private readonly metadataOrigins: Set<string>;
  private readonly metaTries = new Map<string, number>();
  private readonly missing = new Map<string, number>();
  private readonly lookups = new Map<string, Promise<CoinRecord | null>>();
  private readonly holderCache = new Map<string, Cached<HoldersResult>>();
  private readonly portfolioCache = new Map<string, Cached<PortfolioResult>>();
  private readonly pdaCache = new Map<string, string>();
  private readonly running = new Set<string>();

  constructor(private readonly opts: IndexerOptions) {
    super();
    this.programId = opts.programId ?? PROGRAM_ID;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => undefined);
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.metadataOrigins = new Set((opts.metadataOrigins ?? []).map((o) => o.replace(/\/+$/, "")));
  }

  private get rpc() {
    return this.opts.rpc;
  }
  nowSec() {
    return Math.floor(this.now() / 1000);
  }

  private async pda(seeds: Uint8Array[], programId: string, key: string): Promise<string> {
    const hit = this.pdaCache.get(key);
    if (hit) return hit;
    const { address } = await findProgramAddress(seeds, programId);
    this.pdaCache.set(key, address);
    return address;
  }

  /** Fire-and-forget work: a failure (the RPC down, say) is logged, never an unhandled rejection that ends the process. */
  private background(p: Promise<unknown>) {
    p.catch((e: Error) => this.log(`background: ${e?.message ?? e}`));
  }

  /** Runs `task` unless the same task is already running (overlapping timers skip a beat instead of piling up). */
  private async exclusive(name: string, task: () => Promise<void>) {
    if (this.running.has(name)) return;
    this.running.add(name);
    try {
      await task();
    } finally {
      this.running.delete(name);
    }
  }

  // ---- Global -------------------------------------------------------------------------------------------------

  async syncGlobal(): Promise<void> {
    const address = await this.pda([enc("global")], this.programId, "global");
    const { accounts } = await this.rpc.getMultipleAccounts([address]);
    const a = accounts[0];
    const g = a && a.owner === this.programId ? decodeAccount<Decoded>("Global", a.data) : null;
    if (!g) throw new Error("Global account not found: is the program initialized on this cluster?");
    this.global = {
      initialVirtualToken: g.initial_virtual_token_reserves as bigint,
      initialVirtualSol: g.initial_virtual_sol_reserves as bigint,
      initialRealToken: g.initial_real_token_reserves as bigint,
      tokenTotalSupply: g.token_total_supply as bigint,
      registryLockSeconds: Number(g.registry_lock_seconds),
      cpmmProgram: g.cpmm_program as string,
    };
  }

  // ---- Curves -------------------------------------------------------------------------------------------------

  /** Creates or updates a coin from its BondingCurve account as of `slot`. Returns the record and whether it is new. */
  private upsertCurve(curveAddress: string, curve: Decoded, slot: number): { coin: CoinRecord; created: boolean } {
    const mint = curve.mint as string;
    let coin = this.store.coins.get(mint);
    const created = !coin;
    if (!coin) {
      const g = this.global;
      coin = {
        mint,
        curve: curveAddress,
        creator: curve.creator as string,
        ticket: null,
        name: "",
        symbol: "",
        uri: "",
        image: null,
        description: null,
        socials: {},
        createdSlot: curve.created_slot as bigint,
        tradingOpenSlot: curve.trading_open_slot as bigint,
        launchTimestamp: Number(curve.launch_timestamp),
        complete: false,
        migrated: false,
        escrowReleased: false,
        virtualToken: 0n,
        virtualSol: 0n,
        realToken: 0n,
        realSol: 0n,
        totalSupply: curve.token_total_supply as bigint,
        initialRealToken: g?.initialRealToken ?? 0n,
        initialPriceSol: g ? priceSol(g.initialVirtualToken, g.initialVirtualSol) : 0,
        escrowAccrued: 0n,
        raydiumPool: null,
        poolPriceSol: null,
        tweetLocked: false,
        reservesSlot: -1,
        athMcapSol: 0,
        holderCount: null,
      };
      this.store.coins.set(mint, coin);
    }
    if (slot >= coin.reservesSlot) {
      coin.virtualToken = curve.virtual_token_reserves as bigint;
      coin.virtualSol = curve.virtual_sol_reserves as bigint;
      coin.realToken = curve.real_token_reserves as bigint;
      coin.realSol = curve.real_sol_reserves as bigint;
      coin.complete = curve.complete as boolean;
      coin.migrated = curve.migrated as boolean;
      coin.escrowReleased = curve.escrow_released as boolean;
      coin.escrowAccrued = curve.escrow_accrued as bigint;
      const pool = curve.raydium_pool as string;
      if (pool !== DEFAULT_PUBKEY) coin.raydiumPool = pool;
      coin.reservesSlot = slot;
      coin.athMcapSol = Math.max(coin.athMcapSol, mcapOf(coin));
    }
    return { coin, created };
  }

  async syncCurves(): Promise<void> {
    await this.exclusive("curves", async () => {
      const disc = base58Encode(accountDiscriminator("BondingCurve"));
      const { slot, accounts } = await this.rpc.getProgramAccounts(this.programId, [{ memcmp: { offset: 0, bytes: disc } }]);
      const fresh: CoinRecord[] = [];
      const changed: CoinRecord[] = [];
      for (const a of accounts) {
        const curve = decodeAccount<Decoded>("BondingCurve", a.data);
        if (!curve) continue;
        const before = this.store.coins.get(curve.mint as string);
        const snapshot = before && `${before.virtualSol}:${before.complete}:${before.migrated}:${before.escrowReleased}`;
        const { coin, created } = this.upsertCurve(a.pubkey, curve, slot);
        if (created) fresh.push(coin);
        else if (snapshot !== `${coin.virtualSol}:${coin.complete}:${coin.migrated}:${coin.escrowReleased}`) changed.push(coin);
      }
      await this.loadMints(this.missingMetadata());
      await this.syncPools();
      for (const c of [...fresh, ...changed]) this.emit("coin", c.mint);
      this.background(this.loadMetadataJson());
    });
  }

  private missingMetadata() {
    return [...this.store.coins.values()].filter((c) => !c.name && !c.symbol);
  }

  /** Name, symbol and URI from each mint's Token-2022 metadata. */
  private async loadMints(coins: CoinRecord[]): Promise<void> {
    if (!coins.length) return;
    const { accounts } = await this.rpc.getMultipleAccounts(coins.map((c) => c.mint));
    coins.forEach((c, i) => {
      const a = accounts[i];
      if (!a || a.owner !== TOKEN_2022_PROGRAM_ID) return;
      const m = parseMint(a.data)?.metadata;
      if (!m) return;
      c.name = m.name.slice(0, 64);
      c.symbol = m.symbol.slice(0, 16);
      c.uri = m.uri.slice(0, 512);
    });
  }

  /** The metadata JSON of coins that don't have it yet, from allowed origins only (a few tries each). */
  async loadMetadataJson(): Promise<void> {
    await this.exclusive("metadata", async () => {
      const todo = [...this.store.coins.values()].filter((c) => c.uri && c.image === null && (this.metaTries.get(c.mint) ?? 0) < 3);
      for (const c of todo) {
        this.metaTries.set(c.mint, (this.metaTries.get(c.mint) ?? 0) + 1);
        const json = await this.fetchJson(c.uri);
        if (!json) continue;
        const m = metadataFields(json);
        c.image = m.image;
        c.description = m.description;
        c.socials = m.socials;
        if (m.image) this.emit("coin", c.mint);
      }
    });
  }

  private async fetchJson(uri: string): Promise<unknown | null> {
    let url: URL;
    try {
      url = new URL(uri);
    } catch {
      return null;
    }
    if (!this.metadataOrigins.has(url.origin)) return null;
    try {
      // No redirects: a redirect could leave the allowed origin.
      const res = await this.fetchImpl(url.href, { redirect: "error", signal: AbortSignal.timeout(5_000), headers: { accept: "application/json" } });
      if (!res.ok || !res.body) return null;
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 64 * 1024) {
          await reader.cancel();
          return null;
        }
        chunks.push(value);
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      return null;
    }
  }

  /** Price on Raydium for graduated coins, from the pool's two vaults (["pool_vault", pool, mint] under CPMM). */
  private async syncPools(): Promise<void> {
    const g = this.global;
    if (!g) return;
    const coins = [...this.store.coins.values()].filter((c) => c.migrated && c.raydiumPool);
    if (!coins.length) return;
    const keys: string[] = [];
    for (const c of coins) {
      const pool = base58Decode(c.raydiumPool!)!;
      keys.push(await this.pda([enc("pool_vault"), pool, base58Decode(c.mint)!], g.cpmmProgram, `vault:${c.raydiumPool}:${c.mint}`));
      keys.push(await this.pda([enc("pool_vault"), pool, base58Decode(WSOL_MINT)!], g.cpmmProgram, `vault:${c.raydiumPool}:wsol`));
    }
    const { accounts } = await this.rpc.getMultipleAccounts(keys);
    coins.forEach((c, i) => {
      const tokens = accounts[2 * i] && parseTokenAccount(accounts[2 * i]!.data);
      const wsol = accounts[2 * i + 1] && parseTokenAccount(accounts[2 * i + 1]!.data);
      if (tokens && wsol && tokens.amount > 0n) {
        c.poolPriceSol = Number(wsol.amount) / 1e9 / (Number(tokens.amount) / 1e6);
        c.athMcapSol = Math.max(c.athMcapSol, mcapOf(c));
      }
    });
  }

  // ---- Tickets ------------------------------------------------------------------------------------------------

  private upsertTicket(t: Omit<TicketRecord, "state" | "mint">, state: TicketRecord["state"], mint: string | null = null) {
    const cur = this.store.tickets.get(t.ticket);
    // A final state (created / refunded) is never walked back by a later snapshot.
    if (cur && (cur.state === "created" || cur.state === "refunded") && state === "pending") return;
    const next: TicketRecord = { ...(cur ?? t), ...t, state, mint: mint ?? cur?.mint ?? null };
    this.store.tickets.set(t.ticket, next);
    if (!cur || cur.state !== next.state) this.emit("ticket", next);
  }

  async syncTickets(): Promise<void> {
    await this.exclusive("tickets", async () => {
      const disc = base58Encode(accountDiscriminator("LaunchTicket"));
      const { accounts } = await this.rpc.getProgramAccounts(this.programId, [{ memcmp: { offset: 0, bytes: disc } }]);
      const open = new Set<string>();
      for (const a of accounts) {
        const t = decodeAccount<Decoded>("LaunchTicket", a.data);
        if (!t) continue;
        open.add(a.pubkey);
        const ticker = new TextDecoder().decode((t.ticker as Uint8Array).subarray(0, t.ticker_len as number));
        this.upsertTicket({ ticket: a.pubkey, payer: t.payer as string, ticker, depositLamports: t.deposit_lamports as bigint, createdAt: Number(t.created_at), expiresAt: Number(t.expires_at) }, "pending");
      }
      for (const t of this.store.tickets.values()) if (t.state === "pending" && !open.has(t.ticket)) this.upsertTicket(t, "closed");
      // Keep the most recent 10,000 tickets.
      if (this.store.tickets.size > 10_000) {
        const old = [...this.store.tickets.values()].sort((a, b) => a.createdAt - b.createdAt).slice(0, this.store.tickets.size - 10_000);
        for (const t of old) this.store.tickets.delete(t.ticket);
      }
    });
  }

  // ---- Transactions -------------------------------------------------------------------------------------------

  /**
   * Reads the program's transactions newer than the last ones processed (at most `max`, newest first from the RPC,
   * paged by `before`) and applies them oldest first. On any failure nothing moves the cursor, so the next cycle
   * retries; already-applied transactions are skipped by signature.
   */
  async pollTransactions(max = 1000): Promise<number> {
    let applied = 0;
    await this.exclusive("poll", async () => {
      const collected: SignatureInfo[] = [];
      const until = this.newestSignature ?? undefined;
      let before: string | undefined;
      let reachedEnd = false;
      while (collected.length < max) {
        const limit = Math.min(1000, max - collected.length);
        const batch = await this.rpc.getSignaturesForAddress(this.programId, { limit, ...(before ? { before } : {}), ...(until ? { until } : {}) });
        collected.push(...batch);
        if (batch.length < limit) {
          reachedEnd = true;
          break;
        }
        before = batch[batch.length - 1].signature;
      }
      const todo = collected.filter((s) => !s.err && !this.store.hasSeen(s.signature)).reverse();
      for (let i = 0; i < todo.length; i += 8) {
        const txs = await Promise.all(todo.slice(i, i + 8).map((s) => this.rpc.getTransaction(s.signature)));
        txs.forEach((tx, j) => {
          const sig = todo[i + j];
          if (tx && !tx.err) {
            this.ingest(sig.signature, tx.logs);
            applied++;
          } else this.store.markSeen(sig.signature);
        });
      }
      for (const s of collected) if (s.err) this.store.markSeen(s.signature);
      if (collected.length) this.newestSignature = collected[0].signature;
      // The first pass read back to the program's first transaction: every coin's history is complete.
      if (!until && reachedEnd) for (const mint of this.store.coins.keys()) this.store.fullHistory.add(mint);
    });
    return applied;
  }

  /** Applies one successful transaction's program events (from the poller or the websocket, whichever is first). */
  ingest(signature: string, logs: readonly string[]): void {
    if (!this.store.markSeen(signature)) return;
    const events = eventsFromLogs(logs, this.programId);
    events.forEach((ev, index) => {
      const d = ev.data;
      switch (ev.name) {
        case "TradeEvent":
          return this.applyTrade(signature, index, d);
        case "TokenCreated":
          return this.applyCreated(d);
        case "LaunchRequested":
          return this.upsertTicket(
            { ticket: d.ticket as string, payer: d.payer as string, ticker: d.ticker as string, depositLamports: d.deposit_lamports as bigint, createdAt: this.nowSec(), expiresAt: Number(d.expires_at) },
            "pending",
          );
        case "TicketRefunded": {
          const t = this.store.tickets.get(d.ticket as string);
          return this.upsertTicket(t ?? { ticket: d.ticket as string, payer: d.payer as string, ticker: "", depositLamports: d.lamports as bigint, createdAt: 0, expiresAt: 0 }, "refunded");
        }
        case "GraduationReady":
          return this.patch(d.mint as string, (c) => {
            c.complete = true;
          });
        case "MigratedToRaydium":
          return this.patch(d.mint as string, (c) => {
            c.complete = true;
            c.migrated = true;
            c.raydiumPool = d.pool as string;
          });
        case "DexEscrowReleased":
          return this.patch(d.mint as string, (c) => {
            c.escrowReleased = true;
          });
      }
    });
  }

  private patch(mint: string, f: (c: CoinRecord) => void) {
    const c = this.store.coins.get(mint);
    if (!c) return this.background(this.coin(mint));
    f(c);
    this.emit("coin", mint);
  }

  private applyCreated(d: Decoded) {
    const mint = d.mint as string;
    const { coin } = this.upsertCurve(
      d.bonding_curve as string,
      {
        mint,
        creator: d.creator,
        created_slot: d.created_slot,
        trading_open_slot: d.trading_open_slot,
        launch_timestamp: d.launch_timestamp,
        token_total_supply: d.token_total_supply,
        virtual_token_reserves: d.virtual_token_reserves,
        virtual_sol_reserves: d.virtual_sol_reserves,
        real_token_reserves: d.real_token_reserves,
        real_sol_reserves: 0n,
        complete: false,
        migrated: false,
        escrow_released: false,
        escrow_accrued: 0n,
        raydium_pool: DEFAULT_PUBKEY,
      },
      Number(d.created_slot),
    );
    coin.ticket = d.ticket as string;
    coin.name = (d.name as string).slice(0, 64);
    coin.symbol = (d.symbol as string).slice(0, 16);
    coin.uri = (d.uri as string).slice(0, 512);
    coin.initialRealToken = d.real_token_reserves as bigint;
    coin.initialPriceSol = priceSol(d.virtual_token_reserves as bigint, d.virtual_sol_reserves as bigint);
    coin.tweetLocked = d.tweet_id_hash !== null;
    // Seen from its creation on: every later trade is indexed too (the poller fills anything the websocket misses).
    this.store.fullHistory.add(mint);
    const ticket = this.store.tickets.get(d.ticket as string);
    this.upsertTicket(ticket ?? { ticket: d.ticket as string, payer: d.creator as string, ticker: d.symbol as string, depositLamports: 0n, createdAt: Number(d.launch_timestamp), expiresAt: 0 }, "created", mint);
    this.emit("coin", mint);
    this.background(this.loadMetadataJson());
  }

  private applyTrade(signature: string, index: number, d: Decoded) {
    const mint = d.mint as string;
    const t: TradeRecord = {
      signature,
      index,
      mint,
      user: d.user as string,
      isBuy: d.is_buy as boolean,
      tokenAmount: d.token_amount as bigint,
      solAmount: d.sol_amount as bigint,
      fee: d.fee as bigint,
      slot: Number(d.slot),
      timestamp: Number(d.timestamp),
      virtualToken: d.virtual_token_reserves as bigint,
      virtualSol: d.virtual_sol_reserves as bigint,
      realToken: d.real_token_reserves as bigint,
      realSol: d.real_sol_reserves as bigint,
    };
    if (!this.store.addTrade(t)) return;
    const c = this.store.coins.get(mint);
    if (c && t.slot >= c.reservesSlot) {
      c.virtualToken = t.virtualToken;
      c.virtualSol = t.virtualSol;
      c.realToken = t.realToken;
      c.realSol = t.realSol;
      c.reservesSlot = t.slot;
      if (t.realToken === 0n) c.complete = true;
      c.athMcapSol = Math.max(c.athMcapSol, mcapOf(c));
    }
    this.portfolioCache.delete(t.user);
    this.holderCache.delete(mint);
    this.emit("trade", t);
    if (!c) this.background(this.coin(mint));
    else this.emit("coin", mint);
  }

  // ---- On demand ----------------------------------------------------------------------------------------------

  /**
   * The coin for `mint`: from the index, or straight from the chain when it isn't indexed yet (created since the last
   * poll). A mint with no Parabull curve is remembered as missing for 5 seconds (short: a coin created moments ago
   * may not be visible to this RPC yet, and the app asks again).
   */
  async coin(mint: string): Promise<CoinRecord | null> {
    const known = this.store.coins.get(mint);
    if (known) return known;
    if ((this.missing.get(mint) ?? 0) > this.now()) return null;
    const pending = this.lookups.get(mint);
    if (pending) return pending;
    const lookup = (async () => {
      const curve = (await bondingCurveAddress(mint, this.programId)).address;
      const { slot, accounts } = await this.rpc.getMultipleAccounts([curve, mint]);
      const [ca, ma] = accounts;
      const decoded = ca && ca.owner === this.programId ? decodeAccount<Decoded>("BondingCurve", ca.data) : null;
      if (!decoded || decoded.mint !== mint) {
        if (this.missing.size > 10_000) this.missing.clear();
        this.missing.set(mint, this.now() + 5_000);
        return null;
      }
      const { coin } = this.upsertCurve(curve, decoded, slot);
      const meta = ma && ma.owner === TOKEN_2022_PROGRAM_ID ? parseMint(ma.data)?.metadata : null;
      if (meta && !coin.name) {
        coin.name = meta.name.slice(0, 64);
        coin.symbol = meta.symbol.slice(0, 16);
        coin.uri = meta.uri.slice(0, 512);
      }
      this.emit("coin", mint);
      this.background(this.loadMetadataJson());
      return coin;
    })().finally(() => this.lookups.delete(mint));
    this.lookups.set(mint, lookup);
    return lookup;
  }

  private cached<T>(cache: Map<string, Cached<T>>, key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const hit = cache.get(key);
    if (hit?.value !== undefined && this.now() - hit.at < ttlMs) return Promise.resolve(hit.value);
    if (hit?.inflight) return hit.inflight;
    const inflight = load()
      .then((value) => {
        if (cache.size > 5_000) cache.clear();
        cache.set(key, { at: this.now(), value });
        return value;
      })
      .catch((e) => {
        cache.delete(key);
        throw e;
      });
    cache.set(key, { at: hit?.at ?? 0, value: hit?.value, inflight });
    return inflight;
  }

  /** Token-2022 balances of `mint`, largest first, labelled where the owner is a protocol account. */
  async holders(mint: string, limit = 100): Promise<HoldersResult | null> {
    const coin = await this.coin(mint);
    if (!coin) return null;
    const all = await this.cached(this.holderCache, mint, this.opts.holdersTtlMs ?? 20_000, async () => {
      const { accounts } = await this.rpc.getProgramAccounts(TOKEN_2022_PROGRAM_ID, [{ memcmp: { offset: 0, bytes: mint } }], { offset: 32, length: 40 });
      const balances = new Map<string, bigint>();
      for (const a of accounts) {
        const oa = parseOwnerAmount(a.data);
        if (oa && oa.amount > 0n) balances.set(oa.owner, (balances.get(oa.owner) ?? 0n) + oa.amount);
      }
      const labels = await this.labels(coin);
      const rows: HolderJson[] = [...balances]
        .sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0))
        .map(([owner, amount]) => ({ owner, amount: String(amount), pct: Number(amount) / Number(coin.totalSupply), label: labels.get(owner) ?? null }));
      const count = rows.filter((r) => !r.label || r.label === "creator").length;
      if (count !== coin.holderCount) {
        coin.holderCount = count;
        this.emit("coin", mint);
      }
      return { mint, totalSupply: String(coin.totalSupply), count: rows.length, holders: rows };
    });
    return { ...all, holders: all.holders.slice(0, Math.max(1, Math.min(limit, 100))) };
  }

  private async labels(c: CoinRecord): Promise<Map<string, HolderLabel>> {
    const out = new Map<string, HolderLabel>();
    out.set(c.creator, "creator");
    out.set(c.curve, "bonding_curve");
    out.set(await this.pda([enc("migration-authority"), base58Decode(c.mint)!], this.programId, `migration:${c.mint}`), "migration");
    if (this.global) out.set(await this.pda([enc("vault_and_lp_mint_auth_seed")], this.global.cpmmProgram, "cpmm-authority"), "raydium_pool");
    return out;
  }

  /**
   * Holder counts for the board, without anyone opening a coin: coins with no count yet, then the most recently
   * traded, up to `max` per run (one getProgramAccounts each, in sequence to keep the RPC load flat).
   */
  async syncHolderCounts(max = 25): Promise<void> {
    await this.exclusive("holders", async () => {
      const lastTrade = (c: CoinRecord) => this.store.trades(c.mint)[0]?.timestamp ?? 0;
      const order = [...this.store.coins.values()].sort((a, b) => Number(b.holderCount === null) - Number(a.holderCount === null) || lastTrade(b) - lastTrade(a));
      for (const c of order.slice(0, max)) await this.holders(c.mint).catch(() => undefined);
    });
  }

  /** The wallet's SOL and its Parabull coin balances (coins the index knows, or finds on demand: at most 25 lookups). */
  async portfolio(wallet: string): Promise<PortfolioResult> {
    return this.cached(this.portfolioCache, wallet, this.opts.portfolioTtlMs ?? 10_000, async () => {
      const [accounts, lamports] = await Promise.all([this.rpc.getTokenAccountsByOwner(wallet, TOKEN_2022_PROGRAM_ID), this.rpc.getBalance(wallet)]);
      const balances = new Map<string, bigint>();
      for (const a of accounts) {
        const t = parseTokenAccount(a.data);
        if (t && t.amount > 0n) balances.set(t.mint, (balances.get(t.mint) ?? 0n) + t.amount);
      }
      let lookups = 0;
      const holdings: PortfolioResult["holdings"] = [];
      for (const [mint, amount] of balances) {
        let coin = this.store.coins.get(mint) ?? null;
        if (!coin && lookups < 25) {
          lookups++;
          coin = await this.coin(mint);
        }
        if (!coin) continue;
        const price = coin.migrated && coin.poolPriceSol !== null ? coin.poolPriceSol : priceSol(coin.virtualToken, coin.virtualSol);
        holdings.push({ mint, amount: String(amount), valueSol: (Number(amount) / 1e6) * price });
      }
      holdings.sort((a, b) => b.valueSol - a.valueSol);
      return { wallet, lamports: String(lamports), holdings };
    });
  }

  // ---- Running ------------------------------------------------------------------------------------------------

  /** First load: Global, every curve and ticket, then the backfill. */
  async start(): Promise<void> {
    await this.syncGlobal();
    await this.syncCurves();
    await this.syncTickets();
    const n = await this.pollTransactions(this.opts.backfillLimit ?? 1000);
    await this.syncHolderCounts();
    this.log(`indexed ${this.store.coins.size} coins, ${this.store.tickets.size} tickets, ${n} transactions`);
  }

  /**
   * logsSubscribe over the RPC websocket, reconnecting with backoff. Returns a stop function. Notifications of failed
   * transactions are ignored; the poller sees every transaction anyway, so a dropped socket loses only latency.
   */
  subscribe(wsUrl: string, WebSocketImpl: typeof WebSocket = WebSocket): () => void {
    let ws: WebSocket | null = null;
    let stopped = false;
    let delay = 1_000;
    const connect = () => {
      if (stopped) return;
      ws = new WebSocketImpl(wsUrl);
      ws.addEventListener("open", () => {
        delay = 1_000;
        ws!.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "logsSubscribe", params: [{ mentions: [this.programId] }, { commitment: "confirmed" }] }));
      });
      ws.addEventListener("message", (e) => {
        try {
          const msg = JSON.parse(String(e.data)) as { method?: string; params?: { result?: { value?: { signature: string; err: unknown; logs: string[] } } } };
          const v = msg.method === "logsNotification" ? msg.params?.result?.value : undefined;
          if (v && !v.err && Array.isArray(v.logs)) this.ingest(v.signature, v.logs);
        } catch {
          // ignore malformed frames
        }
      });
      ws.addEventListener("close", () => {
        if (stopped) return;
        this.log(`logsSubscribe closed; reconnecting in ${delay} ms`);
        setTimeout(connect, delay);
        delay = Math.min(delay * 2, 30_000);
      });
      ws.addEventListener("error", () => ws?.close());
    };
    connect();
    return () => {
      stopped = true;
      ws?.close();
    };
  }
}

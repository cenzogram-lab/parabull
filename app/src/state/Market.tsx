/**
 * Market data for the views, from one of two sources (same MarketState either way):
 * - Demo mode (VITE_PARABULL_MODE=demo, the default): the seeded dataset and a light live simulation (trades move
 *   reserves through the real curve math); `?live=0` freezes it. Demo trades and launches update this store only.
 * - Chain mode: the Parabull indexer (VITE_INDEXER_URL, services/parabull-indexer): real curves, trades, holders and
 *   the connected wallet's positions, kept live by its /stream websocket. Chain mode never shows demo coins: without
 *   an indexer the market is empty and says so (source "unconfigured"). Callouts come from the edge Worker
 *   (src/state/callouts.ts); traders, squads and streams have no on-chain source yet and are empty in chain mode.
 */
import { useWallet } from "@solana/wallet-adapter-react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CONFIG, isDemo } from "../config";
import { coinArt } from "../lib/art";
import { IndexerClient, positionsFrom, toCoin, toHolders, toTrade, type CandleJson, type CoinJson, type HoldersJson, type PortfolioJson, type TradeJson } from "../lib/indexer";
import { PROTOCOL, initialReserves, mcapSol, priceSol } from "../lib/protocol";
import { applyBuy, applySell, quoteBuyWithSol, quoteSellTokens } from "../lib/quote";
import { Rng } from "../lib/rng";
import type { Callout, Coin, Holder, Squad, Stream, Trade, Trader } from "../lib/types";
import { HANDLES } from "../mock/catalog";
import { address, generateCoins, progressOf, SOL_USD } from "../mock/coins";
import { fakeSignature, tradeHistory } from "../mock/market";
import type { ClosedPosition } from "../mock/portfolio";
import { useProtocol } from "./Protocol";
import { generateCallouts, generateSquads, generateStreams, generateTraders } from "../mock/social";
import { useChainCallouts, useDemoCallouts, type CalloutFeed } from "./callouts";

const SUPPLY_TOKENS = Number(PROTOCOL.totalSupply) / 1e6;
const FEE_BPS = PROTOCOL.platformFeeBps;

export interface Position {
  /** Token base units held. */
  tokens: bigint;
  /** Cost the desktop info strip measures PnL against: the seeded holdings at 0.62x their price, as before the phone layout. */
  costUsd: number;
  /** Cost the portfolio shows: each seeded holding was bought at its own price (0.55x to 1.35x today's), so some are up and some are down. Demo trades move it like costUsd. */
  basisUsd: number;
}

export interface LaunchDraft {
  name: string;
  ticker: string;
  description: string;
  image: string | null;
  tweetId: string | null;
  socials: Coin["socials"];
}

/** Where a coin page stands: shown, being fetched, not a Parabull coin, the indexer failed, or no indexer configured. */
export type CoinState = "ready" | "loading" | "missing" | "error" | "unconfigured";

interface MarketState extends CalloutFeed {
  /** Where the data comes from. */
  source: "demo" | "indexer" | "unconfigured";
  /** A coin page's state; call watchCoin(mint) to start loading it. */
  coinState: (mint: string) => CoinState;
  /** Loads a coin (even one newer than the list), its trades and holders. Demo mode: nothing to do. */
  watchCoin: (mint: string) => void;
  /** On-chain holders once loaded (chain mode); null in demo mode, where the views use the seeded holders. */
  holdersFor: (mint: string) => Holder[] | null;
  /** Re-reads the wallet's positions (after a trade). */
  refreshPositions: () => void;
  /** Chain mode: the indexer's chart bars for a coin (every trade it holds). Demo mode: null (the chart generates its own). */
  fetchCandles: (mint: string, intervalSec: number) => Promise<CandleJson[] | null>;
  coins: Coin[];
  byMint: Map<string, Coin>;
  liveTrades: Trade[];
  tradesFor: (mint: string) => Trade[];
  traders: Trader[];
  squads: Squad[];
  callouts: Callout[];
  streams: Stream[];
  solUsd: number;
  positions: Record<string, Position>;
  /** The demo holdings the session started with, before any demo trade: the portfolio's 24h baseline. */
  startPositions: Record<string, Position>;
  /** Net SOL your demo trades moved (negative after buys, positive after sells), for the portfolio's cash. */
  demoSolDelta: number;
  /** What each demo sell realized, newest first (the portfolio's Closed list and realized PnL). */
  demoClosed: ClosedPosition[];
  /** Demo trades you placed this visit. */
  demoTradeCount: number;
  /** Traders (by handle) and squads (`squad:<name>`) you follow; the demo starts with the eight top traders. Kept for the visit. */
  following: Set<string>;
  toggleFollow: (key: string) => void;
  demoTrade: (mint: string, side: "buy" | "sell", amount: bigint, slippageBps: bigint) => Trade | null;
  demoLaunch: (draft: LaunchDraft, creator: string) => Coin;
}

const Ctx = createContext<MarketState | null>(null);

/**
 * Selling `tokens` of a graduated coin. On Raydium a trade moves the price by its weight against 5% of the market
 * cap: a buy lifts it by the USD it spends and fills at the price before it. A sale is that buy in reverse: the price
 * falls to where buying the tokens back would start, so it stays above zero, and the sale pays what that buy would
 * cost, less the 1% fee. Buying and then selling what you bought returns the stake less 1%, at the starting price.
 */
export function raydiumSell(c: Pick<Coin, "priceUsd" | "mcapUsd">, tokens: number): { usd: number; priceUsd: number } {
  const priceUsd = c.priceUsd / (1 + (tokens * c.priceUsd) / Math.max(c.mcapUsd * 0.05, 1));
  return { usd: tokens * priceUsd * 0.99, priceUsd };
}

/** Recompute the derived numbers after a curve trade. */
function reprice(c: Coin, reserves: Coin["reserves"]): Coin {
  const priceUsd = priceSol(reserves) * SOL_USD;
  const mcapUsd = mcapSol(reserves) * SOL_USD;
  const spark = [...c.spark.slice(1), priceUsd];
  const progress = progressOf({ ...c, reserves, progress: undefined, complete: reserves.realToken === 0n });
  return {
    ...c,
    reserves,
    priceUsd,
    mcapUsd,
    athUsd: Math.max(c.athUsd, mcapUsd),
    spark,
    // Demo coins always have changes; the ?? only satisfies the shared (nullable) type.
    change24h: (1 + (c.change24h ?? 0)) * (priceUsd / c.priceUsd) - 1,
    change1h: (1 + (c.change1h ?? 0)) * (priceUsd / c.priceUsd) - 1,
    change6h: (1 + (c.change6h ?? 0)) * (priceUsd / c.priceUsd) - 1,
    stage: c.stage === "new" ? "new" : progress >= 0.72 ? "soon" : "live",
    complete: reserves.realToken === 0n,
  };
}

export function MarketProvider({ children }: { children: ReactNode }) {
  return isDemo ? <DemoMarketProvider>{children}</DemoMarketProvider> : <IndexerMarketProvider>{children}</IndexerMarketProvider>;
}

function DemoMarketProvider({ children }: { children: ReactNode }) {
  // SOL/USD for display: the live feed in chain mode (Protocol polls it), the demo price in demo mode. The seeded demo
  // data and its simulation stay priced at SOL_USD, the price they were generated with.
  const solUsd = useProtocol().solUsd.price;
  const [coins, setCoins] = useState<Coin[]>(() => generateCoins());
  const [liveTrades, setLiveTrades] = useState<Trade[]>([]);
  const historyCache = useRef(new Map<string, Trade[]>());
  const initial = useRef(coins);
  const [startPositions] = useState<Record<string, Position>>(() => {
    // A few demo holdings so the sell side and PnL have something to show (see Position for the two costs).
    const p: Record<string, Position> = {};
    for (const c of initial.current.filter((x) => !x.migrated).slice(0, 6)) {
      const value = 4_200_000 * c.priceUsd;
      p[c.mint] = { tokens: 4_200_000_000_000n, costUsd: value * 0.62, basisUsd: value * new Rng(`entry:${c.mint}`).range(0.55, 1.35) };
    }
    return p;
  });
  const [positions, setPositions] = useState(startPositions);
  // demoTrade reads and writes this, so back-to-back trades never start from a stale position.
  const positionsRef = useRef(startPositions);
  const [demoSolDelta, setDemoSolDelta] = useState(0);
  const [demoClosed, setDemoClosed] = useState<ClosedPosition[]>([]);
  const [demoTradeCount, setDemoTradeCount] = useState(0);

  const social = useMemo(() => {
    const traders = generateTraders(initial.current);
    return { traders, squads: generateSquads(traders), callouts: generateCallouts(initial.current), streams: generateStreams(initial.current) };
  }, []);
  const [following, setFollowing] = useState(() => new Set(social.traders.slice(0, 8).map((t) => t.handle)));
  const toggleFollow = useCallback(
    (key: string) =>
      setFollowing((s) => {
        const next = new Set(s);
        if (!next.delete(key)) next.add(key);
        return next;
      }),
    [],
  );

  const byMint = useMemo(() => new Map(coins.map((c) => [c.mint, c])), [coins]);
  const calloutFeed = useDemoCallouts(social.callouts, byMint);

  const tradesFor = useCallback(
    (mint: string) => {
      const coin = byMint.get(mint);
      if (!coin) return [];
      let hist = historyCache.current.get(mint);
      if (!hist) {
        hist = tradeHistory(coin, 60);
        historyCache.current.set(mint, hist);
      }
      return [...liveTrades.filter((t) => t.mint === mint), ...hist];
    },
    [byMint, liveTrades],
  );

  const pushTrade = useCallback((t: Trade, next: Coin) => {
    setCoins((cs) => cs.map((c) => (c.mint === next.mint ? next : c)));
    setLiveTrades((ts) => [t, ...ts].slice(0, 400));
  }, []);

  /** One trade on a coin; curve coins move through the real quote math. */
  const applyTrade = useCallback((c: Coin, side: "buy" | "sell", amount: bigint, slippageBps: bigint, handle: string, rng: Rng): { coin: Coin; trade: Trade } | null => {
    let next: Coin;
    let solAmt: number;
    let tokenAmt: number;
    if (c.migrated) {
      // Graduated coins trade on Raydium (see raydiumSell). A buy spends `amount` lamports at the pool price and
      // lifts it by the trade's weight; a sell sells `amount` token base units as that buy in reverse.
      let priceUsd: number;
      if (side === "buy") {
        solAmt = Number(amount) / 1e9;
        tokenAmt = (solAmt * SOL_USD) / c.priceUsd;
        priceUsd = c.priceUsd * (1 + (solAmt * SOL_USD) / Math.max(c.mcapUsd * 0.05, 1));
      } else {
        tokenAmt = Number(amount) / 1e6;
        const sale = raydiumSell(c, tokenAmt);
        solAmt = sale.usd / SOL_USD;
        priceUsd = sale.priceUsd;
      }
      next = { ...c, priceUsd, mcapUsd: priceUsd * SUPPLY_TOKENS, athUsd: Math.max(c.athUsd, priceUsd * SUPPLY_TOKENS), spark: [...c.spark.slice(1), priceUsd] };
    } else if (side === "buy") {
      const q = quoteBuyWithSol(c.reserves, amount, FEE_BPS, slippageBps);
      if (!q) return null;
      next = reprice(c, applyBuy(c.reserves, q.tokens, q.solCost));
      solAmt = Number(q.total) / 1e9;
      tokenAmt = Number(q.tokens) / 1e6;
    } else {
      const q = quoteSellTokens(c.reserves, amount, FEE_BPS, slippageBps);
      if (!q) return null;
      next = reprice(c, applySell(c.reserves, amount, q.solGross));
      solAmt = Number(q.solNet) / 1e9;
      tokenAmt = Number(amount) / 1e6;
    }
    const usdAmt = solAmt * SOL_USD;
    next = {
      ...next,
      vol24hUsd: c.vol24hUsd + usdAmt,
      buyVolUsd: c.buyVolUsd + (side === "buy" ? usdAmt : 0),
      sellVolUsd: c.sellVolUsd + (side === "sell" ? usdAmt : 0),
      buys24h: c.buys24h + (side === "buy" ? 1 : 0),
      sells24h: c.sells24h + (side === "sell" ? 1 : 0),
      escrowUsd: c.escrowReleased ? c.escrowUsd : Math.min(PROTOCOL.dexListingUsd, c.escrowUsd + usdAmt * 0.01),
    };
    const trade: Trade = {
      id: `live-${Date.now()}-${rng.int(0, 1e9)}`,
      mint: c.mint,
      side,
      trader: address(rng),
      handle,
      sol: solAmt,
      tokens: tokenAmt,
      priceUsd: next.priceUsd,
      mcapUsd: next.mcapUsd,
      ts: Date.now(),
      sig: fakeSignature(rng),
    };
    return { coin: next, trade };
  }, []);

  // Live simulation.
  const coinsRef = useRef(coins);
  useEffect(() => {
    coinsRef.current = coins;
  }, [coins]);
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("live") === "0") return;
    const rng = new Rng(`sim:${Date.now()}`);
    const id = window.setInterval(() => {
      const cs = coinsRef.current.filter((c) => !c.complete || c.migrated);
      const weighted = cs.filter((c) => c.stage === "soon" || c.stage === "new" || rng.bool(0.35));
      const c = rng.pick(weighted.length ? weighted : cs);
      const buyShare = c.buyVolUsd / (c.buyVolUsd + c.sellVolUsd);
      const side = rng.bool(buyShare) ? "buy" : "sell";
      const lamports = BigInt(Math.round(rng.logRange(0.03, 2.5) * 1e9));
      // Sells pass token base units: on Raydium, that SOL's worth at the pool price.
      const amount =
        side === "buy" ? lamports : c.migrated ? BigInt(Math.round(((Number(lamports) / 1e9) * SOL_USD * 1e6) / c.priceUsd)) : BigInt(Math.round(Number(c.reserves.virtualToken) * rng.range(0.0005, 0.004)));
      const r = applyTrade(c, side, amount, 500n, HANDLES[rng.int(0, HANDLES.length - 1)][0], rng);
      if (r) pushTrade(r.trade, r.coin);
    }, 2600);
    return () => window.clearInterval(id);
  }, [applyTrade, pushTrade]);

  const demoTrade = useCallback(
    (mint: string, side: "buy" | "sell", amount: bigint, slippageBps: bigint) => {
      const c = coinsRef.current.find((x) => x.mint === mint);
      if (!c) return null;
      const r = applyTrade(c, side, amount, slippageBps, "you", new Rng(`you:${Date.now()}`));
      if (!r) return null;
      pushTrade(r.trade, r.coin);
      const delta = BigInt(Math.round(r.trade.tokens * 1e6));
      const usdAmt = r.trade.sol * SOL_USD;
      const cur = positionsRef.current[mint] ?? { tokens: 0n, costUsd: 0, basisUsd: 0 };
      const tokens = side === "buy" ? cur.tokens + delta : cur.tokens > delta ? cur.tokens - delta : 0n;
      // A buy adds what it cost; a sell keeps the cost of the tokens still held.
      const kept = Number(tokens) / Math.max(1, Number(cur.tokens));
      const next: Position = side === "buy" ? { tokens, costUsd: cur.costUsd + usdAmt, basisUsd: cur.basisUsd + usdAmt } : { tokens, costUsd: cur.costUsd * kept, basisUsd: cur.basisUsd * kept };
      positionsRef.current = { ...positionsRef.current, [mint]: next };
      setPositions(positionsRef.current);
      if (side === "sell") {
        // The sold tokens' share of the cost against what they paid out.
        const entryUsd = cur.basisUsd - next.basisUsd;
        const pnlUsd = usdAmt - entryUsd;
        const lot: ClosedPosition = { mint, tokens: Number(cur.tokens - tokens) / 1e6, entryUsd, exitUsd: usdAmt, pnlUsd, pnlPct: entryUsd > 0 ? pnlUsd / entryUsd : 0, closedAt: r.trade.ts };
        setDemoClosed((cs) => [lot, ...cs]);
      }
      // A buy's `sol` includes the fee; a sell's is the net payout.
      setDemoSolDelta((d) => d + (side === "buy" ? -r.trade.sol : r.trade.sol));
      setDemoTradeCount((n) => n + 1);
      return r.trade;
    },
    [applyTrade, pushTrade],
  );

  const demoLaunch = useCallback((d: LaunchDraft, creator: string) => {
    const rng = new Rng(`launch:${d.ticker}:${Date.now()}`);
    const mint = address(rng);
    const reserves = initialReserves();
    const now = Date.now();
    const lock = now + PROTOCOL.registryLockSeconds * 1000;
    const priceUsd = priceSol(reserves) * SOL_USD;
    const coin: Coin = {
      mint,
      name: d.name,
      ticker: d.ticker,
      image: d.image ?? coinArt(mint, d.ticker),
      description: d.description,
      creator,
      creatorHandle: "you",
      createdAt: now,
      stage: "new",
      reserves,
      complete: false,
      migrated: false,
      priceUsd,
      mcapUsd: mcapSol(reserves) * SOL_USD,
      athUsd: mcapSol(reserves) * SOL_USD,
      vol24hUsd: 0,
      buyVolUsd: 0,
      sellVolUsd: 0,
      buys24h: 0,
      sells24h: 0,
      traders24h: 0,
      change1h: 0,
      change6h: 0,
      change24h: 0,
      holders: 1,
      devPct: 0,
      replies: 0,
      locks: { ticker: lock, name: lock, tweet: d.tweetId ? lock : null },
      tweetId: d.tweetId,
      escrowUsd: 0,
      escrowReleased: false,
      spark: Array.from({ length: 48 }, () => priceUsd),
      socials: d.socials,
      hot: false,
    };
    setCoins((cs) => [coin, ...cs]);
    return coin;
  }, []);

  const coinState = useCallback((mint: string): CoinState => (byMint.has(mint) ? "ready" : "missing"), [byMint]);
  const value = useMemo<MarketState>(
    () => ({ source: "demo", coinState, watchCoin: noop, holdersFor: none, refreshPositions: noop, fetchCandles: noCandles, coins, byMint, liveTrades, tradesFor, ...social, ...calloutFeed, solUsd, positions, startPositions, demoSolDelta, demoClosed, demoTradeCount, following, toggleFollow, demoTrade, demoLaunch }),
    [coinState, coins, byMint, liveTrades, tradesFor, social, calloutFeed, solUsd, positions, startPositions, demoSolDelta, demoClosed, demoTradeCount, following, toggleFollow, demoTrade, demoLaunch],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

const noop = () => undefined;
const none = () => null;
const noCandles = () => Promise.resolve(null);
const EMPTY = { traders: [] as Trader[], squads: [] as Squad[], streams: [] as Stream[] };
const tradeKey = (t: TradeJson) => `${t.signature}:${t.index}`;
/** Newest first, one copy of each event. */
function mergeTrades(a: TradeJson[], b: TradeJson[] = []): TradeJson[] {
  const seen = new Set<string>();
  return [...a, ...b].filter((t) => !seen.has(tradeKey(t)) && !!seen.add(tradeKey(t))).sort((x, y) => y.slot - x.slot || y.timestamp - x.timestamp);
}

/** Chain mode: everything from the indexer, refreshed by its push stream. */
function IndexerMarketProvider({ children }: { children: ReactNode }) {
  const protocol = useProtocol();
  const solUsd = protocol.solUsd.price;
  const lockSeconds = protocol.params.registryLockSeconds;
  const client = useMemo(() => (CONFIG.indexerUrl ? new IndexerClient(CONFIG.indexerUrl) : null), []);
  const { publicKey } = useWallet();
  const wallet = publicKey?.toBase58() ?? null;
  const walletRef = useRef(wallet);
  walletRef.current = wallet;

  const [raw, setRaw] = useState<Map<string, CoinJson>>(() => new Map());
  const rawRef = useRef(raw);
  rawRef.current = raw;
  const [rawTrades, setRawTrades] = useState<Map<string, TradeJson[]>>(() => new Map());
  const [live, setLive] = useState<TradeJson[]>([]);
  const [rawHolders, setRawHolders] = useState<Map<string, HoldersJson>>(() => new Map());
  const [states, setStates] = useState<Map<string, CoinState>>(() => new Map());
  const [portfolio, setPortfolio] = useState<PortfolioJson | null>(null);
  const tradesLoaded = useRef(new Set<string>());
  const watched = useRef<string | null>(null);
  const holdersTimer = useRef<number | undefined>(undefined);

  const upsert = useCallback((cs: CoinJson[]) => {
    if (!cs.length) return;
    setRaw((prev) => {
      const next = new Map(prev);
      for (const c of cs) next.set(c.mint, c);
      return next;
    });
  }, []);
  const setState = useCallback((mint: string, st: CoinState | null) => {
    setStates((prev) => {
      const next = new Map(prev);
      if (st) next.set(mint, st);
      else next.delete(mint);
      return next;
    });
  }, []);

  const loadHolders = useCallback(
    (mint: string) => {
      client
        ?.holders(mint)
        .then((h) => setRawHolders((prev) => new Map(prev).set(mint, h)))
        .catch(() => undefined);
    },
    [client],
  );

  const refreshPositions = useCallback(() => {
    const w = walletRef.current;
    if (!client || !w) return;
    client
      .portfolio(w)
      .then((p) => {
        if (walletRef.current !== w) return;
        setPortfolio(p);
        upsert(p.holdings.map((h) => h.coin));
      })
      .catch(() => undefined);
  }, [client, upsert]);

  // The board's list: on load and every 30 s (the stream keeps it current in between).
  useEffect(() => {
    if (!client) return;
    let stop = false;
    const load = () =>
      client
        .coins()
        .then((cs) => !stop && upsert(cs))
        .catch(() => undefined);
    void load();
    const id = window.setInterval(load, 30_000);
    return () => {
      stop = true;
      window.clearInterval(id);
    };
  }, [client, upsert]);

  // Live updates: coin changes, trades (the ticker, the watched coin's tape and holders, your positions). The stream
  // doesn't replay what it missed while disconnected, so a reconnect re-reads the list, the watched coin's trades and
  // holders, and your positions; other coins' trades are refetched when next opened.
  useEffect(() => {
    if (!client) return;
    let connected = false;
    const resync = () => {
      if (!connected) return void (connected = true);
      client
        .coins()
        .then(upsert)
        .catch(() => undefined);
      const mint = watched.current;
      tradesLoaded.current = new Set(mint ? [mint] : []);
      if (mint)
        client
          .trades(mint)
          .then((ts) => setRawTrades((prev) => new Map([[mint, mergeTrades(ts, prev.get(mint))]])))
          .catch(() => undefined);
      if (mint) loadHolders(mint);
      refreshPositions();
    };
    return client.stream((m) => {
      if (m.type === "coin") return upsert([m.coin]);
      if (m.type !== "trade") return;
      const t = m.trade;
      setLive((ts) => (ts.some((x) => tradeKey(x) === tradeKey(t)) ? ts : [t, ...ts].slice(0, 400)));
      if (tradesLoaded.current.has(t.mint)) setRawTrades((prev) => new Map(prev).set(t.mint, mergeTrades([t], prev.get(t.mint)).slice(0, 300)));
      if (t.user === walletRef.current) refreshPositions();
      if (t.mint === watched.current) {
        window.clearTimeout(holdersTimer.current);
        holdersTimer.current = window.setTimeout(() => loadHolders(t.mint), 3_000);
      }
    }, resync);
  }, [client, upsert, refreshPositions, loadHolders]);

  // The connected wallet's positions: on connect and every 30 s.
  useEffect(() => {
    setPortfolio(null);
    if (!wallet) return;
    refreshPositions();
    const id = window.setInterval(refreshPositions, 30_000);
    return () => window.clearInterval(id);
  }, [wallet, refreshPositions]);

  const watchCoin = useCallback(
    (mint: string) => {
      if (!client || !mint) return;
      watched.current = mint;
      if (!rawRef.current.has(mint)) {
        setState(mint, "loading");
        // A coin created moments ago may not be visible to the indexer's RPC yet: ask again before calling it missing.
        const attempt = (n: number) =>
          client
            .coin(mint)
            .then((c) => {
              if (c) {
                upsert([c]);
                setState(mint, null);
              } else if (n < 3) window.setTimeout(() => void attempt(n + 1), 2_000 * n);
              else setState(mint, "missing");
            })
            .catch(() => setState(mint, "error"));
        void attempt(1);
      }
      if (!tradesLoaded.current.has(mint)) {
        tradesLoaded.current.add(mint);
        client
          .trades(mint)
          .then((ts) => setRawTrades((prev) => new Map(prev).set(mint, mergeTrades(ts, prev.get(mint)))))
          .catch(() => tradesLoaded.current.delete(mint));
      }
      loadHolders(mint);
    },
    [client, upsert, setState, loadHolders],
  );

  const coins = useMemo(
    () =>
      [...raw.values()]
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((j) => {
          const c = toCoin(j, solUsd, lockSeconds);
          // The creator's share, once the coin's holders are loaded.
          const dev = rawHolders.get(j.mint)?.holders.find((h) => h.label === "creator");
          return dev ? { ...c, devPct: dev.pct * 100 } : c;
        }),
    [raw, rawHolders, solUsd, lockSeconds],
  );
  const byMint = useMemo(() => new Map(coins.map((c) => [c.mint, c])), [coins]);
  const calloutFeed = useChainCallouts(solUsd);
  const liveTrades = useMemo(() => live.map((t) => toTrade(t, solUsd)), [live, solUsd]);
  const tradesFor = useCallback((mint: string) => (rawTrades.get(mint) ?? []).map((t) => toTrade(t, solUsd)), [rawTrades, solUsd]);
  const holdersFor = useCallback(
    (mint: string) => {
      const h = rawHolders.get(mint);
      const c = byMint.get(mint);
      return h && c ? toHolders(h, c) : null;
    },
    [rawHolders, byMint],
  );
  const coinState = useCallback((mint: string): CoinState => (!client ? "unconfigured" : raw.has(mint) ? "ready" : (states.get(mint) ?? "loading")), [client, raw, states]);
  const positions = useMemo(() => (portfolio ? positionsFrom(portfolio, solUsd) : {}), [portfolio, solUsd]);
  const fetchCandles = useCallback((mint: string, intervalSec: number) => (client ? client.candles(mint, intervalSec) : Promise.resolve(null)), [client]);
  const [following, setFollowing] = useState(() => new Set<string>());
  const toggleFollow = useCallback(
    (key: string) =>
      setFollowing((s) => {
        const next = new Set(s);
        if (!next.delete(key)) next.add(key);
        return next;
      }),
    [],
  );

  const value = useMemo<MarketState>(
    () => ({
      source: client ? "indexer" : "unconfigured",
      coinState,
      watchCoin,
      holdersFor,
      refreshPositions,
      fetchCandles,
      coins,
      byMint,
      liveTrades,
      tradesFor,
      ...EMPTY,
      ...calloutFeed,
      solUsd,
      positions,
      startPositions: positions,
      demoSolDelta: 0,
      demoClosed: [],
      demoTradeCount: 0,
      following,
      toggleFollow,
      demoTrade: () => null,
      demoLaunch: () => {
        throw new Error("demo launches are demo-mode only");
      },
    }),
    [client, coinState, watchCoin, holdersFor, refreshPositions, fetchCandles, coins, byMint, liveTrades, tradesFor, calloutFeed, solUsd, positions, following, toggleFollow],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useMarket(): MarketState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useMarket outside MarketProvider");
  return v;
}

/** A coin page's coin and state; starts loading it in chain mode (a coin newer than the board's list included). */
export function useCoinView(mint: string): { coin: Coin | undefined; state: CoinState } {
  const m = useMarket();
  const { watchCoin } = m;
  useEffect(() => watchCoin(mint), [watchCoin, mint]);
  return { coin: m.byMint.get(mint), state: m.coinState(mint) };
}

/** The leading curve coin closest to graduation: the King of the Bull. */
export const kingOf = (coins: Coin[]) => [...coins].filter((c) => !c.migrated).sort((a, b) => progressOf(b) - progressOf(a))[0];

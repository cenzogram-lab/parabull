/**
 * Market data for the views. Demo mode serves the seeded dataset and runs a
 * light live simulation (trades move reserves through the real curve math);
 * `?live=0` freezes it. Demo trades and launches update this store only.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { coinArt } from "../lib/art";
import { PROTOCOL, initialReserves, mcapSol, priceSol } from "../lib/protocol";
import { applyBuy, applySell, quoteBuyWithSol, quoteSellTokens } from "../lib/quote";
import { Rng } from "../lib/rng";
import type { Callout, Coin, Squad, Stream, Trade, Trader } from "../lib/types";
import { HANDLES } from "../mock/catalog";
import { address, generateCoins, progressOf, SOL_USD } from "../mock/coins";
import { fakeSignature, tradeHistory } from "../mock/market";
import type { ClosedPosition } from "../mock/portfolio";
import { generateCallouts, generateSquads, generateStreams, generateTraders } from "../mock/social";

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

interface MarketState {
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
  const progress = progressOf({ ...c, reserves });
  return {
    ...c,
    reserves,
    priceUsd,
    mcapUsd,
    athUsd: Math.max(c.athUsd, mcapUsd),
    spark,
    change24h: (1 + c.change24h) * (priceUsd / c.priceUsd) - 1,
    change1h: (1 + c.change1h) * (priceUsd / c.priceUsd) - 1,
    change6h: (1 + c.change6h) * (priceUsd / c.priceUsd) - 1,
    stage: c.stage === "new" ? "new" : progress >= 0.72 ? "soon" : "live",
    complete: reserves.realToken === 0n,
  };
}

export function MarketProvider({ children }: { children: ReactNode }) {
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

  const value = useMemo<MarketState>(
    () => ({ coins, byMint, liveTrades, tradesFor, ...social, solUsd: SOL_USD, positions, startPositions, demoSolDelta, demoClosed, demoTradeCount, following, toggleFollow, demoTrade, demoLaunch }),
    [coins, byMint, liveTrades, tradesFor, social, positions, startPositions, demoSolDelta, demoClosed, demoTradeCount, following, toggleFollow, demoTrade, demoLaunch],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useMarket(): MarketState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useMarket outside MarketProvider");
  return v;
}

/** The leading curve coin closest to graduation: the King of the Bull. */
export const kingOf = (coins: Coin[]) => [...coins].filter((c) => !c.migrated).sort((a, b) => progressOf(b) - progressOf(a))[0];

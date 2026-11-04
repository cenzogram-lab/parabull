/**
 * The wallet's portfolio for the mobile header and the Portfolio page: open
 * positions valued at live prices, demo cash, the 24h change, closed
 * positions and the equity curve. Positions come from the market store
 * (demo trades update them); everything else is seeded demo data.
 */
import { useWallet } from "@solana/wallet-adapter-react";
import { useCallback, useMemo, useState } from "react";
import { avatarArt } from "../lib/art";
import type { Coin } from "../lib/types";
import { closedPositions, DEMO_CASH_SOL, equityHistory, positionNote, type ClosedPosition, type PortfolioPeriod, type PositionNote } from "../mock/portfolio";
import { DEMO_WALLET } from "../mock/protocol";
import { useMarket } from "./Market";

export interface Holding {
  coin: Coin;
  /** Token base units (6 decimals). */
  tokens: bigint;
  valueUsd: number;
  costUsd: number;
  /** Unrealized: valueUsd - costUsd. */
  pnlUsd: number;
  /** pnlUsd / costUsd, as a fraction. */
  pnlPct: number;
  /** The coin's 24h change, as a fraction. */
  change24h: number;
  note: PositionNote | null;
}

export interface Portfolio {
  /** Connected wallet, or the demo wallet before one connects. */
  address: string;
  handle: string;
  avatar: string;
  /** Cash plus every holding at the current price. */
  equityUsd: number;
  /** Demo SOL balance: DEMO_CASH_SOL, less demo buys, plus demo sells. */
  cashSol: number;
  cashUsd: number;
  change24hUsd: number;
  /** Fraction of equity 24h ago (-0.078 = -7.8%). */
  change24hPct: number;
  /** Largest position first. */
  holdings: Holding[];
  /** Newest first. */
  closed: ClosedPosition[];
  /** Equity curve for a period, oldest first, ending at `equityUsd`. */
  history: (p: PortfolioPeriod) => { t: number; v: number }[];
}

export function usePortfolio(): Portfolio {
  const { positions, startPositions, byMint, coins, solUsd, demoSolDelta } = useMarket();
  const { publicKey } = useWallet();
  // One clock per mount, so notes, closed positions and the curve keep still.
  const [now] = useState(() => Date.now());
  const [firstCoins] = useState(coins);
  const address = publicKey?.toBase58() ?? DEMO_WALLET.toBase58();
  const avatar = useMemo(() => avatarArt(address, "bronze"), [address]);

  const holdings = useMemo(() => {
    const list: Holding[] = [];
    for (const [mint, p] of Object.entries(positions)) {
      const coin = byMint.get(mint);
      if (!coin || p.tokens <= 0n) continue;
      const valueUsd = (Number(p.tokens) / 1e6) * coin.priceUsd;
      const pnlUsd = valueUsd - p.costUsd;
      let note = positionNote(mint, now);
      // A thesis can't be older than the coin it's about.
      if (note && note.updatedAt < coin.createdAt) note = { ...note, updatedAt: coin.createdAt + (now - coin.createdAt) * 0.4 };
      list.push({ coin, tokens: p.tokens, valueUsd, costUsd: p.costUsd, pnlUsd, pnlPct: p.costUsd > 0 ? pnlUsd / p.costUsd : 0, change24h: coin.change24h, note });
    }
    return list.sort((a, b) => b.valueUsd - a.valueUsd);
  }, [positions, byMint, now]);

  // Demo cash pays for demo buys and receives sells (demo trades aren't capped, so it floors at zero).
  const cashSol = Math.max(0, DEMO_CASH_SOL + demoSolDelta);
  const cashUsd = cashSol * solUsd;
  const equityUsd = cashUsd + holdings.reduce((n, h) => n + h.valueUsd, 0);
  // A day ago you held the session's starting positions, each worth value / (1 + change24h), and the demo cash.
  // Demo trades happened today, so a buy (or sell) only counts for how its price moved since.
  const dayAgoUsd = useMemo(
    () =>
      DEMO_CASH_SOL * solUsd +
      Object.entries(startPositions).reduce((n, [mint, p]) => {
        const coin = byMint.get(mint);
        return coin && coin.change24h > -1 ? n + ((Number(p.tokens) / 1e6) * coin.priceUsd) / (1 + coin.change24h) : n;
      }, 0),
    [startPositions, byMint, solUsd],
  );
  const change24hUsd = equityUsd - dayAgoUsd;
  const change24hPct = dayAgoUsd > 0 ? change24hUsd / dayAgoUsd : 0;

  const closed = useMemo(() => closedPositions(firstCoins, now), [firstCoins, now]);
  const history = useCallback((p: PortfolioPeriod) => equityHistory(equityUsd, change24hPct, p, now), [equityUsd, change24hPct, now]);

  return { address, handle: "you", avatar, equityUsd, cashSol, cashUsd, change24hUsd, change24hPct, holdings, closed, history };
}

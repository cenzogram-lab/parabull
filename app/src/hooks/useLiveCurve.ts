/**
 * A coin's bonding curve read straight from the chain (chain mode): fetched when the coin opens, then kept current by
 * an account subscription, so quotes don't rest on the indexer's possibly stale reserves. Null in demo mode, for a
 * migrated coin, and until the first read lands.
 */
import { useEffect, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { isDemo } from "../config";
import type { Reserves } from "../lib/curve";
import { useParabullProgram } from "./useParabullProgram";

export interface LiveCurve {
  reserves: Reserves;
  complete: boolean;
  migrated: boolean;
  tradingOpenSlot: bigint;
}

interface CurveAccount {
  complete: boolean;
  migrated: boolean;
  virtualTokenReserves: { toString(): string };
  virtualSolReserves: { toString(): string };
  realTokenReserves: { toString(): string };
  realSolReserves: { toString(): string };
  tradingOpenSlot: { toString(): string };
}

export const liveCurveOf = (c: CurveAccount): LiveCurve => ({
  reserves: {
    virtualToken: BigInt(c.virtualTokenReserves.toString()),
    virtualSol: BigInt(c.virtualSolReserves.toString()),
    realToken: BigInt(c.realTokenReserves.toString()),
    realSol: BigInt(c.realSolReserves.toString()),
  },
  complete: c.complete,
  migrated: c.migrated,
  tradingOpenSlot: BigInt(c.tradingOpenSlot.toString()),
});

export function useLiveCurve(mint: string, enabled = true): [LiveCurve | null, (c: LiveCurve) => void] {
  const { program, pdas } = useParabullProgram();
  const [curve, setCurve] = useState<LiveCurve | null>(null);
  useEffect(() => {
    setCurve(null);
    if (isDemo || !enabled) return;
    let key: PublicKey;
    try {
      key = pdas.bondingCurve(new PublicKey(mint));
    } catch {
      return;
    }
    let live = true;
    const connection = program.provider.connection;
    program.account.bondingCurve
      .fetchNullable(key, "confirmed")
      .then((c) => live && c && setCurve(liveCurveOf(c as unknown as CurveAccount)))
      .catch(() => undefined);
    const sub = connection.onAccountChange(
      key,
      (info) => {
        try {
          if (live) setCurve(liveCurveOf(program.coder.accounts.decode("bondingCurve", info.data) as CurveAccount));
        } catch {
          // not a curve account (closed): keep the last read
        }
      },
      { commitment: "confirmed" },
    );
    return () => {
      live = false;
      void connection.removeAccountChangeListener(sub).catch(() => undefined);
    };
  }, [mint, enabled, program, pdas]);
  return [curve, setCurve];
}

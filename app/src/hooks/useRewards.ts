/**
 * Chain mode's reward data from the indexer: a wallet's allocations (GET /rewards/:wallet) and every epoch's totals
 * (GET /rewards). One request per wallet is shared by every view that shows it (the claim panel, the portfolio, the
 * header's notification) and kept 30 seconds; `refresh` (after a claim) refetches it for all of them. Demo mode and a
 * missing VITE_INDEXER_URL return nothing.
 */
import { useCallback, useEffect, useState } from "react";
import { CONFIG, isDemo } from "../config";
import { IndexerClient } from "../lib/indexer";
import type { RewardsSummaryJson, WalletRewardsJson } from "../lib/rewardsClaim";

const client = !isDemo && CONFIG.indexerUrl ? new IndexerClient(CONFIG.indexerUrl) : null;
const TTL_MS = 30_000;
const cache = new Map<string, { at: number; p: Promise<WalletRewardsJson> }>();
const changed = new EventTarget();

function load(wallet: string, force: boolean): Promise<WalletRewardsJson> {
  const hit = cache.get(wallet);
  if (hit && !force && Date.now() - hit.at < TTL_MS) return hit.p;
  const p = client!.rewards(wallet);
  cache.set(wallet, { at: Date.now(), p });
  // A failed request isn't kept: the next view asks again.
  p.catch(() => cache.get(wallet)?.p === p && cache.delete(wallet));
  return p;
}

export interface WalletRewards {
  data: WalletRewardsJson | null;
  error: string | null;
  loading: boolean;
  /** Refetch (after a claim); every view showing this wallet updates. */
  refresh: () => void;
  /** False in demo mode or without an indexer. */
  available: boolean;
}

export function useWalletRewards(wallet: string | null): WalletRewards {
  const [state, setState] = useState<{ wallet: string | null; data: WalletRewardsJson | null; error: string | null }>({ wallet: null, data: null, error: null });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const on = (e: Event) => (e as CustomEvent<string>).detail === wallet && setTick((n) => n + 1);
    changed.addEventListener("refresh", on);
    return () => changed.removeEventListener("refresh", on);
  }, [wallet]);
  useEffect(() => {
    if (!client || !wallet) return;
    let stop = false;
    load(wallet, false).then(
      (data) => !stop && setState({ wallet, data, error: null }),
      (e: Error) => !stop && setState({ wallet, data: null, error: e.message }),
    );
    return () => {
      stop = true;
    };
  }, [wallet, tick]);
  const refresh = useCallback(() => {
    if (!client || !wallet) return;
    load(wallet, true).finally(() => changed.dispatchEvent(new CustomEvent("refresh", { detail: wallet })));
  }, [wallet]);
  const mine = state.wallet === wallet;
  return { data: mine ? state.data : null, error: mine ? state.error : null, loading: !!client && !!wallet && !mine, refresh, available: !!client };
}

/** Every epoch's figures and the totals by kind; null while loading, "error" when the indexer didn't answer. */
export function useRewardsSummary(): RewardsSummaryJson | null | "error" {
  const [s, setS] = useState<RewardsSummaryJson | null | "error">(null);
  useEffect(() => {
    if (!client) return;
    let stop = false;
    client.rewardsSummary().then(
      (v) => !stop && setS(v),
      () => !stop && setS("error"),
    );
    return () => {
      stop = true;
    };
  }, []);
  return s;
}

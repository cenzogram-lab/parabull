/**
 * Shared pieces of the Portfolio page: the chart periods and their time
 * labels, the seeded profile numbers, the wallet actions (copy, deposit,
 * connect, disconnect) and the wallet's holder-reward epochs.
 */
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { PublicKey } from "@solana/web3.js";
import { useCallback, useEffect, useState } from "react";
import { CONFIG } from "../../config";
import { leafHash, verifyProof } from "../../lib/merkle";
import { Rng } from "../../lib/rng";
import { fromHex } from "../../lib/sha256";
import type { PortfolioPeriod } from "../../mock/portfolio";
import { walletEpochs, type DemoEpoch } from "../../mock/protocol";
import { useApp } from "../../state/AppState";

export const PERIODS = ["1D", "1W", "1M", "ALL"] as const satisfies readonly PortfolioPeriod[];

/** "Equity over the past week", "... all time". */
export const PERIOD_LABEL: Record<PortfolioPeriod, string> = { "1D": "past day", "1W": "past week", "1M": "past month", ALL: "all time" };

/** The network a receive address is on, as people say it. */
export const NETWORK_NAME = CONFIG.cluster === "mainnet-beta" ? "Solana mainnet" : CONFIG.cluster === "devnet" ? "Solana devnet" : "your local validator";

const clock = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });
const weekdayClock = new Intl.DateTimeFormat("en-US", { weekday: "short", hour: "numeric", minute: "2-digit" });
const dateHour = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric" });
const fullDate = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });
/** "Oct 21" */
export const shortDate = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });

/** When a chart point was, at the period's resolution: "Today 3:15 PM", "Tue 2:00 PM", "Oct 21, 8 AM", "Aug 6, 2026". */
export function pointTime(t: number, period: PortfolioPeriod, now: number): string {
  if (now - t < 60_000) return "Now";
  if (period === "1D") return `${new Date(t).toDateString() === new Date(now).toDateString() ? "Today" : "Yesterday"} ${clock.format(t)}`;
  if (period === "1W") return weekdayClock.format(t);
  if (period === "1M") return dateHour.format(t);
  return fullDate.format(t);
}

/** Demo social numbers for the profile, seeded by the address so they hold still. */
export function profileCounts(address: string) {
  const rng = new Rng(`profile:${address}`);
  return { following: rng.int(14, 220), followers: Math.round(rng.logRange(90, 6400)), trades: rng.int(64, 260) };
}

/**
 * What the page's buttons do with the wallet. Without a connected wallet the
 * page shows the demo wallet, a placeholder address nobody controls, so the
 * copy and receive paths say so instead of inviting a transfer to it.
 */
export function useWalletActions(address: string) {
  const { publicKey, wallet, disconnect } = useWallet();
  const { setVisible } = useWalletModal();
  const { toast } = useApp();
  const connected = !!publicKey;

  /** Resolves to whether the clipboard took it. */
  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(address);
      return true;
    } catch {
      return false;
    }
  }, [address]);

  const copyAddress = useCallback(async () => {
    const ok = await copy();
    if (!connected) toast({ tone: "info", title: ok ? "Demo wallet address copied" : "Demo wallet address", body: `${ok ? "" : `${address}. `}It's a placeholder nobody controls: connect your wallet before sending anything.` });
    else toast(ok ? { tone: "good", title: "Address copied", body: address } : { tone: "info", title: "Your wallet address", body: address });
  }, [copy, connected, address, toast]);

  // Same behavior as the mobile header's Deposit pill.
  const deposit = useCallback(async () => {
    if (!publicKey) return setVisible(true);
    const addr = publicKey.toBase58();
    try {
      await navigator.clipboard.writeText(addr);
      toast({ tone: "good", title: "Address copied: send SOL to it to deposit", body: addr });
    } catch {
      toast({ tone: "info", title: "Your deposit address", body: `Send SOL to ${addr}` });
    }
  }, [publicKey, setVisible, toast]);

  const connect = useCallback(() => setVisible(true), [setVisible]);

  const signOut = useCallback(async () => {
    try {
      await disconnect();
      toast({ tone: "info", title: "Wallet disconnected", body: "Showing the demo wallet again" });
    } catch (e) {
      toast({ tone: "bad", title: "Couldn't disconnect", body: (e as Error).message });
    }
  }, [disconnect, toast]);

  return { connected, walletName: wallet?.adapter.name, walletIcon: wallet?.adapter.icon, copy, copyAddress, deposit, connect, disconnect: signOut };
}

type Allocated = DemoEpoch & { you: NonNullable<DemoEpoch["you"]> };
export type RewardEpoch = Allocated & { verified: boolean };

export interface RewardSummary {
  /** Epochs with an allocation for the wallet, newest first, each proof checked against its root. */
  epochs: RewardEpoch[];
  /** Verified, unexpired allocations: what the wallet can still claim. */
  unclaimedLamports: bigint;
  openEpochs: number;
  /** The open epoch whose claim window closes first. */
  closesFirst: RewardEpoch | null;
}

/** Whole days left in a claim window, rounded up: "9d left" with 8.8 days to go. */
export const daysLeft = (expiresAt: number, now: number) => Math.max(1, Math.ceil((expiresAt - now) / 86_400_000));

function summarize(address: string): RewardSummary {
  const wallet = new PublicKey(address);
  const bytes = wallet.toBytes();
  const epochs = walletEpochs(wallet)
    .filter((e): e is Allocated => e.you !== null)
    .reverse()
    // The same check the claim panel runs before it lets you claim.
    .map((e) => ({ ...e, verified: verifyProof(e.you.proof.map(fromHex), fromHex(e.root), leafHash(e.you.index, bytes, BigInt(e.you.amount))) }));
  const open = epochs.filter((e) => !e.expired && e.verified);
  return {
    epochs,
    unclaimedLamports: open.reduce((n, e) => n + BigInt(e.you.amount), 0n),
    openEpochs: open.length,
    closesFirst: open.reduce<RewardEpoch | null>((first, e) => (!first || e.expiresAt < first.expiresAt ? e : first), null),
  };
}

/** Built once per address per visit. */
const summaries = new Map<string, RewardSummary>();

/**
 * The wallet's holder-reward epochs. Building the demo epochs (real Merkle
 * trees) takes about 150ms, so it waits for the browser to be idle, or runs
 * on the next tick once `urgent` (the Rewards tab is open). Undefined until
 * then.
 */
export function useRewardSummary(address: string, urgent: boolean): RewardSummary | undefined {
  const [, rerender] = useState(0);
  useEffect(() => {
    if (summaries.has(address)) return;
    const run = () => {
      if (!summaries.has(address)) summaries.set(address, summarize(address));
      rerender((n) => n + 1);
    };
    if (urgent) {
      const t = window.setTimeout(run, 0);
      return () => window.clearTimeout(t);
    }
    // Safari has no requestIdleCallback.
    if (typeof window.requestIdleCallback === "function") {
      const id = window.requestIdleCallback(run, { timeout: 2500 });
      return () => window.cancelIdleCallback(id);
    }
    const t = window.setTimeout(run, 900);
    return () => window.clearTimeout(t);
  }, [address, urgent]);
  return summaries.get(address);
}

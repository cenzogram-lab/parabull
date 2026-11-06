/**
 * /admin: the operator console. It opens for the wallets the on-chain `Global` account names (the admin, the crank
 * authority, and a nominated admin who has to accept) and shows:
 * - launchpad, liquidity, vault and unswept-fee KPIs read straight from program accounts (no backend);
 * - the emergency pause, the editable `GlobalUpdate` parameters and the two-step admin transfer, signed by the admin.
 * The wallet check here only decides what to show. The program checks every signer again, and everything shown is
 * public on-chain data. Logic and validation live in lib/admin.ts.
 */
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import {
  ArrowRightLeft,
  Coins,
  ExternalLink,
  Flame,
  Gauge,
  HandCoins,
  Landmark,
  Loader2,
  Lock,
  Pause,
  Play,
  RefreshCw,
  Rocket,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  Ticket,
  TrendingUp,
  TriangleAlert,
  UserCheck,
  Vault,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { BottomSheet } from "../components/mobile/MobileUi";
import { Modal } from "../components/ui/overlay";
import { cx } from "../components/ui/primitives";
import { CONFIG, explorer, isDemo } from "../config";
import { useIsMobile } from "../hooks/useMediaQuery";
import { useParabullProgram } from "../hooks/useParabullProgram";
import { checkNominee, checkParams, curveKpis, formFromGlobal, lamportsToSolInput, owedToEpochs, spendable, type CurveKpis, type GlobalUpdateDraft, type ParamsForm } from "../lib/admin";
import { compact, shortAddr, usdCompact } from "../lib/format";
import { PROTOCOL } from "../lib/protocol";
import { BPS, bpsLabel, durationLabel, hasPendingAdmin, mayOpenConsole, rolesOf, usdToLamports, type GlobalView, type Roles } from "../lib/protocolParams";
import { useApp } from "../state/AppState";
import { useProtocol } from "../state/Protocol";

const REFRESH_MS = 60_000;
const LAMPORTS = 1e9;
const solText = (l: bigint, digits = 2) => `${(Number(l) / LAMPORTS).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })} SOL`;

// ---- Data -----------------------------------------------------------------------------------------------------------

interface VaultStats {
  lamports: bigint;
  spendable: bigint;
}

interface ConsoleData {
  kpis: CurveKpis;
  ticketsWaiting: number;
  treasury: bigint;
  buyback: (VaultStats & { deposited: bigint; spent: bigint; burned: bigint; count: bigint }) | null;
  holder: (VaultStats & { deposited: bigint; owed: bigint; claimed: bigint; epochs: bigint }) | null;
  readAt: number;
}

/** Program accounts behind the KPIs: every bonding curve, the waiting tickets (counted, not downloaded), both vaults and the treasury. */
function useConsoleData(global: GlobalView | null, enabled: boolean) {
  const { program, pdas } = useParabullProgram();
  const [data, setData] = useState<ConsoleData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const treasury = global?.treasury;

  const load = useCallback(async () => {
    if (!enabled || !treasury) return;
    setLoading(true);
    try {
      const conn = program.provider.connection;
      const buybackKey = pdas.buybackVault();
      const holderKey = pdas.holderVault();
      const [curves, tickets, infos, buyback, holder] = await Promise.all([
        program.account.bondingCurve.all(),
        conn.getProgramAccounts(program.programId, { filters: [{ memcmp: program.coder.accounts.memcmp("launchTicket") }], dataSlice: { offset: 0, length: 0 } }),
        conn.getMultipleAccountsInfo([new PublicKey(treasury), buybackKey, holderKey]),
        program.account.buybackVault.fetchNullable(buybackKey),
        program.account.holderRewardVault.fetchNullable(holderKey),
      ]);
      const [treasuryInfo, buybackInfo, holderInfo] = infos;
      const rent = async (len: number | undefined) => BigInt(len === undefined ? 0 : await conn.getMinimumBalanceForRentExemption(len));
      const vault = async (info: (typeof infos)[number]) => {
        const lamports = BigInt(info?.lamports ?? 0);
        return { lamports, spendable: spendable(lamports, info ? await rent(info.data.length) : 0n) };
      };
      const big = (v: { toString(): string }) => BigInt(v.toString());
      const holderView = holder && {
        totalDepositedLamports: big(holder.totalDepositedLamports),
        totalCommittedLamports: big(holder.totalCommittedLamports),
        totalClaimedLamports: big(holder.totalClaimedLamports),
        totalExpiredLamports: big(holder.totalExpiredLamports),
        nextEpoch: big(holder.nextEpoch),
      };
      setData({
        kpis: curveKpis(
          curves.map(({ account: c }) => ({
            complete: c.complete,
            migrated: c.migrated,
            escrowReleased: c.escrowReleased,
            realSolReserves: big(c.realSolReserves),
            escrowAccrued: big(c.escrowAccrued),
            buybackAccrued: big(c.buybackAccrued),
            holderAccrued: big(c.holderAccrued),
            treasuryAccrued: big(c.treasuryAccrued),
          })),
        ),
        ticketsWaiting: tickets.length,
        treasury: BigInt(treasuryInfo?.lamports ?? 0),
        buyback: buyback && {
          ...(await vault(buybackInfo)),
          deposited: big(buyback.totalDepositedLamports),
          spent: big(buyback.totalSpentLamports),
          burned: big(buyback.totalTokensBurned),
          count: big(buyback.buybackCount),
        },
        holder: holderView && {
          ...(await vault(holderInfo)),
          deposited: holderView.totalDepositedLamports,
          owed: owedToEpochs(holderView),
          claimed: holderView.totalClaimedLamports,
          epochs: holderView.nextEpoch,
        },
        readAt: Date.now(),
      });
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [enabled, treasury, program, pdas]);

  useEffect(() => {
    void load();
    if (!enabled) return;
    const id = window.setInterval(() => void load(), REFRESH_MS);
    return () => window.clearInterval(id);
  }, [load, enabled]);

  return { data, error, loading, reload: load };
}

// ---- Page -----------------------------------------------------------------------------------------------------------

export default function AdminConsole() {
  const { global, globalStatus, globalError, refreshGlobal } = useProtocol();
  const { publicKey } = useWallet();
  const wallet = publicKey?.toBase58() ?? null;
  const roles = useMemo(() => (global ? rolesOf(global, wallet) : null), [global, wallet]);

  if (isDemo) return <Restricted reason="demo" />;
  if (globalStatus === "loading")
    return (
      <Centered>
        <Loader2 className="mx-auto h-6 w-6 animate-spin text-copper" aria-label="Reading the program's Global account" />
      </Centered>
    );
  if (globalStatus === "error") return <Restricted reason="error" detail={globalError} onRetry={() => void refreshGlobal().catch(() => undefined)} />;
  if (!global || !roles) return <Restricted reason="missing" />;
  if (!mayOpenConsole(roles)) return <Restricted reason={wallet ? "wrong-wallet" : "disconnected"} global={global} wallet={wallet} />;
  return <Console global={global} roles={roles} />;
}

function Centered({ children }: { children: ReactNode }) {
  return <div className="flex min-h-[70vh] items-center justify-center px-8 py-10 max-md:min-h-[60vh] max-md:px-4">{children}</div>;
}

type RestrictedReason = "demo" | "disconnected" | "wrong-wallet" | "missing" | "error";

/** The locked state: same canvas, gold accents and lock ring as the rest of the app. */
function Restricted({ reason, global, wallet, detail, onRetry }: { reason: RestrictedReason; global?: GlobalView; wallet?: string | null; detail?: string | null; onRetry?: () => void }) {
  const { setVisible } = useWalletModal();
  const { disconnect } = useWallet();
  const body: Record<RestrictedReason, ReactNode> = {
    demo: (
      <>
        The console reads and signs against the deployed program&apos;s <span className="font-mono text-cream">Global</span> account. This build runs on demo
        data; set <span className="font-mono text-cream">VITE_PARABULL_MODE=chain</span> to use it.
      </>
    ),
    disconnected: "Connect the admin or crank wallet named in the program's Global account to open the console.",
    "wrong-wallet": (
      <>
        The connected wallet <span className="font-mono text-cream">{wallet ? shortAddr(wallet) : ""}</span> isn&apos;t the admin, the crank authority or a
        nominated admin. Switch to one of the wallets below.
      </>
    ),
    missing: `The program's Global account isn't on ${CONFIG.cluster} yet. Deploy and initialize the program (scripts/deploy_and_init.ts), then reload.`,
    error: "The program's Global account couldn't be read from the RPC endpoint.",
  };
  return (
    <Centered>
      <section className="panel relative w-full max-w-lg overflow-hidden p-8 text-center max-md:p-5" aria-labelledby="restricted-title">
        <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-gold/60 to-transparent" />
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full border border-line-accent bg-canvas-2 shadow-glow">
          <Lock className="h-7 w-7 text-gold" aria-hidden />
        </div>
        <h1 id="restricted-title" className="mt-5 text-[22px] font-semibold tracking-tight max-md:text-[20px]">
          Access Restricted: <span className="metal-text">Connect Admin Wallet</span>
        </h1>
        <p className="mt-3 text-[14px] leading-6 text-muted">{body[reason]}</p>
        {reason === "error" && detail && <p className="mt-2 break-words font-mono text-[12px] text-ember">{detail}</p>}
        {global && (
          <dl className="mx-auto mt-5 max-w-xs space-y-1.5 text-left text-[13px]">
            {(
              [
                ["Admin", global.admin],
                ["Crank", global.crankAuthority],
                ...(hasPendingAdmin(global) ? [["Nominated admin", global.pendingAdmin]] : []),
              ] as [string, string][]
            ).map(([k, v]) => (
              <div key={k} className="flex justify-between gap-3">
                <dt className="text-muted">{k}</dt>
                <dd className="font-mono text-cream" title={v}>
                  {shortAddr(v, 6)}
                </dd>
              </div>
            ))}
          </dl>
        )}
        <div className="mt-6 flex justify-center gap-3 max-md:flex-col">
          {(reason === "disconnected" || reason === "wrong-wallet") && (
            <button className="btn-gold h-11 px-6 text-[15px]" onClick={() => (reason === "wrong-wallet" ? void disconnect().then(() => setVisible(true)) : setVisible(true))}>
              <Wallet className="h-4 w-4" /> {reason === "wrong-wallet" ? "Switch wallet" : "Connect wallet"}
            </button>
          )}
          {reason === "error" && onRetry && (
            <button className="btn-gold h-11 px-6 text-[15px]" onClick={onRetry}>
              <RefreshCw className="h-4 w-4" /> Try again
            </button>
          )}
        </div>
      </section>
    </Centered>
  );
}

function Console({ global, roles }: { global: GlobalView; roles: Roles }) {
  const { refreshGlobal, solUsd } = useProtocol();
  const { data, error, loading, reload } = useConsoleData(global, true);
  const refreshAll = useCallback(async () => {
    await Promise.all([refreshGlobal().catch(() => undefined), reload()]);
  }, [refreshGlobal, reload]);
  const usd = (l: bigint) => usdCompact((Number(l) / LAMPORTS) * solUsd.price);

  return (
    <div className="mx-auto max-w-[1400px] px-8 py-6 max-md:px-4 max-md:py-4">
      <header className="flex flex-wrap items-start gap-x-4 gap-y-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-[28px] font-semibold tracking-tight max-md:text-[24px]">Admin console</h1>
            <StatusPill paused={global.paused} />
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[12.5px] text-muted">
            {roles.admin && <RoleChip icon={ShieldCheck} label="Admin" />}
            {roles.crank && <RoleChip icon={Gauge} label="Crank" />}
            {roles.pendingAdmin && <RoleChip icon={UserCheck} label="Nominated admin" />}
            <span className="ml-1">
              {CONFIG.cluster} · SOL ${solUsd.price.toFixed(2)} {solUsd.source ? `(${solUsd.source})` : "(fallback price: the feed hasn't answered)"}
            </span>
          </div>
        </div>
        <div className="ml-auto flex items-center gap-3 max-md:ml-0 max-md:w-full">
          <span className="text-xs text-muted">{data ? `Read ${new Date(data.readAt).toLocaleTimeString("en-US", { hour12: false })}` : "Reading accounts…"}</span>
          <button className="btn-ghost h-9 px-3 text-[13px] max-md:ml-auto" onClick={() => void refreshAll()} disabled={loading}>
            <RefreshCw className={cx("h-4 w-4", loading && "animate-spin")} /> Refresh
          </button>
        </div>
      </header>

      {error && (
        <p role="alert" className="mt-4 rounded-lg border border-ember/40 bg-ember/10 px-4 py-3 text-[13px] text-ember">
          Couldn&apos;t read the program accounts: {error}. Some RPC providers turn off getProgramAccounts; use one that allows it for the console.
        </p>
      )}

      <Section title="Launchpad" note="Live from the program's accounts">
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4 max-md:gap-3">
          <Kpi icon={Rocket} label="Total launches" value={global.launchCount.toLocaleString("en-US")} foot={data ? `${data.ticketsWaiting} ticket${data.ticketsWaiting === 1 ? "" : "s"} waiting` : "Global.launch_count"} />
          <Kpi icon={TrendingUp} label="Active on curves" value={data ? data.kpis.active.toLocaleString("en-US") : "…"} foot="still trading on the bonding curve" />
          <Kpi icon={Gauge} label="Graduating" value={data ? data.kpis.graduating.toLocaleString("en-US") : "…"} foot="curve complete, migration pending" />
          <Kpi icon={ShieldCheck} label="Graduated" value={data ? data.kpis.graduated.toLocaleString("en-US") : "…"} foot="Raydium pool, LP locked" />
        </div>
      </Section>

      <Section title="Liquidity & vaults" note={`USD at SOL $${solUsd.price.toFixed(2)}`}>
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4 max-md:grid-cols-1 max-md:gap-3">
          <Kpi icon={Coins} label="SOL in bonding curves" value={data ? solText(data.kpis.solInCurves) : "…"} foot={data ? `${usd(data.kpis.solInCurves)} across ${data.kpis.curves} curves` : undefined} />
          <Kpi icon={Landmark} label="Treasury balance" value={data ? solText(data.treasury) : "…"} foot={<AddressLink address={global.treasury} />} />
          <Kpi
            icon={Flame}
            label="Buyback vault"
            value={data?.buyback ? solText(data.buyback.spendable) : data ? "Not initialized" : "…"}
            foot={data?.buyback ? `${solText(data.buyback.spent)} spent · ${compact(Number(data.buyback.burned) / 1e6)} $PARABULL burned in ${data.buyback.count} buybacks` : undefined}
          />
          <Kpi
            icon={HandCoins}
            label="Holder-reward vault"
            value={data?.holder ? solText(data.holder.spendable) : data ? "Not initialized" : "…"}
            foot={data?.holder ? `${solText(data.holder.owed)} owed to open epochs · ${solText(data.holder.claimed)} claimed over ${data.holder.epochs} epochs` : undefined}
          />
        </div>
      </Section>

      <Section title="Unswept protocol fees" note="Accrued on each coin's curve, not yet in a vault">
        <UnsweptFees kpis={data?.kpis ?? null} usd={usd} />
      </Section>

      <Section title="Controls" note={roles.admin ? "Each change is a transaction signed by the admin wallet" : "Only the admin wallet can sign these"}>
        <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)] max-md:gap-4">
          <ParamsPanel global={global} canSign={roles.admin} onDone={refreshAll} />
          <div className="space-y-5 max-md:space-y-4">
            <PausePanel global={global} canSign={roles.admin} onDone={refreshAll} />
            <AdminTransferPanel global={global} roles={roles} onDone={refreshAll} />
          </div>
        </div>
      </Section>

      <Section title="Configuration" note="Fixed at initialize unless shown above">
        <ConfigPanel global={global} />
      </Section>
    </div>
  );
}

// ---- Pieces ---------------------------------------------------------------------------------------------------------

function StatusPill({ paused }: { paused: boolean }) {
  return paused ? (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-ember/50 bg-ember/15 px-2.5 py-0.5 text-[12px] font-semibold text-ember">
      <Pause className="h-3.5 w-3.5" aria-hidden /> Paused
    </span>
  ) : (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-line-accent bg-surface-4 px-2.5 py-0.5 text-[12px] font-semibold text-gold">
      <span className="h-1.5 w-1.5 rounded-full bg-gold" aria-hidden /> Active
    </span>
  );
}

function RoleChip({ icon: Icon, label }: { icon: LucideIcon; label: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-line-accent bg-surface-2 px-2 py-0.5 text-[12px] font-medium text-cream">
      <Icon className="h-3.5 w-3.5 text-gold" aria-hidden /> {label}
    </span>
  );
}

function Section({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className="mt-8 max-md:mt-6">
      <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <h2 className="text-[17px] font-semibold">{title}</h2>
        {note && <span className="text-xs text-muted">{note}</span>}
      </div>
      {children}
    </section>
  );
}

function Kpi({ icon: Icon, label, value, foot }: { icon: LucideIcon; label: string; value: ReactNode; foot?: ReactNode }) {
  return (
    <div className="panel relative min-w-0 overflow-hidden p-5 max-md:p-4">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-copper/50 to-transparent" />
      <div className="flex items-center gap-2 text-[13px] font-medium text-muted">
        <Icon className="h-4 w-4 shrink-0 text-copper" aria-hidden />
        <span className="truncate">{label}</span>
      </div>
      <div className="num mt-2.5 truncate text-[26px] font-semibold leading-8 tracking-tight text-cream max-md:text-[22px]">{value}</div>
      {foot && <div className="mt-1.5 text-xs leading-5 text-muted">{foot}</div>}
    </div>
  );
}

function AddressLink({ address, n = 4 }: { address: string; n?: number }) {
  return (
    <a href={explorer("account", address)} target="_blank" rel="noreferrer" data-touch-exempt className="inline-flex items-center gap-1 font-mono text-muted hover:text-cream" title={address}>
      {shortAddr(address, n)} <ExternalLink className="h-3 w-3" aria-hidden />
    </a>
  );
}

const BUCKETS = [
  { key: "escrow", label: "Listing escrow", note: "paid out per coin once it reaches the target", color: "bg-rosebronze" },
  { key: "buyback", label: "Buyback", note: "to the buyback vault on sweep", color: "bg-gold" },
  { key: "holder", label: "Holder rewards", note: "to the holder-reward vault on sweep", color: "bg-copper" },
  { key: "treasury", label: "Treasury", note: "to the treasury on sweep", color: "bg-bronze" },
] as const;

function UnsweptFees({ kpis, usd }: { kpis: CurveKpis | null; usd: (l: bigint) => string }) {
  const total = kpis?.unswept.total ?? 0n;
  return (
    <div className="panel p-5 max-md:p-4">
      <div className="flex flex-wrap items-baseline gap-x-3">
        <span className="num text-[26px] font-semibold tracking-tight max-md:text-[22px]">{kpis ? solText(total, 4) : "…"}</span>
        {kpis && <span className="text-[13px] text-muted">{usd(total)} · sweep_fees is permissionless; the crank sweeps above its threshold</span>}
      </div>
      <div className="mt-4 flex h-2.5 w-full gap-0.5 overflow-hidden rounded-full bg-canvas-2" role="img" aria-label="Unswept fees by bucket">
        {kpis &&
          total > 0n &&
          BUCKETS.map((b) => {
            const v = kpis.unswept[b.key];
            return v > 0n ? <div key={b.key} className={cx("h-full", b.color)} style={{ width: `${(Number(v) / Number(total)) * 100}%` }} /> : null;
          })}
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-4 lg:grid-cols-4 max-md:gap-3">
        {BUCKETS.map((b) => (
          <div key={b.key} className="min-w-0">
            <dt className="flex items-center gap-1.5 text-[13px] text-muted">
              <span className={cx("h-2 w-2 shrink-0 rounded-full", b.color)} aria-hidden /> {b.label}
            </dt>
            <dd className="num mt-1 text-[17px] font-semibold">{kpis ? solText(kpis.unswept[b.key], 4) : "…"}</dd>
            <dd className="text-xs leading-5 text-muted">{b.key === "escrow" && kpis ? `${kpis.escrowsReleased} released so far · ${b.note}` : b.note}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

// ---- Transactions ---------------------------------------------------------------------------------------------------

/** Send an admin transaction, then refresh and toast. Resolves true on success. */
function useAdminTx(onDone: () => Promise<void>) {
  const { toast } = useApp();
  const [busy, setBusy] = useState<string | null>(null);
  const run = useCallback(
    async (label: string, send: () => Promise<string>, done: string) => {
      setBusy(label);
      try {
        const sig = await send();
        toast({ tone: "good", title: done, body: `Signature ${shortAddr(sig, 6)}` });
        await onDone();
        return true;
      } catch (e) {
        toast({ tone: "bad", title: `${label} failed`, body: e instanceof Error ? e.message : String(e) });
        return false;
      } finally {
        setBusy(null);
      }
    },
    [toast, onDone],
  );
  return { busy, run };
}

/** A confirm step before signing: a dialog on desktop, a bottom sheet on a phone. */
function Confirm({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  const isMobile = useIsMobile();
  if (isMobile)
    return (
      <BottomSheet open={open} onClose={onClose} title={title}>
        <div className="px-4 pb-4">{children}</div>
      </BottomSheet>
    );
  return (
    <Modal open={open} onClose={onClose} label={title} className="max-w-md" manageFocus>
      <div className="p-6">
        <h2 className="text-[18px] font-semibold">{title}</h2>
        <div className="mt-3">{children}</div>
      </div>
    </Modal>
  );
}

function SignerNote({ canSign, who = "admin" }: { canSign: boolean; who?: string }) {
  if (canSign) return null;
  return <p className="mt-3 text-xs text-muted">Read-only: this needs the {who} wallet&apos;s signature.</p>;
}

function PausePanel({ global, canSign, onDone }: { global: GlobalView; canSign: boolean; onDone: () => Promise<void> }) {
  const { program, pdas, publicKey } = useParabullProgram();
  const { busy, run } = useAdminTx(onDone);
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const pausing = !global.paused;
  const confirmed = !pausing || typed.trim().toUpperCase() === "PAUSE";
  const send = async () => {
    const ok = await run(
      pausing ? "Pause" : "Resume",
      () => program.methods.setPaused(pausing).accountsStrict({ admin: publicKey!, global: pdas.global() }).rpc(),
      pausing ? "Protocol paused" : "Protocol resumed",
    );
    if (ok) setOpen(false);
  };
  return (
    <div className={cx("panel p-5 max-md:p-4", global.paused && "border-ember/50")}>
      <div className="flex items-center gap-2">
        <ShieldAlert className={cx("h-4 w-4", global.paused ? "text-ember" : "text-copper")} aria-hidden />
        <h3 className="text-[15px] font-semibold">Emergency pause</h3>
        <span className="ml-auto">
          <StatusPill paused={global.paused} />
        </span>
      </div>
      <p className="mt-2 text-[13px] leading-5 text-muted">
        Stops new launches, curve trading, buybacks and new reward epochs. Refunds, fee sweeps, escrow release, graduation, LP-fee collection and reward
        claims keep working, so no one&apos;s funds are trapped.
      </p>
      <button
        className={cx("mt-4 h-11 w-full text-[15px]", pausing ? "btn border border-ember/60 bg-ember/15 text-ember hover:bg-ember/25" : "btn-gold")}
        disabled={!canSign || busy !== null}
        onClick={() => (setTyped(""), setOpen(true))}
      >
        {pausing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />} {pausing ? "Pause the protocol" : "Resume the protocol"}
      </button>
      <SignerNote canSign={canSign} />
      <Confirm open={open} onClose={() => setOpen(false)} title={pausing ? "Pause the protocol?" : "Resume the protocol?"}>
        <p className="text-[13.5px] leading-6 text-muted">
          {pausing
            ? "Every coin stops trading and no launch, buyback or reward epoch goes through until you resume. Users can still get refunds and claim rewards."
            : "Launches, trading, buybacks and new reward epochs open again at once."}
        </p>
        {pausing && (
          <label className="mt-4 block">
            <span className="label">
              Type <span className="font-mono text-cream">PAUSE</span> to confirm
            </span>
            <input className="input mt-1.5 font-mono" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} aria-label="Type PAUSE to confirm" />
          </label>
        )}
        <div className="mt-5 flex gap-3">
          <button className="btn-ghost h-11 flex-1" onClick={() => setOpen(false)}>
            Cancel
          </button>
          <button
            className={cx("h-11 flex-1", pausing ? "btn border border-ember/60 bg-ember/20 text-ember hover:bg-ember/30" : "btn-gold")}
            disabled={!confirmed || busy !== null}
            onClick={() => void send()}
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" />} {pausing ? "Sign and pause" : "Sign and resume"}
          </button>
        </div>
      </Confirm>
    </div>
  );
}

/** The program's `GlobalUpdate` argument: every field present, null when unchanged. */
function toGlobalUpdate(u: GlobalUpdateDraft) {
  const bn = (v: bigint | undefined) => (v === undefined ? null : new BN(v.toString()));
  return {
    dexTargetLamports: bn(u.dexTargetLamports),
    buybackBps: u.buybackBps ?? null,
    holderBps: u.holderBps ?? null,
    migrationReserveLamports: bn(u.migrationReserveLamports),
    tradingOpenDelaySlots: bn(u.tradingOpenDelaySlots),
    cpmmProgram: null,
    cpmmAmmConfig: null,
    lpLockProgram: null,
    lpLockAuthority: null,
    parabullMint: null,
    parabullPool: null,
    rewardClaimWindowSeconds: bn(u.rewardClaimWindowSeconds),
  };
}

function ParamsPanel({ global, canSign, onDone }: { global: GlobalView; canSign: boolean; onDone: () => Promise<void> }) {
  const { program, pdas, publicKey } = useParabullProgram();
  const { solUsd } = useProtocol();
  const { busy, run } = useAdminTx(onDone);
  const [form, setForm] = useState<ParamsForm>(() => formFromGlobal(global));
  const [reviewing, setReviewing] = useState(false);
  // A new on-chain value (after a change, or another admin's) resets the form.
  const baseline = useMemo(() => JSON.stringify(formFromGlobal(global)), [global]);
  useEffect(() => setForm(JSON.parse(baseline) as ParamsForm), [baseline]);

  const check = checkParams(global, form);
  const errors = check.ok ? {} : check.errors;
  const dirty = JSON.stringify(form) !== baseline;
  const set = (k: keyof ParamsForm) => (v: string) => setForm((f) => ({ ...f, [k]: v }));
  const buyback = Number(form.buybackPct) || 0;
  const holder = Number(form.holderPct) || 0;
  const treasury = Math.max(0, 100 - buyback - holder);
  const dexSol = Number(form.dexTargetSol);
  const send = async () => {
    if (!check.ok) return;
    const ok = await run(
      "Parameter update",
      () => program.methods.updateGlobalParams(toGlobalUpdate(check.update)).accountsStrict({ admin: publicKey!, global: pdas.global() }).rpc(),
      "Parameters updated",
    );
    if (ok) setReviewing(false);
  };

  return (
    <div className="panel p-5 max-md:p-4">
      <div className="flex items-center gap-2">
        <SlidersHorizontal className="h-4 w-4 text-copper" aria-hidden />
        <h3 className="text-[15px] font-semibold">Fees & parameters</h3>
      </div>

      <div className="mt-4 rounded-lg border border-line-soft bg-canvas-2 px-4 py-3">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-[13px] text-muted">Platform fee on every trade</span>
          <span className="num text-[17px] font-semibold">{bpsLabel(global.platformFeeBps)}</span>
        </div>
        <p className="mt-1 text-xs leading-5 text-muted">
          Set at initialize and capped at 1% on-chain. The program has no instruction to change it, so it isn&apos;t editable here. Creators earn 0%.
        </p>
      </div>

      <fieldset className="mt-5" disabled={!canSign}>
        <legend className="text-[13px] font-semibold">Fee split, after each coin&apos;s listing fund</legend>
        <SplitBar buyback={buyback} holder={holder} treasury={treasury} />
        <PctSlider label="Buyback & burn" value={form.buybackPct} onChange={set("buybackPct")} error={errors.buybackPct} max={100 - holder} />
        <PctSlider label="Holder rewards" value={form.holderPct} onChange={set("holderPct")} error={errors.holderPct} max={100 - buyback} />
        <div className="mt-2 flex justify-between text-[13px]">
          <span className="text-muted">Treasury (the rest)</span>
          <span className="num font-semibold">{Number(treasury.toFixed(2))}%</span>
        </div>
        {errors.split && <p className="mt-1 text-[12px] text-ember">{errors.split}</p>}
      </fieldset>

      <fieldset className="mt-5 grid grid-cols-2 gap-x-4 gap-y-3 max-md:grid-cols-1" disabled={!canSign}>
        <legend className="mb-2 text-[13px] font-semibold">Thresholds and timing</legend>
        <NumField
          label="DexScreener listing target"
          unit="SOL"
          value={form.dexTargetSol}
          onChange={set("dexTargetSol")}
          error={errors.dexTargetSol}
          hint={
            <>
              {Number.isFinite(dexSol) ? `≈ ${usdCompact(dexSol * solUsd.price)} at $${solUsd.price.toFixed(2)}` : ""}{" "}
              <button type="button" data-touch-exempt className="text-gold underline-offset-2 hover:underline disabled:no-underline" onClick={() => set("dexTargetSol")(lamportsToSolInput(usdToLamports(PROTOCOL.dexListingUsd, solUsd.price)))}>
                Set to ${PROTOCOL.dexListingUsd}
              </button>
            </>
          }
        />
        <NumField label="Trading opens after" unit="slots" value={form.tradingOpenDelaySlots} onChange={set("tradingOpenDelaySlots")} error={errors.tradingOpenDelaySlots} hint="Blocks buying in the creation slot (≈0.4 s per slot)" />
        <NumField label="Migration reserve" unit="SOL" value={form.migrationReserveSol} onChange={set("migrationReserveSol")} error={errors.migrationReserveSol} hint="Pays Raydium's 0.15 SOL pool fee and rent" />
        <NumField label="Reward claim window" unit="days" value={form.claimWindowDays} onChange={set("claimWindowDays")} error={errors.claimWindowDays} hint="At least 7 days; applies to new epochs" />
      </fieldset>

      <div className="mt-5 flex gap-3">
        <button className="btn-ghost h-11 px-4" disabled={!dirty || busy !== null} onClick={() => setForm(JSON.parse(baseline) as ParamsForm)}>
          Reset
        </button>
        <button className="btn-gold h-11 flex-1 text-[15px]" disabled={!canSign || !check.ok || check.changes.length === 0 || busy !== null} onClick={() => setReviewing(true)}>
          Review changes
        </button>
      </div>
      <SignerNote canSign={canSign} />

      <Confirm open={reviewing && check.ok} onClose={() => setReviewing(false)} title="Update protocol parameters?">
        {check.ok && (
          <>
            <ul className="space-y-2 text-[13.5px]">
              {check.changes.map((c) => (
                <li key={c.label} className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <span className="text-muted">{c.label}</span>
                  <span className="num">
                    <span className="text-muted line-through decoration-muted/60">{c.from}</span> <span className="text-gold">→ {c.to}</span>
                  </span>
                </li>
              ))}
            </ul>
            {check.warnings.map((w) => (
              <p key={w} className="mt-3 flex gap-2 text-[12.5px] leading-5 text-muted">
                <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-gold" aria-hidden /> {w}
              </p>
            ))}
            <p className="mt-3 text-[12.5px] leading-5 text-muted">The program validates the merged parameters as a whole and applies all of them or none.</p>
            <div className="mt-5 flex gap-3">
              <button className="btn-ghost h-11 flex-1" onClick={() => setReviewing(false)}>
                Cancel
              </button>
              <button className="btn-gold h-11 flex-1" disabled={busy !== null} onClick={() => void send()}>
                {busy && <Loader2 className="h-4 w-4 animate-spin" />} Sign and update
              </button>
            </div>
          </>
        )}
      </Confirm>
    </div>
  );
}

function SplitBar({ buyback, holder, treasury }: { buyback: number; holder: number; treasury: number }) {
  const parts = [
    { v: buyback, c: "bg-gold", l: "Buyback" },
    { v: holder, c: "bg-copper", l: "Holders" },
    { v: treasury, c: "bg-bronze", l: "Treasury" },
  ];
  return (
    <div className="mt-3 flex h-2.5 w-full gap-0.5 overflow-hidden rounded-full bg-canvas-2" role="img" aria-label={`Split: buyback ${buyback}%, holders ${holder}%, treasury ${Number(treasury.toFixed(2))}%`}>
      {parts.map((p) => (p.v > 0 ? <div key={p.l} className={cx("h-full", p.c)} style={{ width: `${Math.min(100, p.v)}%` }} /> : null))}
    </div>
  );
}

function PctSlider({ label, value, onChange, error, max }: { label: string; value: string; onChange: (v: string) => void; error?: string; max: number }) {
  const n = Number(value);
  return (
    <label className="mt-3 block">
      <span className="flex items-center justify-between gap-3 text-[13px]">
        <span className="text-muted">{label}</span>
        <span className="input-shell w-24 px-2">
          <input className="num w-full bg-transparent py-1 text-right text-cream max-md:min-h-11" inputMode="decimal" value={value} onChange={(e) => onChange(e.target.value)} aria-label={`${label} percentage`} aria-invalid={!!error} />
          <span className="pl-1 text-muted">%</span>
        </span>
      </span>
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={Number.isFinite(n) ? n : 0}
        onChange={(e) => onChange(String(Math.min(Number(e.target.value), Math.max(0, max))))}
        className="mt-2 w-full accent-[#E5A967] max-md:mt-0 max-md:h-11"
        aria-label={`${label} share`}
      />
      {error && <span className="block text-[12px] text-ember">{error}</span>}
    </label>
  );
}

function NumField({ label, unit, value, onChange, error, hint }: { label: string; unit: string; value: string; onChange: (v: string) => void; error?: string; hint?: ReactNode }) {
  return (
    <label className="block min-w-0">
      <span className="label">{label}</span>
      <span className={cx("input-shell mt-1.5 px-3", error && "border-ember/70")}>
        <input className="num w-full min-w-0 bg-transparent py-2 text-cream max-md:min-h-11" inputMode="decimal" value={value} onChange={(e) => onChange(e.target.value)} aria-invalid={!!error} />
        <span className="pl-2 text-[13px] text-muted">{unit}</span>
      </span>
      {error ? <span className="mt-1 block text-[12px] text-ember">{error}</span> : hint && <span className="mt-1 block text-[12px] leading-5 text-muted">{hint}</span>}
    </label>
  );
}

function AdminTransferPanel({ global, roles, onDone }: { global: GlobalView; roles: Roles; onDone: () => Promise<void> }) {
  const { program, pdas, publicKey } = useParabullProgram();
  const { busy, run } = useAdminTx(onDone);
  const [nominee, setNominee] = useState("");
  const [confirm, setConfirm] = useState<null | "propose" | "cancel" | "accept">(null);
  const pending = hasPendingAdmin(global);
  const check = checkNominee(global, nominee);
  const send = async () => {
    const kind = confirm;
    let ok = false;
    if (kind === "propose" && check.ok)
      ok = await run("Nomination", () => program.methods.proposeAdmin(check.key).accountsStrict({ admin: publicKey!, global: pdas.global() }).rpc(), "New admin nominated");
    else if (kind === "cancel")
      ok = await run("Cancel nomination", () => program.methods.proposeAdmin(PublicKey.default).accountsStrict({ admin: publicKey!, global: pdas.global() }).rpc(), "Nomination withdrawn");
    else if (kind === "accept")
      ok = await run("Accept admin role", () => program.methods.acceptAdmin().accountsStrict({ pendingAdmin: publicKey!, global: pdas.global() }).rpc(), "You're now the admin");
    if (ok) {
      setConfirm(null);
      if (kind === "propose") setNominee("");
    }
  };
  const titles = { propose: "Nominate a new admin?", cancel: "Withdraw the nomination?", accept: "Accept the admin role?" } as const;

  return (
    <div className="panel p-5 max-md:p-4">
      <div className="flex items-center gap-2">
        <ArrowRightLeft className="h-4 w-4 text-copper" aria-hidden />
        <h3 className="text-[15px] font-semibold">Admin transfer</h3>
      </div>
      <p className="mt-2 text-[13px] leading-5 text-muted">Two steps: the admin nominates a wallet, then that wallet signs to accept. Until it does, the current admin stays in control.</p>
      <dl className="mt-3 space-y-1.5 text-[13px]">
        <div className="flex justify-between gap-3">
          <dt className="text-muted">Current admin</dt>
          <dd>
            <AddressLink address={global.admin} n={6} />
          </dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-muted">Nominated</dt>
          <dd>{pending ? <AddressLink address={global.pendingAdmin} n={6} /> : <span className="text-muted">nobody</span>}</dd>
        </div>
      </dl>

      {roles.pendingAdmin && (
        <button className="btn-gold mt-4 h-11 w-full text-[15px]" disabled={busy !== null} onClick={() => setConfirm("accept")}>
          <UserCheck className="h-4 w-4" /> Accept the admin role
        </button>
      )}

      {roles.admin && (
        <>
          <label className="mt-4 block">
            <span className="label">New admin address</span>
            <input className="input mt-1.5 font-mono text-[13px]" value={nominee} onChange={(e) => setNominee(e.target.value)} placeholder="Base58 wallet address" spellCheck={false} autoComplete="off" aria-invalid={!!nominee && !check.ok} />
            {nominee && !check.ok && <span className="mt-1 block text-[12px] text-ember">{check.error}</span>}
            {check.ok && check.warning && <span className="mt-1 block text-[12px] leading-5 text-gold">{check.warning}</span>}
          </label>
          <div className="mt-3 flex gap-3">
            {pending && (
              <button className="btn-ghost h-11 flex-1" disabled={busy !== null} onClick={() => setConfirm("cancel")}>
                Withdraw nomination
              </button>
            )}
            <button className="btn-gold h-11 flex-1" disabled={!check.ok || busy !== null} onClick={() => setConfirm("propose")}>
              Nominate
            </button>
          </div>
        </>
      )}
      {!roles.admin && !roles.pendingAdmin && <SignerNote canSign={false} />}

      <Confirm open={confirm !== null} onClose={() => setConfirm(null)} title={confirm ? titles[confirm] : ""}>
        <p className="text-[13.5px] leading-6 text-muted">
          {confirm === "propose" && check.ok && (
            <>
              <span className="break-all font-mono text-cream">{check.key.toBase58()}</span> becomes the nominated admin. Nothing changes until it signs to
              accept{pending ? "; this replaces the current nomination" : ""}.
            </>
          )}
          {confirm === "cancel" && "The nominated wallet can no longer accept. You stay the admin."}
          {confirm === "accept" && "Your wallet becomes the admin and the current admin loses every admin power at once."}
        </p>
        <div className="mt-5 flex gap-3">
          <button className="btn-ghost h-11 flex-1" onClick={() => setConfirm(null)}>
            Cancel
          </button>
          <button className="btn-gold h-11 flex-1" disabled={busy !== null || (confirm === "propose" && !check.ok)} onClick={() => void send()}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />} Sign
          </button>
        </div>
      </Confirm>
    </div>
  );
}

function ConfigPanel({ global }: { global: GlobalView }) {
  const rows: [string, ReactNode][] = [
    ["Launch authority", <AddressLink key="la" address={global.launchAuthority} n={6} />],
    ["Crank authority", <AddressLink key="ca" address={global.crankAuthority} n={6} />],
    ["Treasury", <AddressLink key="tr" address={global.treasury} n={6} />],
    ["$PARABULL mint", <AddressLink key="pm" address={global.parabullMint} n={6} />],
    ["$PARABULL pool", global.parabullPool === PublicKey.default.toBase58() ? <span key="pp" className="text-muted">not set (buybacks off)</span> : <AddressLink key="pp" address={global.parabullPool} n={6} />],
    ["Launch ticket", `${solText(global.ticketDepositLamports, 3)} (${solText(global.launchFeeLamports, 3)} fee)`],
    ["Ticket expiry", durationLabel(global.ticketTtlSeconds)],
    ["Ticker, name and tweet lock", durationLabel(global.registryLockSeconds)],
    ["Fee split", `${bpsLabel(global.buybackBps)} buyback · ${bpsLabel(global.holderBps)} holders · ${bpsLabel(BPS - global.buybackBps - global.holderBps)} treasury`],
    ["Listing target last set", global.dexTargetUpdatedAt ? new Date(global.dexTargetUpdatedAt * 1000).toLocaleString("en-US") : "never"],
  ];
  return (
    <div className="panel p-5 max-md:p-4">
      <dl className="grid grid-cols-1 gap-x-8 gap-y-2 text-[13px] md:grid-cols-2">
        {rows.map(([k, v]) => (
          <div key={k} className="flex min-w-0 items-baseline justify-between gap-3 border-b border-line-soft py-1.5 last:border-0">
            <dt className="shrink-0 text-muted">{k}</dt>
            <dd className="num min-w-0 truncate text-right">{v}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 flex items-center gap-1.5 text-xs text-muted">
        <Ticket className="h-3.5 w-3.5" aria-hidden /> {global.launchCount.toLocaleString("en-US")} launches since deploy · <Vault className="h-3.5 w-3.5" aria-hidden /> vault balances shown
        above the rent-exempt minimum
      </p>
    </div>
  );
}

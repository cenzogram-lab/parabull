/**
 * X automation for a coin's creator: which bonding-curve milestones the X sentinel posts, whether it answers
 * cashtag mentions of the project's account, the persona it writes in, and context it can quote. The bot itself runs
 * in services/twitter-sentinel; this modal only reads its status and sends settings signed by the creator's wallet
 * (a message signature: no transaction, no fee). Without VITE_SENTINEL_URL it says the sentinel is off. On a phone it
 * opens as a bottom sheet, like the app's other phone dialogs.
 */
import { useWallet } from "@solana/wallet-adapter-react";
import { AlertTriangle, Loader2, PlugZap, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { isDemo } from "../../config";
import { useIsMobile } from "../../hooks/useMediaQuery";
import { canonicalSettingsJson, CONTEXT_MAX, DEFAULT_SETTINGS, SENTINEL_MILESTONES, SENTINEL_TONES, type SentinelSettings, type SentinelStatus } from "../../lib/sentinelMessage";
import type { Coin } from "../../lib/types";
import { useApp } from "../../state/AppState";
import { XLogo } from "../brand/Wordmark";
import { BottomSheet } from "../mobile/MobileUi";
import { Modal } from "../ui/overlay";
import { cx } from "../ui/primitives";
import { fetchSentinelStatus, saveSentinelSettings, sentinelConfigured } from "./sentinelClient";

/** The connected wallet, or the demo creator when no wallet is connected in demo mode. */
function useCreatorMatch(coin: Coin) {
  const { publicKey } = useWallet();
  const me = publicKey?.toBase58() ?? (isDemo ? "demo" : null);
  return me !== null && coin.creator === me;
}

/** Opens the modal. Renders nothing for anyone but the coin's creator. */
export function XAutomationButton({ coin, variant }: { coin: Coin; variant: "desktop" | "phone" }) {
  const [open, setOpen] = useState(false);
  if (!useCreatorMatch(coin)) return null;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        className={variant === "desktop" ? "btn-ghost h-9 px-3" : "flex h-11 shrink-0 items-center gap-1.5 rounded-full border border-line px-4 text-[13px] font-medium text-muted transition-colors duration-100 ease-out active:border-line-accent active:text-cream"}
      >
        <XLogo className="h-3.5 w-3.5" /> {variant === "desktop" ? "X automation" : "X bot"}
      </button>
      <XAutomationModal open={open} onClose={() => setOpen(false)} coin={coin} />
    </>
  );
}

type Load = { kind: "off" } | { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; status: SentinelStatus };

export function XAutomationModal({ open, onClose, coin }: { open: boolean; onClose: () => void; coin: Coin }) {
  const { publicKey, signMessage } = useWallet();
  const { toast } = useApp();
  const [load, setLoad] = useState<Load>({ kind: sentinelConfigured() ? "loading" : "off" });
  const [draft, setDraft] = useState<SentinelSettings>(DEFAULT_SETTINGS);
  const [saving, setSaving] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!open || !sentinelConfigured()) return;
    const ctl = new AbortController();
    setLoad({ kind: "loading" });
    fetchSentinelStatus(coin.mint, ctl.signal)
      .then((status) => {
        setLoad({ kind: "ready", status });
        setDraft(status.settings ?? DEFAULT_SETTINGS);
      })
      .catch((e: unknown) => !ctl.signal.aborted && setLoad({ kind: "error", message: e instanceof Error ? e.message : "no answer" }));
    return () => ctl.abort();
  }, [open, coin.mint, attempt]);

  const saved = load.kind === "ready" ? (load.status.settings ?? DEFAULT_SETTINGS) : DEFAULT_SETTINGS;
  const dirty = useMemo(() => canonicalSettingsJson(draft) !== canonicalSettingsJson(saved), [draft, saved]);
  const signer = publicKey?.toBase58();
  // A demo-mode coin was simulated in this browser and has no bonding curve on-chain, so the sentinel can't watch it
  // (and refuses its settings): the modal shows what X automation offers, but can't save.
  const blocker = isDemo
    ? `$${coin.ticker} is a demo coin, simulated in this browser, so the sentinel has no on-chain curve to watch. X automation saves for coins launched on-chain (chain mode).`
    : load.kind !== "ready"
      ? null
      : !signer
        ? `Connect the wallet that launched $${coin.ticker} to save.`
        : signer !== coin.creator
          ? `Only the wallet that launched $${coin.ticker} can change this.`
          : !signMessage
            ? "This wallet can't sign messages."
            : null;
  const editable = load.kind === "ready" && !saving;
  const account = load.kind === "ready" ? load.status.account : null;

  const save = async () => {
    if (!signer || !signMessage || blocker) return;
    setSaving(true);
    try {
      const status = await saveSentinelSettings(coin.mint, draft, signer, signMessage);
      setLoad({ kind: "ready", status });
      toast({ tone: "good", title: "X automation saved", body: status.account ? `The sentinel posts as @${status.account.username}${status.mode === "dry-run" ? " (dry run)" : ""}` : "No X account is linked yet" });
      onClose();
    } catch (e) {
      toast({ tone: "bad", title: "Couldn't save", body: e instanceof Error ? e.message : "The sentinel didn't answer" });
    } finally {
      setSaving(false);
    }
  };

  const milestone = (key: keyof SentinelSettings["milestones"], on: boolean) => setDraft((d) => ({ ...d, milestones: { ...d.milestones, [key]: on } }));

  const isMobile = useIsMobile();
  const body = (
    <>
        <p className="mt-0.5 text-[13px] text-muted">Milestone posts and cashtag replies for ${coin.ticker}, run by the X sentinel.</p>

        <StatusCard load={load} onRetry={() => setAttempt((n) => n + 1)} ticker={coin.ticker} />

        <fieldset disabled={!editable} className={cx("mt-5 space-y-5", !editable && "opacity-50")}>
          <section>
            <h3 className="text-[13px] font-semibold text-cream">Milestone posts</h3>
            <div className="mt-2 grid grid-cols-2 gap-2 max-[359px]:grid-cols-1">
              {SENTINEL_MILESTONES.map((m) => (
                <label key={m.key} className="flex min-h-11 cursor-pointer items-center gap-2.5 rounded-lg border border-line bg-canvas px-3 text-[13px] text-cream has-[:checked]:border-gold/50">
                  <input type="checkbox" checked={draft.milestones[m.key]} onChange={(e) => milestone(m.key, e.target.checked)} className="h-4 w-4 accent-gold" />
                  {m.label}
                </label>
              ))}
            </div>
          </section>

          <section>
            <label className="flex min-h-11 cursor-pointer items-start gap-2.5 rounded-lg border border-line bg-canvas px-3 py-2.5 has-[:checked]:border-gold/50">
              <input type="checkbox" checked={draft.cashtagReplies} onChange={(e) => setDraft((d) => ({ ...d, cashtagReplies: e.target.checked }))} className="mt-0.5 h-4 w-4 shrink-0 accent-gold" />
              <span>
                <span className="block text-[13px] font-semibold text-cream">Cashtag replies</span>
                <span className="block text-[12px] leading-[18px] text-muted">
                  Reply to posts that mention {account ? `@${account.username}` : "the project's account"} and include ${coin.ticker}, once per person a day, up to 10 an hour. Posts that only use the cashtag aren't answered: X doesn't allow automated replies found by keyword search.
                </span>
              </span>
            </label>
          </section>

          <section>
            <h3 className="text-[13px] font-semibold text-cream">Persona</h3>
            <div role="radiogroup" aria-label="Persona" className="mt-2 grid gap-2">
              {SENTINEL_TONES.map((t) => (
                <label key={t.value} className="flex min-h-11 cursor-pointer items-center gap-2.5 rounded-lg border border-line bg-canvas px-3 py-2 has-[:checked]:border-gold/60 has-[:checked]:bg-gold/[0.06]">
                  <input type="radio" name="sentinel-tone" value={t.value} checked={draft.tone === t.value} onChange={() => setDraft((d) => ({ ...d, tone: t.value }))} className="h-4 w-4 accent-gold" />
                  <span>
                    <span className="block text-[13px] font-semibold text-cream">{t.label}</span>
                    <span className="block text-[12px] text-muted">{t.hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </section>

          <section>
            <label htmlFor="sentinel-context" className="text-[13px] font-semibold text-cream">
              Project context
            </label>
            <p className="text-[12px] text-muted">The first line is quoted as the latest news in posts and replies. Keep it factual: it's posted from the project's account.</p>
            <textarea
              id="sentinel-context"
              value={draft.context}
              maxLength={CONTEXT_MAX}
              rows={4}
              onChange={(e) => setDraft((d) => ({ ...d, context: e.target.value }))}
              placeholder={"Whitepaper v2 is live.\nRoadmap: staking next week."}
              className="mt-2 w-full resize-y rounded-lg border border-line bg-canvas px-3 py-2.5 text-[13px] leading-5 text-cream placeholder:text-muted/70 focus:border-gold/60 focus:outline-none"
            />
            <p className="num mt-1 text-right text-[11.5px] text-muted">
              {draft.context.length}/{CONTEXT_MAX}
            </p>
          </section>
        </fieldset>

        {blocker && <p className="mt-4 text-[12.5px] text-rosebronze">{blocker}</p>}
        <div className="mt-5 flex items-center justify-end gap-2">
          <button type="button" onClick={onClose} className="btn-ghost h-11 px-4">
            Cancel
          </button>
          <button type="button" onClick={save} disabled={!editable || !!blocker || !dirty} className="btn-gold h-11 px-5 disabled:cursor-not-allowed disabled:opacity-50">
            {saving && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
            {saving ? "Signing…" : "Sign and save"}
          </button>
        </div>
        <p className="mt-2 text-right text-[11.5px] text-muted">Saving asks your wallet to sign a message. No transaction, no fee.</p>
    </>
  );
  // On a phone a bottom sheet, which sits above the floating nav (a full-screen Modal rendered in the page would not).
  if (isMobile)
    return (
      <BottomSheet open={open} onClose={onClose} title={`X automation · $${coin.ticker}`}>
        <div className="pb-2">{body}</div>
      </BottomSheet>
    );
  return (
    <Modal open={open} onClose={onClose} label={`X automation for $${coin.ticker}`} className="max-w-lg" manageFocus>
      <div className="px-6 pb-6 pt-5">
        <h2 className="flex items-center gap-2 pr-10 text-[17px] font-semibold leading-7 text-cream">
          <XLogo className="h-4 w-4 text-gold" /> X automation
        </h2>
        {body}
      </div>
    </Modal>
  );
}

function StatusCard({ load, onRetry, ticker }: { load: Load; onRetry: () => void; ticker: string }) {
  const box = "mt-4 flex items-start gap-3 rounded-xl border border-line bg-surface p-3.5 text-[12.5px] leading-[18px]";
  if (load.kind === "off")
    return (
      <div className={box}>
        <PlugZap className="mt-0.5 h-4 w-4 shrink-0 text-copper" aria-hidden />
        <p className="text-muted">
          <span className="font-semibold text-cream">The X sentinel isn't connected.</span> Run services/twitter-sentinel and set VITE_SENTINEL_URL to its address to turn on X automation for ${ticker}.
        </p>
      </div>
    );
  if (load.kind === "loading")
    return (
      <div className={box}>
        <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-copper" aria-hidden />
        <p className="text-muted">Checking the sentinel…</p>
      </div>
    );
  if (load.kind === "error")
    return (
      <div className={box}>
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-ember" aria-hidden />
        <p className="min-w-0 flex-1 text-muted">
          <span className="font-semibold text-cream">Couldn't reach the sentinel.</span> {load.message}
        </p>
        <button type="button" onClick={onRetry} className="btn-ghost h-9 shrink-0 px-3 text-[12px]">
          <RefreshCw className="h-3.5 w-3.5" aria-hidden /> Retry
        </button>
      </div>
    );
  const { account, mode } = load.status;
  return (
    <div className={box}>
      <XLogo className="mt-0.5 h-4 w-4 shrink-0 text-gold" />
      <p className="min-w-0 flex-1 text-muted">
        {account ? (
          <>
            Posting as <span className="font-semibold text-cream">@{account.username}</span>
          </>
        ) : (
          <>
            <span className="font-semibold text-cream">No X account linked yet.</span> The sentinel's operator links the project's account; your settings are kept until then.
          </>
        )}
      </p>
      <span className={cx("shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-semibold", mode === "live" ? "border-gold/50 text-gold" : "border-line text-rosebronze")}>{mode === "live" ? "Live" : "Dry run"}</span>
    </div>
  );
}

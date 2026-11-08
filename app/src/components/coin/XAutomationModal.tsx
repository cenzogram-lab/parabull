/**
 * X automation for a coin's creator, any time after launch: link, replace or disconnect the project's X account,
 * choose which bonding-curve milestones the X sentinel posts, turn cashtag replies on or off, pick the persona, and
 * edit the context it quotes. The bot runs in services/twitter-sentinel; this modal reads its status and sends
 * requests signed by the creator's wallet (a message signature: no transaction, no fee). Without VITE_SENTINEL_URL it
 * says the sentinel is off. On a phone it opens as a bottom sheet, like the app's other phone dialogs.
 */
import { useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { AlertTriangle, Loader2, PlugZap, RefreshCw, Unplug } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { isDemo } from "../../config";
import { useIsMobile } from "../../hooks/useMediaQuery";
import { useParabullProgram } from "../../hooks/useParabullProgram";
import { canonicalSettingsJson, CONTEXT_MAX, DEFAULT_SETTINGS, normalizeSession, SENTINEL_MILESTONES, SENTINEL_TONES, type SentinelSettings, type SentinelStatus } from "../../lib/sentinelMessage";
import { saveBlocker } from "../../lib/xAutomation";
import type { Coin } from "../../lib/types";
import { useApp } from "../../state/AppState";
import { XLogo } from "../brand/Wordmark";
import { BottomSheet } from "../mobile/MobileUi";
import { Modal } from "../ui/overlay";
import { cx } from "../ui/primitives";
import { disconnectSentinel, fetchSentinelStatus, saveSentinelSettings, sentinelConfigured } from "./sentinelClient";

/**
 * True only when a wallet is connected and it is the coin's creator. In chain mode that is the `creator` recorded on
 * the coin's bonding curve (the wallet that paid the launch ticket), read from the chain, not the coin list, which is
 * still demo data; a coin with no curve on-chain has no creator. Demo mode compares with the demo coin's creator. The
 * sentinel checks the on-chain creator again for every signed change; this only decides whether the button shows.
 */
export function useIsCreator(coin: Coin) {
  const { publicKey } = useWallet();
  const { fetchCurve } = useParabullProgram();
  const wallet = publicKey?.toBase58() ?? null;
  const [onChain, setOnChain] = useState<{ mint: string; creator: string | null } | null>(null);
  useEffect(() => {
    if (isDemo || !wallet) return;
    let mint: PublicKey;
    try {
      mint = new PublicKey(coin.mint);
    } catch {
      return setOnChain({ mint: coin.mint, creator: null });
    }
    let live = true;
    fetchCurve(mint).then(
      (c) => live && setOnChain({ mint: coin.mint, creator: c ? c.creator.toBase58() : null }),
      () => live && setOnChain({ mint: coin.mint, creator: null }),
    );
    return () => {
      live = false;
    };
  }, [coin.mint, wallet, fetchCurve]);
  if (!wallet) return false;
  if (isDemo) return wallet === coin.creator;
  return onChain?.mint === coin.mint && onChain.creator === wallet;
}

/** What the button's badge says about the sentinel for this coin. */
function badgeOf(status: SentinelStatus | null): { tone: "on" | "dry" | "off"; label: string } {
  if (!status?.active) return { tone: "off", label: "off" };
  if (!status.account) return { tone: "dry", label: "on, no X account linked" };
  return status.mode === "live" ? { tone: "on", label: `on, posting as @${status.account.username}` } : { tone: "dry", label: `on in dry run, as @${status.account.username}` };
}

/** Opens the modal. Renders nothing unless the connected wallet launched this coin. */
export function XAutomationButton({ coin, variant }: { coin: Coin; variant: "desktop" | "phone" }) {
  const isCreator = useIsCreator(coin);
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<SentinelStatus | null>(null);
  useEffect(() => {
    if (!isCreator || !sentinelConfigured()) return;
    const ctl = new AbortController();
    fetchSentinelStatus(coin.mint, ctl.signal).then(setStatus, () => {});
    return () => ctl.abort();
  }, [isCreator, coin.mint]);
  if (!isCreator) return null;
  const badge = badgeOf(status);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-label={`X automation: ${badge.label}`}
        className={variant === "desktop" ? "btn-ghost h-9 px-3" : "flex h-11 shrink-0 items-center gap-1.5 rounded-full border border-line px-4 text-[13px] font-medium text-muted transition-colors duration-100 ease-out active:border-line-accent active:text-cream"}
      >
        <XLogo className="h-3.5 w-3.5" /> {variant === "desktop" ? "X automation" : "X bot"}
        <span
          aria-hidden
          className={cx("ml-0.5 h-2 w-2 shrink-0 rounded-full", badge.tone === "on" ? "bg-gold shadow-[0_0_6px_rgba(229,169,103,0.7)]" : badge.tone === "dry" ? "bg-rosebronze" : "border border-line-accent bg-transparent")}
        />
      </button>
      <XAutomationModal open={open} onClose={() => setOpen(false)} coin={coin} isCreator={isCreator} onStatus={setStatus} />
    </>
  );
}

type Load = { kind: "off" } | { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; status: SentinelStatus };
const EMPTY_SESSION = { username: "", authToken: "", ct0: "" };

/** `isCreator`: the connected wallet created the coin, by the on-chain curve in chain mode (see useIsCreator). */
export function XAutomationModal({ open, onClose, coin, isCreator, onStatus }: { open: boolean; onClose: () => void; coin: Coin; isCreator: boolean; onStatus?: (s: SentinelStatus) => void }) {
  const { publicKey, signMessage } = useWallet();
  const { toast } = useApp();
  const [load, setLoad] = useState<Load>({ kind: sentinelConfigured() ? "loading" : "off" });
  const [draft, setDraft] = useState<SentinelSettings>(DEFAULT_SETTINGS);
  const [session, setSession] = useState(EMPTY_SESSION);
  const [replacing, setReplacing] = useState(false);
  const [busy, setBusy] = useState<"save" | "disconnect" | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [attempt, setAttempt] = useState(0);

  const loaded = useCallback(
    (status: SentinelStatus) => {
      setLoad({ kind: "ready", status });
      setDraft(status.settings ?? DEFAULT_SETTINGS);
      setSession(EMPTY_SESSION);
      setReplacing(false);
      setConfirmDisconnect(false);
      onStatus?.(status);
    },
    [onStatus],
  );

  useEffect(() => {
    if (!open || !sentinelConfigured()) return;
    const ctl = new AbortController();
    setLoad({ kind: "loading" });
    fetchSentinelStatus(coin.mint, ctl.signal)
      .then(loaded)
      .catch((e: unknown) => !ctl.signal.aborted && setLoad({ kind: "error", message: e instanceof Error ? e.message : "no answer" }));
    return () => ctl.abort();
  }, [open, coin.mint, attempt, loaded]);

  const status = load.kind === "ready" ? load.status : null;
  const account = status?.account ?? null;
  const saved = status?.settings ?? DEFAULT_SETTINGS;
  const settingsDirty = useMemo(() => canonicalSettingsJson(draft) !== canonicalSettingsJson(saved), [draft, saved]);
  const showSessionFields = !account || account.source !== "creator" || replacing;
  const sessionTyped = !!(session.username || session.authToken || session.ct0);
  const sessionCheck = sessionTyped ? normalizeSession(session) : null;
  const sessionError = sessionCheck && !sessionCheck.ok ? sessionCheck.error : null;
  const dirty = settingsDirty || (sessionCheck?.ok ?? false) || !status?.active;
  const signer = publicKey?.toBase58();
  // A demo-mode coin was simulated in this browser and has no bonding curve on-chain, so the sentinel can't watch it
  // (and refuses its settings): the modal shows what X automation offers, but can't save. In chain mode the creator
  // check is the on-chain one, not the coin list's `creator`, which is still demo data.
  const blocker = saveBlocker({ demo: isDemo, ready: load.kind === "ready", ticker: coin.ticker, signer: signer ?? null, isCreator, canSignMessages: !!signMessage });
  const editable = load.kind === "ready" && !busy;

  const save = async () => {
    if (!signer || !signMessage || blocker || sessionError) return;
    setBusy("save");
    try {
      const next = await saveSentinelSettings(coin.mint, draft, sessionCheck?.ok ? sessionCheck.value : null, signer, signMessage);
      loaded(next);
      toast({ tone: "good", title: "X automation saved", body: next.account ? `The sentinel posts as @${next.account.username}${next.mode === "dry-run" ? " (dry run)" : ""}` : "No X account is linked yet" });
      onClose();
    } catch (e) {
      toast({ tone: "bad", title: "Couldn't save", body: e instanceof Error ? e.message : "The sentinel didn't answer" });
    } finally {
      setBusy(null);
    }
  };

  const disconnect = async () => {
    if (!signer || !signMessage || blocker) return;
    if (!confirmDisconnect) return setConfirmDisconnect(true);
    setBusy("disconnect");
    try {
      loaded(await disconnectSentinel(coin.mint, signer, signMessage));
      toast({ tone: "info", title: "X automation off", body: `The sentinel stopped watching $${coin.ticker} and forgot its X session` });
      onClose();
    } catch (e) {
      toast({ tone: "bad", title: "Couldn't disconnect", body: e instanceof Error ? e.message : "The sentinel didn't answer" });
    } finally {
      setBusy(null);
      setConfirmDisconnect(false);
    }
  };

  const milestone = (key: keyof SentinelSettings["milestones"], on: boolean) => setDraft((d) => ({ ...d, milestones: { ...d.milestones, [key]: on } }));
  const field = "mt-1 h-11 w-full rounded-lg border border-line bg-canvas px-3 font-mono text-[13px] text-cream placeholder:font-sans placeholder:text-muted/70 focus:border-gold/60 focus:outline-none";

  const isMobile = useIsMobile();
  const body = (
    <>
      <p className="mt-0.5 text-[13px] text-muted">Milestone posts and cashtag replies for ${coin.ticker}, run by the X sentinel.</p>

      <StatusCard load={load} onRetry={() => setAttempt((n) => n + 1)} ticker={coin.ticker} />

      <fieldset disabled={!editable} className={cx("mt-5 space-y-5", !editable && "opacity-50")}>
        <section aria-labelledby="sentinel-account">
          <h3 id="sentinel-account" className="text-[13px] font-semibold text-cream">
            X account
          </h3>
          {account && (
            <div className="mt-2 flex min-h-11 flex-wrap items-center gap-2 rounded-lg border border-line bg-canvas px-3 py-2 text-[13px]">
              <XLogo className="h-3.5 w-3.5 text-gold" />
              <span className="font-semibold text-cream">@{account.username}</span>
              <span className="text-[12px] text-muted">{account.source === "creator" ? `linked by you${account.linkedAt ? ` on ${new Date(account.linkedAt).toLocaleDateString()}` : ""}` : "set up by the sentinel's operator"}</span>
              {account.source === "creator" && !replacing && (
                <button type="button" onClick={() => setReplacing(true)} className="btn-ghost ml-auto h-9 px-3 text-[12px]">
                  Update session
                </button>
              )}
            </div>
          )}
          {showSessionFields && (
            <div className="mt-2 rounded-lg border border-line bg-surface p-3">
              <p className="text-[12px] leading-[18px] text-muted">
                {account?.source === "creator" ? "Paste fresh cookies to replace the session; the sentinel switches over without a restart." : "Link the project's X account."} From x.com, signed in as that account, copy the <span className="font-mono text-cream">auth_token</span> and{" "}
                <span className="font-mono text-cream">ct0</span> cookies (browser developer tools, Application, Cookies). They give full access to the account: the sentinel keeps them sealed and never shows them again.{account ? " Leave these empty to keep the current session." : ""}
              </p>
              <div className="mt-3 grid gap-2">
                <label className="text-[12px] text-muted">
                  X handle
                  <input value={session.username} onChange={(e) => setSession((s) => ({ ...s, username: e.target.value }))} placeholder="@ProjectAccount" autoComplete="off" spellCheck={false} className={field} />
                </label>
                <label className="text-[12px] text-muted">
                  auth_token
                  <input type="password" value={session.authToken} onChange={(e) => setSession((s) => ({ ...s, authToken: e.target.value }))} autoComplete="off" spellCheck={false} className={field} />
                </label>
                <label className="text-[12px] text-muted">
                  ct0
                  <input type="password" value={session.ct0} onChange={(e) => setSession((s) => ({ ...s, ct0: e.target.value }))} autoComplete="off" spellCheck={false} className={field} />
                </label>
              </div>
              {sessionError && <p className="mt-2 text-[12px] text-ember">{sessionError}</p>}
              {replacing && (
                <button type="button" onClick={() => (setReplacing(false), setSession(EMPTY_SESSION))} className="mt-2 text-[12px] text-muted underline-offset-2 hover:underline">
                  Keep the current session
                </button>
              )}
            </div>
          )}
        </section>

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
          <p className="text-[12px] text-muted">The first line is quoted as the latest news in posts and replies; add new lore at the top. Keep it factual: it's posted from the project's account.</p>
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
      <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
        {status?.active && (
          <button type="button" onClick={disconnect} disabled={!editable || !!blocker} className={cx("btn-ghost mr-auto h-11 px-4 disabled:cursor-not-allowed disabled:opacity-50", confirmDisconnect ? "border-ember/60 text-ember" : "text-muted")}>
            {busy === "disconnect" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Unplug className="h-4 w-4" aria-hidden />}
            {confirmDisconnect ? "Sign to disconnect" : account?.source === "creator" ? "Disconnect X account" : "Turn off X automation"}
          </button>
        )}
        <button type="button" onClick={onClose} className="btn-ghost h-11 px-4">
          Cancel
        </button>
        <button type="button" onClick={save} disabled={!editable || !!blocker || !dirty || !!sessionError} className="btn-gold h-11 px-5 disabled:cursor-not-allowed disabled:opacity-50">
          {busy === "save" && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
          {busy === "save" ? "Signing…" : "Sign and save"}
        </button>
      </div>
      {confirmDisconnect && <p className="mt-2 text-right text-[11.5px] text-ember">The sentinel stops watching ${coin.ticker} and deletes its X session. Settings are cleared too.</p>}
      <p className="mt-2 text-right text-[11.5px] text-muted">Saving or disconnecting asks your wallet to sign a message. No transaction, no fee.</p>
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
  const { account, mode, active } = load.status;
  return (
    <div className={box}>
      <XLogo className="mt-0.5 h-4 w-4 shrink-0 text-gold" />
      <p className="min-w-0 flex-1 text-muted">
        {!active ? (
          <>
            <span className="font-semibold text-cream">Not watching ${ticker} yet.</span> Save to start: milestones it has already passed aren't posted.
          </>
        ) : account ? (
          <>
            Watching ${ticker}, posting as <span className="font-semibold text-cream">@{account.username}</span>
          </>
        ) : (
          <>
            <span className="font-semibold text-cream">Watching ${ticker}, no X account linked.</span> Link one below; nothing is posted until then.
          </>
        )}
      </p>
      <span className={cx("shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-semibold", !active ? "border-line text-muted" : mode === "live" ? "border-gold/50 text-gold" : "border-line text-rosebronze")}>{!active ? "Off" : mode === "live" ? "Live" : "Dry run"}</span>
    </div>
  );
}

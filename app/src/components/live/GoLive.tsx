/**
 * Going live, for the coin's creator only (useIsCreator: the on-chain creator in chain mode). The button sits beside
 * X automation on the coin page; the dialog gets the creator's Cloudflare Stream live input from the edge Worker
 * (POST /live/input, which checks the on-chain creator again) and shows how to broadcast to it from OBS or any
 * encoder: the RTMPS server and stream key (hidden until shown), or SRT. Viewers see it on the coin page and /live
 * once Stream reports the input live (within ~15 seconds), played over HLS.
 *
 * No in-browser camera option: Cloudflare Stream can't play WebRTC (WHIP) broadcasts over HLS or record them
 * (https://developers.cloudflare.com/stream/webrtc/, Limitations), so viewers here would see nothing.
 */
import { useWallet } from "@solana/wallet-adapter-react";
import { Check, Copy, Eye, EyeOff, Loader2, Radio } from "lucide-react";
import { useState } from "react";
import { CONFIG } from "../../config";
import { useIsMobile } from "../../hooks/useMediaQuery";
import { useLiveStreams } from "../../hooks/useLiveStreams";
import { chatEndpoints } from "../../lib/chatClient";
import { dropSession, signInToEdge } from "../../lib/edgeSession";
import type { Coin } from "../../lib/types";
import { useIsCreator } from "../coin/XAutomationModal";
import { BottomSheet } from "../mobile/MobileUi";
import { Modal } from "../ui/overlay";
import { cx } from "../ui/primitives";

export interface LiveInputCreds {
  input: string;
  mint: string;
  title: string | null;
  rtmps: { url: string; streamKey: string } | null;
  srt: { url: string; streamId: string; passphrase: string } | null;
  hls: string;
}

/** "Go live" beside X automation. Renders nothing unless streaming is configured and the wallet launched the coin. */
export function GoLiveButton({ coin, variant }: { coin: Coin; variant: "desktop" | "phone" }) {
  const isCreator = useIsCreator(coin);
  const live = useLiveStreams();
  const [open, setOpen] = useState(false);
  if (!isCreator || !live.configured) return null;
  const onAir = live.streams.some((s) => s.mint === coin.mint);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        className={cx(
          variant === "desktop" ? "btn-ghost h-9 px-3" : "flex h-11 shrink-0 items-center gap-1.5 rounded-full border px-4 text-[13px] font-medium transition-colors duration-100 ease-out",
          variant === "phone" && (onAir ? "border-ember/60 text-cream" : "border-line text-muted active:border-line-accent active:text-cream"),
          variant === "desktop" && onAir && "border-ember/60 text-cream",
        )}
      >
        <Radio className={cx("h-3.5 w-3.5", onAir ? "text-ember" : "")} aria-hidden /> {onAir ? "Live now" : "Go live"}
      </button>
      <GoLiveDialog open={open} onClose={() => setOpen(false)} coin={coin} />
    </>
  );
}

function CopyField({ label, value, secret = false }: { label: string; value: string; secret?: boolean }) {
  const [shown, setShown] = useState(!secret);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      setShown(true);
    }
  };
  const btn = "btn-icon h-9 w-9 shrink-0 border border-line max-md:h-11 max-md:w-11";
  return (
    <div>
      <div className="label mb-1">{label}</div>
      <div className="flex items-center gap-1.5">
        <code className="input flex h-9 min-w-0 flex-1 items-center truncate font-mono text-[12.5px] max-md:h-11" aria-label={label}>
          {shown ? value : "•".repeat(Math.min(24, value.length))}
        </code>
        {secret && (
          <button type="button" onClick={() => setShown((s) => !s)} className={btn} aria-label={shown ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}>
            {shown ? <EyeOff className="h-4 w-4" aria-hidden /> : <Eye className="h-4 w-4" aria-hidden />}
          </button>
        )}
        <button type="button" onClick={copy} className={btn} aria-label={`Copy ${label.toLowerCase()}`}>
          {copied ? <Check className="h-4 w-4 text-gold" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}
        </button>
      </div>
    </div>
  );
}

function GoLiveDialog({ open, onClose, coin }: { open: boolean; onClose: () => void; coin: Coin }) {
  const isMobile = useIsMobile();
  const { publicKey, signMessage } = useWallet();
  const endpoints = chatEndpoints(CONFIG.chatUrl);
  const [creds, setCreds] = useState<LiveInputCreds | null>(null);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const request = async () => {
    const wallet = publicKey?.toBase58();
    if (!endpoints || !wallet) return;
    setBusy(true);
    setError(null);
    try {
      const session = await signInToEdge(endpoints.session, wallet, signMessage);
      const res = await fetch(endpoints.liveInput, { method: "POST", headers: { authorization: `Bearer ${session.token}`, "content-type": "application/json" }, body: JSON.stringify({ mint: coin.mint, ...(title.trim() ? { title: title.trim() } : {}) }) });
      const json = (await res.json().catch(() => ({}))) as Partial<LiveInputCreds> & { error?: string };
      if (res.status === 401) dropSession(wallet);
      if (!res.ok || !json.input) throw new Error(res.status === 404 ? "This coin isn't on-chain, so it can't go live (demo coins can't)." : (json.error ?? `Couldn't get your stream (${res.status})`));
      setCreds(json as LiveInputCreds);
      if (json.title && !title) setTitle(json.title);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const body = (
    <div className="space-y-4">
      <p className="text-[13px] text-muted">Stream to ${coin.ticker}'s page and /live from OBS or any encoder. Only the wallet that launched the coin can.</p>
      <div>
        <label className="label mb-1 block" htmlFor="go-live-title">
          Stream title
        </label>
        <div className="flex gap-2">
          <input id="go-live-title" className="input h-10 min-w-0 flex-1 text-sm max-md:h-11 max-md:text-[16px]" maxLength={80} placeholder={`${coin.name} live`} value={title} onChange={(e) => setTitle(e.target.value)} />
          {creds && (
            <button type="button" onClick={request} disabled={busy} className="btn-ghost h-10 shrink-0 px-3 text-sm max-md:h-11">
              Save
            </button>
          )}
        </div>
      </div>

      {!creds ? (
        <button type="button" onClick={request} disabled={busy || !endpoints} className="btn-gold h-11 w-full text-[14px]">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Radio className="h-4 w-4" aria-hidden />} Set up my stream
        </button>
      ) : (
        <div className="space-y-3">
          {creds.rtmps && (
            <>
              <CopyField label="Server" value={creds.rtmps.url} />
              <CopyField label="Stream key" value={creds.rtmps.streamKey} secret />
            </>
          )}
          {creds.srt && (
            <details className="rounded-lg border border-line-soft p-2.5 text-[13px]">
              <summary className="cursor-pointer font-semibold">SRT instead</summary>
              <div className="mt-2 space-y-2">
                <CopyField label="SRT URL" value={creds.srt.url} />
                <CopyField label="Stream ID" value={creds.srt.streamId} />
                <CopyField label="Passphrase" value={creds.srt.passphrase} secret />
              </div>
            </details>
          )}
          <p className="text-[12px] text-muted">In OBS: Settings → Stream → Service "Custom…", then paste the server and key. Anyone with the key can stream as you: keep it private.</p>
        </div>
      )}
      {error && (
        <p className="text-[13px] text-ember" role="alert">
          {error}
        </p>
      )}
    </div>
  );

  if (isMobile)
    return (
      <BottomSheet open={open} onClose={onClose} title={`Go live · $${coin.ticker}`}>
        <div className="pb-2">{body}</div>
      </BottomSheet>
    );
  return (
    <Modal open={open} onClose={onClose} label={`Go live on $${coin.ticker}`} className="max-w-lg" manageFocus>
      <div className="px-6 pb-6 pt-5">
        <h2 className="mb-3 flex items-center gap-2 pr-10 text-[17px] font-semibold leading-7 text-cream">
          <Radio className="h-4 w-4 text-ember" aria-hidden /> Go live
        </h2>
        {body}
      </div>
    </Modal>
  );
}

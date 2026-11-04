import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { Check, ChevronDown, CircleAlert, Clock, Globe, ImagePlus, Loader2, Lock, Rocket, Send, ShieldCheck, Ticket, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { BullMark } from "../components/brand/BullMark";
import { XLogo } from "../components/brand/Wordmark";
import { CoinRow } from "../components/coin/CoinViews";
import { Modal } from "../components/ui/overlay";
import { cx } from "../components/ui/primitives";
import { CONFIG, explorer, isDemo } from "../config";
import { useNow } from "../hooks/useNow";
import { OVERLAY_MS } from "../hooks/usePresence";
import { useParabullProgram } from "../hooks/useParabullProgram";
import { coinArt } from "../lib/art";
import { canonicalTicker, nameHash, normalizeName, parseTweetId, tweetIdHash } from "../lib/launchRules";
import { checkUri, uploadMetadata } from "../lib/metadata";
import { initialReserves, mcapSol, priceSol, PROTOCOL } from "../lib/protocol";
import { toHex } from "../lib/sha256";
import type { Coin } from "../lib/types";
import { SOL_USD } from "../mock/coins";
import { useApp } from "../state/AppState";
import { useMarket } from "../state/Market";

type Phase = { step: "form" } | { step: "running"; at: number; delayMs: number; started: number; ticket?: string; signature?: string } | { step: "done"; mint: string; name: string } | { step: "failed"; error: string };

/** Uniform 3000-15000 ms from the browser CSPRNG (demo stand-in for the launch worker). */
const randomDelay = () => 3000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 12001);

function Field({ label, hint, error, children, right }: { label: string; hint?: ReactNode; error?: string | null; children: ReactNode; right?: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 flex items-center justify-between text-[13px] font-semibold">
        {label}
        {right}
      </span>
      {children}
      {error ? <span className="mt-1 flex items-center gap-1 text-xs text-ember"><CircleAlert className="h-3 w-3" />{error}</span> : hint ? <span className="mt-1 block text-xs text-muted">{hint}</span> : null}
    </label>
  );
}

function LaunchForm({ onClose }: { onClose?: () => void }) {
  const client = useParabullProgram();
  const { setVisible } = useWalletModal();
  const { coins, demoLaunch } = useMarket();
  const { sfx, toast } = useApp();
  const navigate = useNavigate();
  const now = useNow();
  const [name, setName] = useState("");
  const [ticker, setTicker] = useState("");
  const [description, setDescription] = useState("");
  const [image, setImage] = useState<{ url: string; file: File } | null>(null);
  const [drag, setDrag] = useState(false);
  const [tweet, setTweet] = useState("");
  const [socialsOpen, setSocialsOpen] = useState(false);
  const [socials, setSocials] = useState({ website: "", x: "", telegram: "" });
  const [manualUri, setManualUri] = useState("");
  const [phase, setPhase] = useState<Phase>({ step: "form" });
  const [fees, setFees] = useState<{ deposit: bigint; fee: bigint }>({ deposit: PROTOCOL.ticketDepositLamports, fee: PROTOCOL.launchFeeLamports });
  const fileInput = useRef<HTMLInputElement>(null);

  // Chain mode: show the live ticket price from Global.
  useEffect(() => {
    if (isDemo) return;
    client
      .fetchGlobal()
      .then((g) => g && setFees({ deposit: BigInt(g.ticketDepositLamports.toString()), fee: BigInt(g.launchFeeLamports.toString()) }))
      .catch(() => undefined);
  }, [client]);

  const t = canonicalTicker(ticker);
  const n = normalizeName(name);
  const tw = tweet.trim() ? parseTweetId(tweet) : null;
  const hash = n.ok ? nameHash(name) : null;

  // Lock pre-check against registries (demo: the demo board; chain: the registry PDAs).
  const [chainLocks, setChainLocks] = useState<{ ticker: boolean; name: boolean; tweet: boolean }>({ ticker: false, name: false, tweet: false });
  const demoLocks = useMemo(() => {
    const active = coins.filter((c) => c.locks.ticker > now);
    return {
      ticker: t.ok && active.some((c) => c.ticker === t.value),
      name: !!hash && active.some((c) => toHex(nameHash(c.name) ?? new Uint8Array()) === toHex(hash)),
      tweet: !!tw?.ok && active.some((c) => c.tweetId === tw.value.toString() && c.locks.tweet! > now),
    };
  }, [coins, t, hash, tw, now]);
  useEffect(() => {
    if (isDemo) return;
    const id = window.setTimeout(async () => {
      const locked = async (fetch: () => Promise<{ launchTimestamp: { toNumber: () => number } } | null>) => {
        const r = await fetch().catch(() => null);
        return !!r && Date.now() / 1000 < r.launchTimestamp.toNumber() + PROTOCOL.registryLockSeconds;
      };
      setChainLocks({
        ticker: t.ok ? await locked(() => client.program.account.tickerRegistry.fetchNullable(client.pdas.tickerRegistry(t.value))) : false,
        name: hash ? await locked(() => client.program.account.nameRegistry.fetchNullable(client.pdas.nameRegistry(hash))) : false,
        tweet: tw?.ok ? await locked(() => client.program.account.tweetRegistry.fetchNullable(client.pdas.tweetRegistry(tweetIdHash(tw.value)))) : false,
      });
    }, 400);
    return () => window.clearTimeout(id);
  }, [client, t.ok, t.ok ? t.value : "", hash ? toHex(hash) : "", tw?.ok ? tw.value.toString() : ""]); // eslint-disable-line react-hooks/exhaustive-deps
  const locks = isDemo ? demoLocks : chainLocks;

  const needsUri = !isDemo && !CONFIG.metadataUploadUrl;
  const uriError = needsUri && manualUri ? checkUri(manualUri) : null;
  const errors = {
    name: name && !n.ok ? n.error : locks.name ? "This name (ignoring case, spaces and symbols) is locked for 3 days" : null,
    ticker: ticker && !t.ok ? t.error : locks.ticker ? "This ticker is locked for 3 days" : null,
    tweet: tw && !tw.ok ? tw.error : locks.tweet ? "This tweet already backed a launch in the last 3 days" : null,
  };
  const ready = n.ok && t.ok && !errors.name && !errors.ticker && !errors.tweet && (isDemo || image) && (!needsUri || (manualUri && !uriError));

  const draft: Coin = useMemo(() => {
    const r = initialReserves();
    const lock = Date.now() + PROTOCOL.registryLockSeconds * 1000;
    return {
      mint: "preview",
      name: name.trim() || "Your coin",
      ticker: t.ok ? t.value : "TICKER",
      image: image?.url ?? coinArt(name.trim() || "preview", t.ok ? t.value : "?"),
      description,
      creator: client.publicKey?.toBase58() ?? "you",
      creatorHandle: "you",
      createdAt: Date.now(),
      stage: "new",
      reserves: r,
      complete: false,
      migrated: false,
      priceUsd: priceSol(r) * SOL_USD,
      mcapUsd: mcapSol(r) * SOL_USD,
      athUsd: mcapSol(r) * SOL_USD,
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
      locks: { ticker: lock, name: lock, tweet: tw?.ok ? lock : null },
      tweetId: tw?.ok ? tw.value.toString() : null,
      escrowUsd: 0,
      escrowReleased: false,
      spark: [],
      socials: {},
      hot: false,
    };
  }, [name, t, image, description, tw, client.publicKey]);

  function pickFile(f: File | undefined) {
    if (!f || !f.type.startsWith("image/")) return;
    if (f.size > 5 * 1024 * 1024) return toast({ tone: "bad", title: "Image too large", body: "Use an image under 5 MB." });
    const reader = new FileReader();
    reader.onload = () => setImage({ url: String(reader.result), file: f });
    reader.readAsDataURL(f);
  }

  async function submit() {
    if (!ready || !t.ok) return;
    if (!isDemo && !client.connected) return setVisible(true);
    const started = Date.now();
    if (isDemo) {
      const delayMs = randomDelay();
      setPhase({ step: "running", at: 1, delayMs, started });
      window.setTimeout(() => setPhase({ step: "running", at: 2, delayMs, started: Date.now() }), 900);
      window.setTimeout(() => {
        const coin = demoLaunch({ name: name.trim(), ticker: t.value, description, image: image?.url ?? null, tweetId: tw?.ok ? tw.value.toString() : null, socials: { x: socials.x || undefined, website: socials.website || undefined, telegram: socials.telegram || undefined } }, client.publicKey?.toBase58() ?? "demo");
        sfx("launch");
        setPhase({ step: "done", mint: coin.mint, name: coin.name });
      }, 900 + delayMs);
      return;
    }
    try {
      setPhase({ step: "running", at: 0, delayMs: 0, started });
      const uri = CONFIG.metadataUploadUrl
        ? await uploadMetadata(CONFIG.metadataUploadUrl, { name: name.trim(), symbol: t.value, description, image: image!.file, website: socials.website, x: socials.x, telegram: socials.telegram })
        : manualUri.trim();
      const req = await client.requestLaunch({ name: name.trim(), symbol: t.value, uri, tweetId: tw?.ok ? tw.value : null });
      setPhase({ step: "running", at: 2, delayMs: 15000, started: Date.now(), ticket: req.ticket.toBase58(), signature: req.signature });
      const mint = await client.waitForLaunch(req.ticket, t.value, req.requestedAt);
      if (!mint) throw new Error("The launch worker refunded your ticket (the metadata or tweet didn't pass its checks). The 0.230 SOL is back in your wallet.");
      sfx("launch");
      setPhase({ step: "done", mint: mint.toBase58(), name: name.trim() });
    } catch (e) {
      setPhase({ step: "failed", error: (e as Error).message });
    }
  }

  if (phase.step !== "form") return <LaunchProgress phase={phase} onReset={() => setPhase({ step: "form" })} onView={(m) => (onClose?.(), navigate(`/coin/${m}`))} />;

  const deposit = Number(fees.deposit) / 1e9;
  const fee = Number(fees.fee) / 1e9;
  return (
    <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
      <div className="space-y-4 p-6 max-md:px-4 max-md:py-5">
        {/* In the full-screen mobile modal, keep the intro clear of the close button. */}
        <div className={onClose ? "max-md:pr-12" : undefined}>
          <h2 className="flex items-center gap-2 text-xl font-semibold">
            <Rocket className="h-5 w-5 text-copper" /> Start a coin
          </h2>
          <p className="mt-1 text-[13px] text-muted">Blind launch: you pay a flat ticket, the launch authority creates the coin after a random delay, and nobody (you included) can trade in the creation block.</p>
        </div>
        <Field
          label="Name"
          error={errors.name}
          right={<span className="num text-xs font-normal text-muted">{new TextEncoder().encode(name.trim()).length}/32 bytes</span>}
          hint={
            n.ok ? (
              <>
                Lock key: <span className="font-mono text-rosebronze">{n.value.key}</span>
                {n.value.fallback ? " (no ASCII letters or digits, so the raw name is the key)" : " · case, spaces and symbols are ignored, so look-alike spellings share one 3-day lock"}
              </>
            ) : (
              "Up to 32 bytes."
            )
          }
        >
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Bronze Bull" maxLength={64} />
        </Field>
        <Field label="Ticker" error={errors.ticker} hint={t.ok ? <>Registered as <span className="font-mono text-rosebronze">${t.value}</span> · locked for 3 days after launch</> : "1-10 letters or digits, stored uppercase."}>
          <div className="input-shell">
            <span className="pl-3 text-muted max-md:text-base">$</span>
            <input className="w-full bg-transparent px-1.5 py-2 uppercase text-cream outline-none max-md:h-11" value={ticker} onChange={(e) => setTicker(e.target.value.replace(/[^A-Za-z0-9$]/g, "").toUpperCase().slice(0, 11))} placeholder="BRONZE" />
          </div>
        </Field>
        <Field label="Description">
          <textarea className="input min-h-[72px] resize-none" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What's the story?" maxLength={500} />
        </Field>
        <div>
          <span className="mb-1.5 block text-[13px] font-semibold">Image</span>
          <div
            onDragOver={(e) => (e.preventDefault(), setDrag(true))}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => (e.preventDefault(), setDrag(false), pickFile(e.dataTransfer.files[0]))}
            onClick={() => fileInput.current?.click()}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => e.key === "Enter" && fileInput.current?.click()}
            className={cx("flex cursor-pointer items-center gap-4 rounded-xl border border-dashed p-4 transition-colors", drag ? "border-gold bg-gold/5" : "border-line-accent bg-canvas-2 hover:border-copper")}
          >
            {image ? <img src={image.url} alt="" className="h-16 w-16 rounded-xl object-cover" /> : <span className="flex h-16 w-16 items-center justify-center rounded-xl bg-surface-2"><ImagePlus className="h-6 w-6 text-copper" /></span>}
            <div className="text-[13px]">
              <div className="font-semibold max-md:break-all">
                {image ? (
                  image.file.name
                ) : (
                  <>
                    <span className="max-md:hidden">Drag and drop an image, or click to browse</span>
                    <span className="md:hidden">Tap to choose an image</span>
                  </>
                )}
              </div>
              <div className="text-xs text-muted">PNG, JPG, WebP or GIF up to 5 MB. Square works best.</div>
            </div>
            {image && (
              <button onClick={(e) => (e.stopPropagation(), setImage(null))} className="btn-icon ml-auto" aria-label="Remove image">
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
          <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="hidden" onChange={(e) => pickFile(e.target.files?.[0])} />
        </div>
        <Field
          label="Announcement tweet (optional)"
          error={errors.tweet}
          hint={tw?.ok ? <>Status ID {tw.value.toString()} · every URL form of this tweet maps to one on-chain lock for 3 days</> : "Paste the tweet URL that announces the launch. It's locked on-chain so it can't back another coin for 3 days."}
        >
          <div className="input-shell">
            <XLogo className="ml-3 h-3.5 w-3.5 text-muted" />
            <input className="w-full bg-transparent px-2.5 py-2 text-cream outline-none max-md:h-11 max-md:text-ellipsis" value={tweet} onChange={(e) => setTweet(e.target.value)} placeholder="https://x.com/you/status/1850000000000000000" />
          </div>
        </Field>
        <div className="rounded-xl border border-line">
          <button onClick={() => setSocialsOpen((o) => !o)} className="flex w-full items-center justify-between px-4 py-3 text-[13px] font-semibold" aria-expanded={socialsOpen}>
            Socials (optional)
            <ChevronDown className={cx("h-4 w-4 text-muted transition-transform", socialsOpen && "rotate-180")} />
          </button>
          {socialsOpen && (
            <div className="space-y-2 border-t border-line p-4">
              {(
                [
                  ["website", Globe, "https://yourcoin.xyz"],
                  ["x", XLogo, "https://x.com/yourcoin"],
                  ["telegram", Send, "https://t.me/yourcoin"],
                ] as const
              ).map(([k, Icon, ph]) => (
                <div key={k} className="input-shell">
                  <Icon className="ml-3 h-3.5 w-3.5 text-muted" />
                  <input className="w-full bg-transparent px-2.5 py-2 text-cream outline-none max-md:h-11" value={socials[k]} onChange={(e) => setSocials({ ...socials, [k]: e.target.value })} placeholder={ph} aria-label={k} />
                </div>
              ))}
            </div>
          )}
        </div>
        {needsUri && (
          <Field label="Metadata URI" error={uriError} hint="No upload service is configured (VITE_METADATA_UPLOAD_URL), so paste a pinned metadata JSON URI. It's committed on-chain with the name and ticker.">
            <input className="input" value={manualUri} onChange={(e) => setManualUri(e.target.value)} placeholder="ipfs://… or https://…" />
          </Field>
        )}

        <div className="brushed-dark rounded-xl border border-line-accent/70 p-4">
          <div className="flex items-center gap-2 text-[13px] font-semibold">
            <Ticket className="h-4 w-4 text-gold" /> Launch ticket
          </div>
          <dl className="mt-3 space-y-1.5 text-[13px]">
            <div className="flex justify-between">
              <dt className="text-muted">Protocol fee (anti-slop)</dt>
              <dd className="num max-md:shrink-0 max-md:whitespace-nowrap max-md:pl-3">{fee.toFixed(3)} SOL</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted">Rent & gas allowance (ticket, mint, curve, locks)</dt>
              <dd className="num max-md:shrink-0 max-md:whitespace-nowrap max-md:pl-3">{(deposit - fee).toFixed(3)} SOL</dd>
            </div>
            <div className="flex justify-between border-t border-line pt-2 text-[14px] font-semibold">
              <dt>You pay, all-in</dt>
              <dd className="num text-gold max-md:shrink-0 max-md:whitespace-nowrap max-md:pl-3">{deposit.toFixed(3)} SOL</dd>
            </div>
          </dl>
          <p className="mt-2 text-xs text-muted">≈ ${(deposit * SOL_USD).toFixed(2)}. Any unused allowance goes to the protocol treasury. If the coin isn't created, the ticket is refunded in full. Creator fee: 0%.</p>
        </div>

        <button onClick={submit} disabled={!ready} className="btn-gold h-12 w-full text-[15px]">
          {!isDemo && !client.connected ? "Connect wallet to launch" : `Launch for ${deposit.toFixed(3)} SOL`}
        </button>
        {isDemo && <p className="text-center text-xs text-muted">Demo mode: the launch is simulated, including the random 3-15 s delay. Nothing is sent on-chain.</p>}
      </div>

      <div className="border-t border-line bg-canvas-2/50 p-6 lg:border-l lg:border-t-0 max-md:px-4 max-md:py-5">
        <div className="lg:sticky lg:top-6">
          <div className="label mb-2">Live preview · Pro Screener</div>
          <div className="panel overflow-hidden">
            <CoinRow coin={draft} preview />
          </div>
          <div className="label mb-2 mt-6">Classic card</div>
          <div className="panel flex gap-4 p-3">
            <img src={draft.image} alt="" className="h-24 w-24 rounded-2xl object-cover" />
            <div className="min-w-0 py-1">
              <div className="truncate text-[17px] font-semibold">{draft.name}</div>
              <div className="text-[14px] text-muted">{draft.ticker} · just now</div>
              <div className="mt-1 text-[19px] font-semibold">
                ${(draft.mcapUsd / 1000).toFixed(2)}K <span className="text-sm font-medium text-muted">MC</span>
              </div>
            </div>
          </div>
          <div className="label mb-2 mt-6">What happens next</div>
          <ol className="space-y-3 text-[13px]">
            {[
              [Ticket, "You pay the flat ticket", "request_launch stores a hash of the exact name, ticker and URI, so nothing can be swapped later."],
              [Clock, "Random 3-15 s anti-bundle delay", "The launch authority co-signs create with a fresh mint keypair at an unpredictable moment."],
              [ShieldCheck, "Trading opens 2 slots after creation", "Nobody, including you, can buy in the creation block. Your first buy is an ordinary buy."],
              [Lock, "Ticker, name and tweet lock for 3 days", "Copycats can't reuse them, enforced on-chain."],
            ].map(([Icon, title, body], i) => {
              const I = Icon as typeof Ticket;
              return (
                <li key={i} className="flex gap-3">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-line-accent bg-surface-2">
                    <I className="h-3.5 w-3.5 text-copper" />
                  </span>
                  <span>
                    <span className="block font-semibold">{title as string}</span>
                    <span className="text-xs text-muted">{body as string}</span>
                  </span>
                </li>
              );
            })}
          </ol>
        </div>
      </div>
    </div>
  );
}

function LaunchProgress({ phase, onReset, onView }: { phase: Exclude<Phase, { step: "form" }>; onReset: () => void; onView: (mint: string) => void }) {
  const [tick, setTick] = useState(Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setTick(Date.now()), 100);
    return () => window.clearInterval(id);
  }, []);
  const at = phase.step === "running" ? phase.at : phase.step === "done" ? 3 : -1;
  const elapsed = phase.step === "running" && phase.at === 2 ? (tick - phase.started) / 1000 : 0;
  const steps = [
    ["Uploading metadata", isDemo ? "Pinned" : "Image and JSON pinned"],
    ["Paying launch ticket", "0.230 SOL escrowed in your ticket"],
    ["Anti-bundle delay", "Launch authority co-signs at a random moment (3-15 s)"],
    ["Coin is live", "Trading opens 2 slots after creation"],
  ];
  return (
    <div className="relative overflow-hidden p-10 max-md:px-4 max-md:py-8">
      <div className="pointer-events-none absolute -right-16 -top-10 opacity-[0.06]">
        <BullMark size={360} ring={false} title="" />
      </div>
      <div className="relative mx-auto max-w-lg text-center">
        <div className="relative mx-auto h-40 w-40">
          <svg viewBox="0 0 160 160" className={cx("h-40 w-40", phase.step === "running" && "animate-[spin_3s_linear_infinite]")} aria-hidden>
            <defs>
              <linearGradient id="ringg" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stopColor="#F8DCAE" />
                <stop offset=".5" stopColor="#C87D55" />
                <stop offset="1" stopColor="#6B4C38" stopOpacity=".2" />
              </linearGradient>
            </defs>
            <circle cx="80" cy="80" r="70" fill="none" stroke="#2A211B" strokeWidth="8" />
            <circle cx="80" cy="80" r="70" fill="none" stroke="url(#ringg)" strokeWidth="8" strokeLinecap="round" strokeDasharray={phase.step === "done" ? "440 0" : "300 140"} />
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            {phase.step === "done" ? <Check className="h-12 w-12 text-gold" strokeWidth={2.5} /> : phase.step === "failed" ? <X className="h-12 w-12 text-ember" /> : <span className="num text-4xl font-semibold">{elapsed.toFixed(1)}s</span>}
            {phase.step === "running" && phase.at === 2 && <span className="text-xs text-muted">waiting for create</span>}
          </div>
        </div>
        <h2 className="mt-6 text-xl font-semibold">{phase.step === "done" ? `${phase.name} is live` : phase.step === "failed" ? "Launch didn't go through" : "Launching your coin"}</h2>
        {phase.step === "failed" && <p className="mt-2 text-sm text-ember">{phase.error}</p>}
        <ol className="mx-auto mt-6 max-w-sm space-y-2.5 text-left">
          {steps.map(([title, body], i) => (
            <li key={title} className="flex gap-3">
              <span className={cx("mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border", i < at ? "border-gold bg-gold text-canvas" : i === at ? "border-gold text-gold" : "border-line text-muted")}>
                {i < at ? <Check className="h-3 w-3" strokeWidth={3} /> : i === at && phase.step === "running" ? <Loader2 className="h-3 w-3 animate-spin" /> : <span className="h-1.5 w-1.5 rounded-full bg-current" />}
              </span>
              <span className="text-[13px]">
                <span className={cx("block font-semibold", i > at && "text-muted")}>{title}</span>
                <span className="text-xs text-muted">{body}</span>
              </span>
            </li>
          ))}
        </ol>
        {phase.step === "running" && phase.signature && (
          <a href={explorer("tx", phase.signature)} target="_blank" rel="noreferrer" className="mt-4 inline-block text-xs text-gold hover:underline max-md:mt-2 max-md:inline-flex max-md:h-11 max-md:items-center max-md:px-2">
            View ticket transaction
          </a>
        )}
        <div className="mt-8 flex justify-center gap-3">
          {phase.step === "done" && (
            <button onClick={() => onView(phase.mint)} className="btn-gold h-11 px-6">
              View coin
            </button>
          )}
          {phase.step !== "running" && (
            <button onClick={onReset} className="btn-ghost h-11 px-5">
              {phase.step === "done" ? "Launch another" : "Back to the form"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export function CreateModal() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(true);
  // Let the 150ms exit transition play before leaving the route.
  const close = () => {
    setOpen(false);
    window.setTimeout(() => navigate(-1), OVERLAY_MS);
  };
  return (
    <Modal open={open} onClose={close} label="Start a coin" className="max-w-[1100px] overflow-hidden">
      <LaunchForm onClose={() => undefined} />
    </Modal>
  );
}

export function CreatePage() {
  return (
    <div className="p-6 max-md:p-0">
      {/* Below md the form runs edge to edge on the page instead of sitting in a card. */}
      <div className="panel mx-auto max-w-[1100px] overflow-hidden max-md:rounded-none max-md:border-0 max-md:bg-transparent max-md:shadow-none">
        <LaunchForm />
      </div>
      <p className="mt-4 text-center text-xs text-muted max-md:mt-1">
        <Link to="/" className="hover:text-cream max-md:inline-flex max-md:h-11 max-md:items-center max-md:px-4 max-md:text-[13px]">
          Back to the board
        </Link>
      </p>
    </div>
  );
}

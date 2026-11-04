import { ChartNoAxesColumn, Copy, FlaskConical, Wallet } from "lucide-react";
import { useMemo } from "react";
import { shortAddr } from "../../lib/format";
import type { Portfolio } from "../../state/usePortfolio";
import { IconButton } from "../mobile/MobileUi";
import { cx } from "../ui/primitives";
import { profileCounts } from "./shared";

/** Visually 36px, with a 44px hit area on touch screens. */
const PILL = "touch-target inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-full border border-line bg-surface text-[13px] font-semibold text-cream transition-colors duration-100 ease-out hover:border-line-accent hover:bg-surface-2 active:bg-surface-2";

/**
 * Profile head: a brushed-bronze banner (no imagery), the avatar on a
 * polished copper rim overlapping it, then the handle with a copy-address
 * button, the address, a bio placeholder and demo follow counts. "View stats"
 * and the wallet button (mobile only; desktop has the header's) sit at the
 * banner's lower edge.
 */
export function PortfolioProfile({ p, connected, walletName, walletIcon, onCopy, onStats, onWallet }: { p: Portfolio; connected: boolean; walletName?: string; walletIcon?: string; onCopy: () => void; onStats: () => void; onWallet: () => void }) {
  const counts = useMemo(() => profileCounts(p.address), [p.address]);
  return (
    // From md up the profile is a card: the banner across its top, the details inside.
    <section aria-label="Profile" className="md:overflow-hidden md:rounded-2xl md:border md:border-line md:bg-surface md:shadow-panel">
      <div aria-hidden className="brushed-dark relative h-[88px] overflow-hidden border-b border-line md:h-28">
        {/* A warm copper light from the top right, a fainter gold one low left, and a lit edge along the bottom. */}
        <div className="absolute inset-0 bg-[radial-gradient(110%_160%_at_100%_0%,rgba(200,125,85,0.30),transparent_58%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(70%_130%_at_0%_100%,rgba(229,169,103,0.10),transparent_70%)]" />
        <div className="absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-copper/60 to-transparent" />
      </div>

      <div className="px-4 md:px-6 md:pb-5">
        <div className="flex items-start justify-between gap-3">
          {/* relative: paints over the (positioned) banner it overlaps. */}
          <span className="metal-copper relative -mt-10 block shrink-0 rounded-full p-[3px] ring-[3px] ring-canvas md:ring-surface">
            <img src={p.avatar} alt="" width={72} height={72} className="block h-[72px] w-[72px] rounded-full" />
          </span>
          <div className="mt-0.5 flex items-center gap-2">
            <button type="button" onClick={onStats} aria-haspopup="dialog" className={cx(PILL, "px-3.5")}>
              <ChartNoAxesColumn className="h-4 w-4 text-copper" strokeWidth={2.25} aria-hidden />
              View stats
            </button>
            <button type="button" onClick={onWallet} aria-haspopup="dialog" aria-label={connected ? `Wallet: ${walletName ?? "connected"}` : "Wallet: demo, connect yours"} className={cx(PILL, "w-9 text-muted md:hidden")}>
              {connected && walletIcon ? <img src={walletIcon} alt="" width={18} height={18} className="h-[18px] w-[18px] rounded" /> : <Wallet className="h-[18px] w-[18px]" strokeWidth={1.9} aria-hidden />}
            </button>
          </div>
        </div>

        <div className="mt-2 flex min-w-0 items-center">
          <p className="min-w-0 truncate text-[21px] font-semibold leading-7 tracking-tight text-cream">@{p.handle}</p>
          <IconButton label={connected ? "Copy wallet address" : "Copy demo wallet address"} onClick={onCopy} className="-my-2 hover:text-cream">
            <Copy className="h-4 w-4" aria-hidden />
          </IconButton>
        </div>
        <p className="-mt-0.5 flex min-w-0 items-center gap-2 text-[12.5px] leading-5 text-muted">
          <span className="font-mono" title={p.address}>
            {shortAddr(p.address, 4)}
          </span>
          {!connected && (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-line px-2 text-[11px] font-medium leading-[18px]">
              <FlaskConical className="h-3 w-3 text-rosebronze" aria-hidden />
              Demo wallet
            </span>
          )}
        </p>
        <p className="mt-2 text-[14px] leading-5 text-muted">Add bio...</p>
        <p className="mt-2 flex items-center gap-4 text-[13.5px] leading-5 text-muted">
          <span>
            <span className="num font-semibold text-cream">{counts.following.toLocaleString("en-US")}</span> Following
          </span>
          <span>
            <span className="num font-semibold text-cream">{counts.followers.toLocaleString("en-US")}</span> Followers
          </span>
        </p>
      </div>
    </section>
  );
}

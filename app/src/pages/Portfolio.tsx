/**
 * Portfolio: your profile, net equity and its curve, then Open / Closed /
 * Replies / Rewards, and Deposit / Receive. Built mobile-first; from md up the
 * same page sits in a centered max-w-3xl column inside the desktop shell.
 */
import { ArrowDownLeft, Plus } from "lucide-react";
import { useRef, useState } from "react";
import { type TabOption, MobileTabs } from "../components/mobile/MobileUi";
import { ClosedPanel, OpenPanel, RepliesPanel } from "../components/portfolio/PortfolioPanels";
import { PortfolioEquity } from "../components/portfolio/PortfolioEquity";
import { PortfolioProfile } from "../components/portfolio/PortfolioProfile";
import { BalanceSheet, ReceiveSheet, StatsSheet, WalletSheet } from "../components/portfolio/PortfolioSheets";
import { RewardsPanel } from "../components/portfolio/RewardsPanel";
import { useRewardSummary, useWalletActions } from "../components/portfolio/shared";
import { useIsMobile } from "../hooks/useMediaQuery";
import { useMarket } from "../state/Market";
import { usePortfolio } from "../state/usePortfolio";

type Tab = "Open" | "Closed" | "Replies" | "Rewards";
type SheetKind = "stats" | "balance" | "receive" | "wallet";

/** The mobile header's height: where the sticky tab row pins. */
const HEADER_PX = 56;

export function Portfolio() {
  const p = usePortfolio();
  const { solUsd } = useMarket();
  const isMobile = useIsMobile();
  const wallet = useWalletActions(p.address);
  const [tab, setTab] = useState<Tab>("Open");
  const [sheet, setSheet] = useState<SheetKind | null>(null);
  const rewards = useRewardSummary(p.address, tab === "Rewards");
  const claimable = !!rewards && rewards.unclaimedLamports > 0n;
  const tabsAnchor = useRef<HTMLDivElement>(null);

  const tabs: TabOption<Tab>[] = [
    "Open",
    "Closed",
    "Replies",
    {
      value: "Rewards",
      label: (
        <>
          Rewards
          {claimable && <span aria-hidden className="h-1.5 w-1.5 -translate-y-1.5 rounded-full bg-gold shadow-[0_0_6px_rgba(229,169,103,0.7)]" />}
        </>
      ),
      ariaLabel: claimable ? "Rewards, unclaimed rewards" : undefined,
    },
  ];

  // Once the tab row is pinned, a new tab starts at its top rather than wherever the old one was scrolled to.
  const pick = (t: Tab) => {
    setTab(t);
    const anchor = tabsAnchor.current;
    if (!isMobile || !anchor) return;
    const top = anchor.getBoundingClientRect().top;
    if (top < HEADER_PX) window.scrollTo({ top: window.scrollY + top - HEADER_PX });
  };
  const close = () => setSheet(null);

  return (
    <div className="md:mx-auto md:max-w-3xl md:px-8 md:py-6">
      <h1 className="sr-only">Portfolio</h1>
      <PortfolioProfile p={p} connected={wallet.connected} walletName={wallet.walletName} walletIcon={wallet.walletIcon} onCopy={wallet.copyAddress} onStats={() => setSheet("stats")} onWallet={() => setSheet("wallet")} />
      <PortfolioEquity className="mt-5 px-4 md:mt-6 md:px-0" history={p.history} />

      {/* Marks where the tab row sits when it isn't pinned. */}
      <div ref={tabsAnchor} className="mt-3" />
      <MobileTabs sticky={isMobile} options={tabs} value={tab} onChange={pick} label="Portfolio" />
      <div role="tabpanel" aria-label={tab} className="px-4 pt-2 md:px-0 md:pt-3">
        {tab === "Open" && <OpenPanel p={p} onBalance={() => setSheet("balance")} />}
        {tab === "Closed" && <ClosedPanel closed={p.closed} />}
        {tab === "Replies" && <RepliesPanel p={p} />}
        {tab === "Rewards" && (
          <div className="pt-2">
            <RewardsPanel summary={rewards} solUsd={solUsd} />
          </div>
        )}
      </div>

      {/*
        Action strip. Below md it sticks just above the floating nav while the
        page scrolls, then settles in place under the last card (so it never
        covers it, or the footnote after the page); from md up it's inline.
        Its ::before is a canvas backdrop fading in just above the buttons and
        reaching down to the nav, so cards don't show around them; it stays
        inside the strip's own margins, so at rest it hides nothing. On a
        phone in landscape (under 480px tall) it stays in place after the
        page: Deposit is in the header too, and Copy address in the profile.
      */}
      <div className="pointer-events-none z-40 mx-4 mt-5 grid grid-cols-2 gap-3 max-md:sticky max-md:bottom-[calc(5rem+env(safe-area-inset-bottom))] max-md:[@media(max-height:480px)_and_(orientation:landscape)]:relative max-md:[@media(max-height:480px)_and_(orientation:landscape)]:bottom-auto max-md:before:absolute max-md:before:-inset-x-4 max-md:before:-bottom-3 max-md:before:-top-4 max-md:before:-z-10 max-md:before:bg-[linear-gradient(to_bottom,transparent,theme(colors.canvas.DEFAULT)_16px)] md:mx-0 md:mt-8">
        <button type="button" onClick={wallet.deposit} className="btn-gold pointer-events-auto h-12 rounded-2xl text-[15px] max-md:shadow-[0_10px_28px_-8px_rgba(0,0,0,0.9)]">
          <Plus className="h-[18px] w-[18px]" strokeWidth={2.5} aria-hidden />
          Deposit
        </button>
        <button type="button" onClick={() => setSheet("receive")} aria-haspopup="dialog" className="btn-ghost pointer-events-auto h-12 rounded-2xl text-[15px] active:scale-[0.98] max-md:shadow-[0_10px_28px_-8px_rgba(0,0,0,0.9)]">
          <ArrowDownLeft className="h-[18px] w-[18px] text-copper" strokeWidth={2.25} aria-hidden />
          Receive
        </button>
      </div>

      {/* Overlays sit at the page root: an ancestor with a transform or backdrop blur would trap their fixed position. */}
      <StatsSheet open={sheet === "stats"} onClose={close} p={p} />
      <BalanceSheet open={sheet === "balance"} onClose={close} p={p} />
      <ReceiveSheet open={sheet === "receive"} onClose={close} address={p.address} connected={wallet.connected} onCopy={wallet.copy} onConnect={wallet.connect} />
      <WalletSheet open={sheet === "wallet"} onClose={close} address={p.address} connected={wallet.connected} walletName={wallet.walletName} walletIcon={wallet.walletIcon} onCopy={wallet.copy} onConnect={wallet.connect} onDisconnect={wallet.disconnect} />
    </div>
  );
}

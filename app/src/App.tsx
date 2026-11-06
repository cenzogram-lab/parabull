import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { SolflareWalletAdapter } from "@solana/wallet-adapter-solflare";
import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { BrowserRouter, Navigate, NavigationType, Outlet, Route, Routes, useLocation, useNavigate, useNavigationType, type Location } from "react-router-dom";
import { MobileCreateFab } from "./components/mobile/MobileCreateFab";
import { MobileFootnote } from "./components/mobile/MobileFootnote";
import { MobileHeader } from "./components/mobile/MobileHeader";
import { MobileNav } from "./components/mobile/MobileNav";
import { showsCreateFab } from "./components/mobile/routes";
import { Dock } from "./components/shell/Dock";
import { Footer } from "./components/shell/Footer";
import { Header } from "./components/shell/Header";
import { InfoStrip } from "./components/shell/InfoStrip";
import { SearchPalette } from "./components/shell/SearchPalette";
import { Toasts } from "./components/ui/overlay";
import { cx } from "./components/ui/primitives";
import { CONFIG } from "./config";
import { useIsMobile } from "./hooks/useMediaQuery";
import { Board } from "./pages/Board";
import { CoinPage } from "./pages/CoinPage";
import { CreateModal, CreatePage } from "./pages/Create";
import { Explore } from "./pages/Explore";
import { HolderRewards } from "./pages/HolderRewards";
import { Leaderboard } from "./pages/Leaderboard";
import { Live } from "./pages/Live";
import { NotFound } from "./pages/NotFound";
import { Portfolio } from "./pages/Portfolio";
import { SearchPage } from "./pages/Search";
import { TokenHub } from "./pages/TokenHub";
import { AppStateProvider, useApp } from "./state/AppState";
import { MarketProvider } from "./state/Market";
import { ProtocolProvider } from "./state/Protocol";

// Loaded on first visit: only the admin and crank wallets use it, so it stays out of everyone else's bundle.
const AdminConsole = lazy(() => import("./pages/AdminConsole"));

/**
 * On mobile, search is the /search page: anything that opens the desktop palette (such as ⌘K) goes there instead.
 * Already on it, the entry is replaced (keeping its ?q=), so Back doesn't step through duplicates; the page refocuses its field.
 */
function useMobileSearchRoute(isMobile: boolean) {
  const { searchOpen, setSearchOpen } = useApp();
  const navigate = useNavigate();
  const { pathname, search } = useLocation();
  useEffect(() => {
    if (!isMobile || !searchOpen) return;
    setSearchOpen(false);
    const here = pathname === "/search";
    navigate({ pathname: "/search", search: here ? search : "" }, { replace: here });
  }, [isMobile, searchOpen, setSearchOpen, navigate, pathname, search]);
}

/**
 * On a phone, a page you navigate to starts at the top: the router keeps the window's scroll offset, so a coin opened
 * from deep in a long list would land mid-page. Back and Forward (POP, the first load included) keep the position the
 * browser restores, opening the launch modal leaves the page under it alone, a new query on the same page (search's ?q=)
 * doesn't move it, and a #hash is left to its page (the $PARABULL claim panel). Desktop keeps the router's behavior.
 * Out here, not inside the routes: `<Routes location>` makes every navigation report POP to the components it renders.
 */
function useScrollToTop(location: Location, background: Location | undefined, isMobile: boolean) {
  const type = useNavigationType();
  const lastPath = useRef(location.pathname);
  useLayoutEffect(() => {
    const from = lastPath.current;
    lastPath.current = location.pathname;
    if (!isMobile || type === NavigationType.Pop || background || location.hash || from === location.pathname) return;
    window.scrollTo(0, 0);
  }, [location, type, background, isMobile]);
}

/**
 * Desktop (md and up): dock, header, info strip and footer around the page.
 * Below md they're hidden and the mobile header, floating nav and create
 * button take over; main's bottom padding keeps content clear of the nav
 * (and of the create button where it shows). The side padding keeps the
 * layout clear of a notch: viewport-fit=cover lets the page run under it,
 * and a notched phone in landscape gets the desktop layout (env() is 0 in
 * desktop browsers).
 */
function Shell() {
  const { pathname } = useLocation();
  const isMobile = useIsMobile();
  useMobileSearchRoute(isMobile);
  return (
    <div className="flex min-h-screen bg-canvas pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]">
      <Dock />
      <div className="flex min-w-0 flex-1 flex-col">
        <MobileHeader />
        <Header />
        <InfoStrip />
        <main className={cx("min-h-0 flex-1", showsCreateFab(pathname) ? "max-md:pb-[calc(9rem+env(safe-area-inset-bottom))]" : "max-md:pb-[calc(7rem+env(safe-area-inset-bottom))]")}>
          <Outlet />
          {pathname !== "/search" && <MobileFootnote />}
        </main>
        <Footer />
      </div>
      <MobileCreateFab />
      <MobileNav />
      {/* Never mounted on mobile, where its autofocused input would pop the keyboard up on the way to /search. */}
      {!isMobile && <SearchPalette />}
      <Toasts />
    </div>
  );
}

/** `/create` opens as a modal over the page you came from, or as a full page when visited directly. */
function AppRoutes() {
  const location = useLocation();
  const background = (location.state as { background?: Location } | null)?.background;
  const isMobile = useIsMobile();
  useScrollToTop(location, background, isMobile);
  return (
    <>
      <Routes location={background ?? location}>
        <Route element={<Shell />}>
          <Route index element={<Board />} />
          <Route path="board" element={<Board />} />
          <Route path="explore" element={<Explore />} />
          <Route path="create" element={<CreatePage />} />
          <Route path="coin/:mint" element={<CoinPage />} />
          <Route path="leaderboard" element={<Leaderboard />} />
          <Route path="portfolio" element={<Portfolio />} />
          <Route path="search" element={<SearchPage />} />
          <Route path="live" element={<Live />} />
          <Route path="holder-rewards" element={<HolderRewards />} />
          <Route path="parabull-token" element={<TokenHub />} />
          <Route path="rewards" element={<Navigate to="/parabull-token" replace />} />
          <Route
            path="admin"
            element={
              <Suspense fallback={<div className="min-h-[60vh]" aria-busy="true" />}>
                <AdminConsole />
              </Suspense>
            }
          />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
      {background && (
        <Routes>
          <Route path="create" element={<CreateModal />} />
        </Routes>
      )}
    </>
  );
}

export function App() {
  // Wallet Standard wallets (Phantom, Solflare, Backpack, ...) register themselves;
  // the Solflare adapter adds its web and mobile fallback.
  const wallets = useMemo(() => [new SolflareWalletAdapter()], []);
  return (
    <ConnectionProvider endpoint={CONFIG.rpcUrl}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <ProtocolProvider>
            <AppStateProvider>
              <MarketProvider>
                <BrowserRouter>
                  <AppRoutes />
                </BrowserRouter>
              </MarketProvider>
            </AppStateProvider>
          </ProtocolProvider>
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}

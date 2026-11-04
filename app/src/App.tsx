import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { SolflareWalletAdapter } from "@solana/wallet-adapter-solflare";
import { useMemo } from "react";
import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation, type Location } from "react-router-dom";
import { Dock } from "./components/shell/Dock";
import { Footer } from "./components/shell/Footer";
import { Header } from "./components/shell/Header";
import { InfoStrip } from "./components/shell/InfoStrip";
import { SearchPalette } from "./components/shell/SearchPalette";
import { Toasts } from "./components/ui/overlay";
import { CONFIG } from "./config";
import { Board } from "./pages/Board";
import { CoinPage } from "./pages/CoinPage";
import { CreateModal, CreatePage } from "./pages/Create";
import { Explore } from "./pages/Explore";
import { HolderRewards } from "./pages/HolderRewards";
import { Leaderboard } from "./pages/Leaderboard";
import { Live } from "./pages/Live";
import { NotFound } from "./pages/NotFound";
import { TokenHub } from "./pages/TokenHub";
import { AppStateProvider } from "./state/AppState";
import { MarketProvider } from "./state/Market";

function Shell() {
  return (
    <div className="flex min-h-screen bg-canvas">
      <Dock />
      <div className="flex min-w-0 flex-1 flex-col">
        <Header />
        <InfoStrip />
        <main className="min-h-0 flex-1">
          <Outlet />
        </main>
        <Footer />
      </div>
      <SearchPalette />
      <Toasts />
    </div>
  );
}

/** `/create` opens as a modal over the page you came from, or as a full page when visited directly. */
function AppRoutes() {
  const location = useLocation();
  const background = (location.state as { background?: Location } | null)?.background;
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
          <Route path="live" element={<Live />} />
          <Route path="holder-rewards" element={<HolderRewards />} />
          <Route path="parabull-token" element={<TokenHub />} />
          <Route path="rewards" element={<Navigate to="/parabull-token" replace />} />
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
          <AppStateProvider>
            <MarketProvider>
              <BrowserRouter>
                <AppRoutes />
              </BrowserRouter>
            </MarketProvider>
          </AppStateProvider>
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}

/** UI preferences and transient UI state (layout, sidebar, audio, toasts, watchlist). */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { playSfx } from "../lib/sfx";

export type Layout = "pro" | "classic";
export type QuickInfo = "traders" | "positions" | "following" | "recent";
export interface Toast {
  id: number;
  title: string;
  body?: string;
  tone: "good" | "bad" | "info";
}

interface AppState {
  layout: Layout;
  setLayout: (l: Layout) => void;
  collapsed: boolean;
  toggleCollapsed: () => void;
  muted: boolean;
  toggleMuted: () => void;
  sfx: (kind: "buy" | "sell" | "launch") => void;
  quickInfo: QuickInfo;
  setQuickInfo: (q: QuickInfo) => void;
  recent: string[];
  markViewed: (mint: string) => void;
  watchlist: Set<string>;
  toggleWatch: (mint: string) => void;
  toasts: Toast[];
  toast: (t: Omit<Toast, "id">) => void;
  dismissToast: (id: number) => void;
  searchOpen: boolean;
  setSearchOpen: (open: boolean) => void;
}

const Ctx = createContext<AppState | null>(null);

/** localStorage can be blocked (private windows, previews): every access is guarded. */
function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`parabull:${key}`);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function save(key: string, value: unknown) {
  try {
    localStorage.setItem(`parabull:${key}`, JSON.stringify(value));
  } catch {
    // ignore
  }
}

export function AppStateProvider({ children }: { children: ReactNode }) {
  const [layout, setLayoutState] = useState<Layout>(() => load("layout", "pro"));
  const [collapsed, setCollapsed] = useState<boolean>(() => load("collapsed", true));
  const [muted, setMuted] = useState<boolean>(() => load("muted", true));
  const [quickInfo, setQuickInfo] = useState<QuickInfo>("traders");
  const [recent, setRecent] = useState<string[]>(() => load("recent", []));
  const [watch, setWatch] = useState<string[]>(() => load("watchlist", []));
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const nextId = useRef(1);

  useEffect(() => save("layout", layout), [layout]);
  useEffect(() => save("collapsed", collapsed), [collapsed]);
  useEffect(() => save("muted", muted), [muted]);
  useEffect(() => save("recent", recent), [recent]);
  useEffect(() => save("watchlist", watch), [watch]);

  const dismissToast = useCallback((id: number) => setToasts((ts) => ts.filter((t) => t.id !== id)), []);
  const toast = useCallback(
    (t: Omit<Toast, "id">) => {
      const id = nextId.current++;
      setToasts((ts) => [...ts.slice(-3), { ...t, id }]);
      window.setTimeout(() => dismissToast(id), 5000);
    },
    [dismissToast],
  );
  const sfx = useCallback((kind: "buy" | "sell" | "launch") => !muted && playSfx(kind), [muted]);

  const value = useMemo<AppState>(
    () => ({
      layout,
      setLayout: setLayoutState,
      collapsed,
      toggleCollapsed: () => setCollapsed((c) => !c),
      muted,
      toggleMuted: () => setMuted((m) => !m),
      sfx,
      quickInfo,
      setQuickInfo,
      recent,
      markViewed: (mint) => setRecent((r) => [mint, ...r.filter((m) => m !== mint)].slice(0, 12)),
      watchlist: new Set(watch),
      toggleWatch: (mint) => setWatch((w) => (w.includes(mint) ? w.filter((m) => m !== mint) : [...w, mint])),
      toasts,
      toast,
      dismissToast,
      searchOpen,
      setSearchOpen,
    }),
    [layout, collapsed, muted, sfx, quickInfo, recent, watch, toasts, toast, dismissToast, searchOpen],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useApp outside AppStateProvider");
  return v;
}

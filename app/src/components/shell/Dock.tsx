import { ChevronsLeft, ChevronsRight, Compass, HandCoins, LayoutDashboard, LayoutGrid, PanelsTopLeft, Plus, Radio, Trophy, Volume2, VolumeX, type LucideIcon } from "lucide-react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { BullMark } from "../brand/BullMark";
import { ParabullCoin, Wordmark } from "../brand/Wordmark";
import { useApp } from "../../state/AppState";
import { cx } from "../ui/primitives";

const MAIN: { to: string; label: string; icon: LucideIcon; end?: boolean }[] = [
  { to: "/", label: "Board", icon: LayoutDashboard, end: true },
  { to: "/explore", label: "Explore", icon: Compass },
  { to: "/leaderboard", label: "Leaderboard", icon: Trophy },
  { to: "/live", label: "Live", icon: Radio },
];
const DISCOVER: { to: string; label: string; icon: LucideIcon | "coin"; badge?: string }[] = [
  { to: "/holder-rewards", label: "Holder rewards", icon: HandCoins, badge: "New" },
  { to: "/parabull-token", label: "$PARABULL", icon: "coin" },
];

function Item({ to, label, icon, collapsed, end, badge }: { to: string; label: string; icon: LucideIcon | "coin"; collapsed: boolean; end?: boolean; badge?: string }) {
  const { pathname } = useLocation();
  const active = to === "/" ? pathname === "/" || pathname === "/board" : pathname.startsWith(to) || (to === "/parabull-token" && pathname === "/rewards");
  const Icon = icon;
  return (
    <NavLink
      to={to}
      end={end}
      title={collapsed ? label : undefined}
      aria-current={active ? "page" : undefined}
      className={cx(
        "group relative flex h-10 items-center rounded-xl transition-colors",
        collapsed ? "w-10 justify-center" : "gap-3 px-3",
        active ? "bg-surface-2 text-cream shadow-[inset_0_0_0_1px_#4A3528]" : "text-muted hover:bg-surface hover:text-cream",
      )}
    >
      {active && <span className="absolute -left-3 top-2 h-6 w-[3px] rounded-r bg-gold" />}
      {Icon === "coin" ? <ParabullCoin size={20} /> : <Icon className={cx("h-[19px] w-[19px]", active && "text-copper")} strokeWidth={1.9} />}
      {!collapsed && <span className="text-[14.5px] font-medium">{label}</span>}
      {!collapsed && badge && <span className="ml-auto rounded-md bg-gold/15 px-1.5 text-[11px] font-semibold text-gold">{badge}</span>}
      {collapsed && badge && <span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-gold" />}
    </NavLink>
  );
}

export function Dock() {
  const { collapsed, toggleCollapsed, muted, toggleMuted, layout, setLayout } = useApp();
  const navigate = useNavigate();
  const location = useLocation();
  const launch = () => navigate("/create", { state: { background: location } });
  const ctrl = "flex h-10 items-center rounded-xl text-muted transition-colors hover:bg-surface hover:text-cream";
  return (
    <nav aria-label="Main" className={cx("sticky top-0 z-30 hidden md:flex h-screen shrink-0 flex-col border-r border-line bg-canvas py-3 transition-[width] duration-200", collapsed ? "w-16 items-center" : "w-60 px-3")}>
      <div className={cx("relative flex h-11 items-center", collapsed ? "justify-center" : "px-1.5")}>
        {collapsed ? <BullMark size={38} /> : <Wordmark size={34} />}
        <button
          onClick={toggleCollapsed}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className={cx("absolute flex h-6 w-6 items-center justify-center rounded-full border border-line bg-surface text-muted hover:text-cream", collapsed ? "-right-3 top-2.5" : "right-0 top-2.5")}
        >
          {collapsed ? <ChevronsRight className="h-3.5 w-3.5" /> : <ChevronsLeft className="h-3.5 w-3.5" />}
        </button>
      </div>

      <div className={cx("mt-5 flex flex-col gap-1", collapsed && "items-center")}>
        {MAIN.map((m) => (
          <Item key={m.to} {...m} collapsed={collapsed} />
        ))}
      </div>
      <div className={cx("my-3 border-t border-line", collapsed ? "w-8" : "mx-1")} />
      {!collapsed && <div className="mb-1 px-3 text-xs font-medium text-muted/80">Discover</div>}
      <div className={cx("flex flex-col gap-1", collapsed && "items-center")}>
        {DISCOVER.map((m) => (
          <Item key={m.to} {...m} collapsed={collapsed} />
        ))}
      </div>

      <button onClick={launch} aria-label="Start a coin" title={collapsed ? "Start a coin" : undefined} className={cx("btn-gold mt-4 rounded-xl", collapsed ? "h-10 w-10" : "h-11 gap-2 text-[14.5px]")}>
        <Plus className="h-5 w-5" strokeWidth={2.5} />
        {!collapsed && "Start a coin"}
      </button>

      <div className={cx("mt-auto flex flex-col gap-1 border-t border-line pt-3", collapsed ? "w-full items-center" : "")}>
        <button onClick={toggleMuted} aria-pressed={!muted} aria-label={muted ? "Unmute trade sounds" : "Mute trade sounds"} title={collapsed ? "Audio FX" : undefined} className={cx(ctrl, collapsed ? "w-10 justify-center" : "gap-3 px-3")}>
          {muted ? <VolumeX className="h-[19px] w-[19px]" strokeWidth={1.9} /> : <Volume2 className="h-[19px] w-[19px] text-copper" strokeWidth={1.9} />}
          {!collapsed && <span className="text-[14px]">Audio FX {muted ? "off" : "on"}</span>}
        </button>
        <button onClick={() => setLayout(layout === "pro" ? "classic" : "pro")} aria-label="Switch workspace layout" title={collapsed ? (layout === "pro" ? "Terminal Pro" : "Classic cards") : undefined} className={cx(ctrl, collapsed ? "w-10 justify-center" : "gap-3 px-3")}>
          {layout === "pro" ? <PanelsTopLeft className="h-[19px] w-[19px]" strokeWidth={1.9} /> : <LayoutGrid className="h-[19px] w-[19px]" strokeWidth={1.9} />}
          {!collapsed && <span className="text-[14px]">{layout === "pro" ? "Terminal Pro" : "Classic cards"}</span>}
        </button>
      </div>
    </nav>
  );
}

/**
 * The search field (spec 2D): a pill with a search icon, the input, an
 * in-field clear button and a Paste chip. Below md, `MobileSearchBar` pins
 * it above the bottom nav, or right above the on-screen keyboard while that
 * is open, with a round close button beside it.
 */
import { Search, X } from "lucide-react";
import type { MouseEvent, RefObject } from "react";
import { useNavigate } from "react-router-dom";
import { useKeyboardInset } from "../../hooks/useKeyboardInset";
import { useIsMobile } from "../../hooks/useMediaQuery";
import { useApp } from "../../state/AppState";
import { cx } from "../ui/primitives";

/** Pressing the field's buttons shouldn't take focus from the input (and close the on-screen keyboard). */
const keepFocus = (e: MouseEvent) => e.preventDefault();

export interface SearchFieldProps {
  value: string;
  onChange: (value: string) => void;
  /** Enter, or the keyboard's Search key. */
  onSubmit: () => void;
  inputRef: RefObject<HTMLInputElement | null>;
}

export function SearchField({ value, onChange, onSubmit, inputRef, className }: SearchFieldProps & { className?: string }) {
  const { toast } = useApp();
  const isMobile = useIsMobile();
  const paste = async () => {
    try {
      // A pasted address or ticker may come with line breaks or padding around it.
      const text = (await navigator.clipboard.readText()).replace(/\s+/g, " ").trim().slice(0, 200);
      if (text) onChange(text);
      else toast({ tone: "info", title: "Your clipboard is empty" });
    } catch {
      toast({ tone: "bad", title: "Clipboard access was blocked", body: isMobile ? "Long-press the search field and choose Paste instead." : "Click the search field and press ⌘V or Ctrl+V instead." });
    }
  };
  return (
    <form
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
      className={cx(
        "flex h-11 min-w-0 items-center gap-2 rounded-full border border-line bg-canvas-2 px-4 transition-[border-color,box-shadow] duration-100 ease-out focus-within:border-copper focus-within:ring-1 focus-within:ring-gold",
        className,
      )}
    >
      {/* The label spans the pill's full height and left padding, so a tap anywhere left of the buttons lands in the field. */}
      <label className="-my-px -ml-4 flex h-11 min-w-0 flex-1 cursor-text items-center gap-2 pl-4">
        <Search className="h-[18px] w-[18px] shrink-0 text-muted" strokeWidth={2} aria-hidden />
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && value) {
              e.preventDefault();
              onChange("");
            }
          }}
          autoFocus
          enterKeyHint="search"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="none"
          spellCheck={false}
          placeholder="Search anything..."
          aria-label="Search coins and creators"
          className="h-full min-w-0 flex-1 text-ellipsis bg-transparent text-base text-cream outline-none placeholder:text-muted"
        />
      </label>
      {value && (
        <button
          type="button"
          onMouseDown={keepFocus}
          onClick={() => {
            onChange("");
            inputRef.current?.focus();
          }}
          aria-label="Clear search"
          className="group -mx-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-full focus-visible:outline-offset-[-4px]"
        >
          <span className="flex h-5 w-5 items-center justify-center rounded-full bg-surface-3 text-cream transition-colors duration-100 ease-out group-hover:bg-line group-active:bg-line-accent">
            <X className="h-3 w-3" strokeWidth={2.75} aria-hidden />
          </span>
        </button>
      )}
      <button
        type="button"
        onMouseDown={keepFocus}
        onClick={paste}
        className="touch-target shrink-0 rounded-md border border-line bg-surface-2 px-2.5 py-1 text-xs font-medium text-muted transition-colors duration-100 ease-out hover:text-cream active:bg-surface-3 active:text-cream"
      >
        Paste
      </button>
    </form>
  );
}

/** Gap between the bar and the top of the on-screen keyboard. */
const KEYBOARD_GAP = 12;

/**
 * Below md: the field and a close button, fixed above the floating nav, or
 * just above the keyboard (which then covers the nav). Pages that use it
 * keep their last row clear of it with bottom padding.
 */
export function MobileSearchBar(props: SearchFieldProps) {
  const inset = useKeyboardInset();
  const navigate = useNavigate();
  const bottom = inset > 0 ? `${inset + KEYBOARD_GAP}px` : "calc(5rem + env(safe-area-inset-bottom))";
  // React Router numbers its history entries; 0 means search was the first page opened, so there's nothing in the app to go back to.
  const close = () => (((window.history.state as { idx?: number } | null)?.idx ?? 0) > 0 ? navigate(-1) : navigate("/", { replace: true }));
  return (
    <>
      {/* Fades the list out under the floating bar and nav, so the controls read cleanly over scrolling rows. */}
      <div aria-hidden className="pointer-events-none fixed inset-x-0 bottom-0 z-30 bg-gradient-to-t from-canvas via-canvas/80 to-transparent md:hidden" style={{ height: `calc(${bottom} + 4.25rem)` }} />
      <div className="fixed inset-x-4 z-40 flex items-center gap-2 md:hidden" style={{ bottom }}>
        <SearchField {...props} className="flex-1 shadow-[0_8px_32px_rgba(0,0,0,0.8)]" />
        <button
          type="button"
          onClick={close}
          aria-label="Close search"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-line bg-surface text-muted shadow-[0_8px_32px_rgba(0,0,0,0.8)] transition-colors duration-100 ease-out active:bg-surface-2 active:text-cream"
        >
          <X className="h-5 w-5" strokeWidth={2} aria-hidden />
        </button>
      </div>
    </>
  );
}

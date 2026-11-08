/**
 * The board's Pro Screener filters and the callout feed's paging. Pure, so the rules are unit-tested
 * (test/screener.test.ts) apart from the components.
 */
import { fullyLocked } from "./launchRules";
import type { Coin } from "./types";

export interface ScreenerFilters {
  /** Ticker, name and announcement tweet all still locked on-chain (as Explore's "Verified locks only"). */
  lockedOnly: boolean;
  /** Has an X account or a website. */
  socialsOnly: boolean;
  /** Minimum market cap in USD; 0 for none. */
  minMcapUsd: number;
}

export const NO_SCREENER_FILTERS: ScreenerFilters = { lockedOnly: false, socialsOnly: false, minMcapUsd: 0 };

/** How many filters differ from none: the count shown on the Filters button. */
export function activeScreenerFilters(f: ScreenerFilters): number {
  return Number(f.lockedOnly) + Number(f.socialsOnly) + Number(f.minMcapUsd > 0);
}

export function passesScreener(c: Coin, f: ScreenerFilters, now: number): boolean {
  if (f.lockedOnly && !fullyLocked(c.locks, now)) return false;
  if (f.socialsOnly && !c.socials.x && !c.socials.website) return false;
  if (f.minMcapUsd > 0 && c.mcapUsd < f.minMcapUsd) return false;
  return true;
}

/** Rows the screener shows: 30 in its panel, every match when the panel is expanded. */
export const SCREENER_ROWS = 30;

/** Callouts per "Show more updates" page on the classic board. */
export const FEED_PAGE = 6;

/** The next feed length after "Show more updates", never past the end. */
export function nextFeedCount(shown: number, total: number, page = FEED_PAGE): number {
  return Math.min(total, shown + page);
}

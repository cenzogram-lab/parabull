/**
 * Which mentions get a cashtag reply. Only posts that @mention the project's own account and include $TICKER: X's
 * automation rules forbid automated replies to posts found by keyword search, so the sentinel never replies to a
 * $TICKER post that didn't address the account.
 */

export interface MentionTweet {
  id: string;
  text: string;
  username: string;
  timeMs: number;
  isRetweet?: boolean;
}

export interface ReplyState {
  /** Tweet IDs already answered (or deliberately skipped). */
  replied: ReadonlySet<string>;
  /** Last reply time per author (lowercase username), ms. */
  lastByAuthor: Readonly<Record<string, number>>;
  /** Times of this account's replies in the last hour, ms. */
  recent: readonly number[];
}

export interface ReplyLimits {
  maxPerHour: number;
  /** One reply per author per window. */
  perAuthorMs: number;
}

export const DEFAULT_LIMITS: ReplyLimits = { maxPerHour: 10, perAuthorMs: 24 * 60 * 60 * 1000 };

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function mentionsAccount(text: string, account: string): boolean {
  return new RegExp(`(^|[^\\w])@${escape(account)}(?![\\w])`, "i").test(text);
}

export function hasCashtag(text: string, ticker: string): boolean {
  return new RegExp(`(^|[^\\w$])\\$${escape(ticker)}(?![\\w])`, "i").test(text);
}

/**
 * The mentions to answer now, oldest first. `since` is when the sentinel started watching this coin: older posts
 * are never answered, so restarting it doesn't reply to a backlog.
 */
export function selectReplies(tweets: readonly MentionTweet[], account: string, ticker: string, since: number, now: number, state: ReplyState, limits: ReplyLimits = DEFAULT_LIMITS): MentionTweet[] {
  const hour = now - 60 * 60 * 1000;
  let budget = limits.maxPerHour - state.recent.filter((t) => t > hour).length;
  const lastByAuthor = { ...state.lastByAuthor };
  const out: MentionTweet[] = [];
  for (const t of [...tweets].sort((a, b) => a.timeMs - b.timeMs)) {
    if (budget <= 0) break;
    const author = t.username.toLowerCase();
    if (author === account.toLowerCase() || t.isRetweet || state.replied.has(t.id) || t.timeMs < since) continue;
    if (!mentionsAccount(t.text, account) || !hasCashtag(t.text, ticker)) continue;
    if (now - (lastByAuthor[author] ?? -Infinity) < limits.perAuthorMs) continue;
    lastByAuthor[author] = now;
    out.push(t);
    budget--;
  }
  return out;
}

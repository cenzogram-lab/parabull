/**
 * The three personas and the text they post. Templates are filled with elizaOS's composeContext, so a persona can
 * later move into a full elizaOS character without changing its wording. No model is called: every post and reply
 * comes from these templates, which keeps the sentinel free to run.
 */
import { composeContext, type State } from "@elizaos/core";
import type { SentinelMilestone, SentinelTone } from "../../../app/src/lib/sentinelMessage";

export const MAX_POST = 280;

interface Persona {
  milestone: Record<SentinelMilestone, string[]>;
  reply: string[];
}

const PERSONAS: Record<SentinelTone, Persona> = {
  bull: {
    milestone: {
      p25: ["${{ticker}} just cleared 25% of the bonding curve. The bull is awake. {{news}}{{url}}", "25% of the ${{ticker}} curve is gone. Early is a position, not a feeling. {{news}}{{url}}"],
      p50: ["HALFWAY. ${{ticker}} is 50% up the curve and still charging. {{news}}{{url}}", "${{ticker}} at 50% of the curve. Bears are getting the horns. {{news}}{{url}}"],
      p75: ["75% of the ${{ticker}} curve filled. Raydium is in sight. {{news}}{{url}}", "${{ticker}} hits 75%. The last stretch before Raydium. {{news}}{{url}}"],
      graduation: ["${{ticker}} GRADUATED. The curve is full and liquidity is live on Raydium, LP locked. {{news}}{{url}}", "Raydium, we're here. ${{ticker}} filled its curve and migrated with locked LP. {{news}}{{url}}"],
    },
    reply: ["@{{author}} ${{ticker}} is {{pct}} up the curve. {{news}}{{url}}", "@{{author}} Thanks for riding with ${{ticker}}. {{pct}} of the curve is filled. {{news}}{{url}}"],
  },
  wojak: {
    milestone: {
      p25: ["${{ticker}} quietly filled 25% of its curve while everyone was asleep. {{news}}{{url}}", "me: it's just a meme. ${{ticker}}: 25% of the curve. {{news}}{{url}}"],
      p50: ["${{ticker}} is halfway up the curve. I'm not crying, you're crying. {{news}}{{url}}", "50% of the ${{ticker}} curve. Mom, get the camera. {{news}}{{url}}"],
      p75: ["${{ticker}} at 75%. The Raydium part of my brain just woke up. {{news}}{{url}}", "75% of the curve and ${{ticker}} is acting like it planned this. {{news}}{{url}}"],
      graduation: ["${{ticker}} graduated to Raydium. We made it out of the curve, LP locked. {{news}}{{url}}", "From meme to Raydium pool. ${{ticker}} migrated, LP locked. {{news}}{{url}}"],
    },
    reply: ["@{{author}} you found ${{ticker}}. It's {{pct}} up the curve. {{news}}{{url}}", "@{{author}} ${{ticker}} has filled {{pct}} of its curve, no promises, just vibes. {{news}}{{url}}"],
  },
  macro: {
    milestone: {
      p25: ["${{ticker}}: bonding curve 25% filled. {{news}}{{url}}", "Update: ${{ticker}} has reached 25% of its bonding curve. {{news}}{{url}}"],
      p50: ["${{ticker}}: bonding curve 50% filled. {{news}}{{url}}", "Update: ${{ticker}} has reached the curve's midpoint. {{news}}{{url}}"],
      p75: ["${{ticker}}: bonding curve 75% filled. Migration to Raydium follows at 100%. {{news}}{{url}}", "Update: ${{ticker}} has reached 75% of its bonding curve. {{news}}{{url}}"],
      graduation: ["${{ticker}} has completed its bonding curve and migrated to a Raydium CPMM pool. LP tokens are locked. {{news}}{{url}}", "Migration complete: ${{ticker}} now trades on Raydium, LP locked. {{news}}{{url}}"],
    },
    reply: ["@{{author}} ${{ticker}} is {{pct}} through its bonding curve. {{news}}{{url}}", "@{{author}} Current status: ${{ticker}} curve {{pct}} filled. {{news}}{{url}}"],
  },
};

/** A stable pick, so the same tweet or milestone always gets the same wording. */
function pick<T>(items: readonly T[], seed: string): T {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619) >>> 0;
  return items[h % items.length];
}

/** The creator's first line of context, as the latest news for a post. */
export function newsLine(context: string): string {
  const first = context.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "";
  return first;
}

function fill(template: string, values: Record<string, string>): string {
  // composeContext replaces {{key}} with state[key]; the rest of State isn't used by these templates.
  return composeContext({ state: values as unknown as State, template }).replace(/\s+/g, " ").trim();
}

/** Code points X weighs 1 (twitter-text v3: Latin, punctuation and similar); every other character weighs 2. */
const LIGHT: readonly [number, number][] = [
  [0, 4351],
  [8192, 8205],
  [8208, 8223],
  [8242, 8247],
];
const URL_RE = /https?:\/\/\S+/g;
/** X counts every link as 23 characters, whatever its length. */
const URL_WEIGHT = 23;

const charWeight = (ch: string) => {
  const cp = ch.codePointAt(0)!;
  return LIGHT.some(([a, b]) => cp >= a && cp <= b) ? 1 : 2;
};

/**
 * Length as X counts it against the 280 limit: CJK and emoji weigh 2, links 23. Each emoji code point counts as 2
 * (X counts a joined emoji sequence as 2 in total), so this can only over-count, never let a post through too long.
 */
export function weightedLength(text: string): number {
  let n = 0;
  for (const part of text.split(URL_RE)) for (const ch of part) n += charWeight(ch);
  return n + (text.match(URL_RE)?.length ?? 0) * URL_WEIGHT;
}

/** The longest start of `text` (whole characters) that weighs at most `max`. */
function cutWeighted(text: string, max: number): string {
  let n = 0;
  let out = "";
  for (const ch of text) {
    n += charWeight(ch);
    if (n > max) break;
    out += ch;
  }
  return out;
}

/** Fits the text in a post by X's weighted count: shortens the news with an ellipsis first, then drops it. */
function fit(template: string, values: Record<string, string>): string {
  const withNews = fill(template, { ...values, news: values.news ? `${values.news} ` : "" });
  if (weightedLength(withNews) <= MAX_POST) return withNews;
  const bare = fill(template, { ...values, news: "" });
  // Shortened news adds itself, an ellipsis (U+2026 weighs 2) and one space.
  const room = MAX_POST - weightedLength(bare) - 3;
  if (values.news && room > 20) return fill(template, { ...values, news: `${cutWeighted(values.news, room).trimEnd()}… ` });
  return weightedLength(bare) <= MAX_POST ? bare : `${cutWeighted(bare, MAX_POST - 2)}…`;
}

export interface CoinFacts {
  mint: string;
  ticker: string;
  /** Link to the coin's page, or "" for none. */
  url: string;
}

export function milestonePost(tone: SentinelTone, milestone: SentinelMilestone, coin: CoinFacts, context: string): string {
  const template = pick(PERSONAS[tone].milestone[milestone], `${coin.mint}:${milestone}`);
  return fit(template, { ticker: coin.ticker, url: coin.url, news: newsLine(context) });
}

export function replyText(tone: SentinelTone, coin: CoinFacts, author: string, tweetId: string, progressPct: number, context: string): string {
  const template = pick(PERSONAS[tone].reply, tweetId);
  const pct = progressPct >= 1 ? "100%, graduated to Raydium," : `${Math.floor(progressPct * 100)}%`;
  return fit(template, { ticker: coin.ticker, url: coin.url, author, pct, news: newsLine(context) });
}

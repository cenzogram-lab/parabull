/** Per-coin loop: post milestones as the curve fills, and answer cashtag mentions of the project's account. */
import type { SentinelMilestone } from "../../../app/src/lib/sentinelMessage";
import type { ChainSource, CurveState } from "./chain";
import { due, progress } from "./milestones";
import { milestonePost, replyText, type CoinFacts } from "./persona";
import { DEFAULT_LIMITS, selectReplies, type ReplyLimits } from "./replies";
import { trimReplyState, type Store } from "./store";
import type { XClient } from "./x";

export interface SentinelDeps {
  store: Store;
  chain: ChainSource;
  /** The X account for a coin, or null when none is set up (nothing is posted). */
  xFor: (mint: string) => XClient | null;
  /** Coin page link for posts, e.g. https://parabull.app/coin/<mint>; "" for none. */
  coinUrl: (mint: string) => string;
  now?: () => number;
  log?: (line: string) => void;
  limits?: ReplyLimits;
}

export class Sentinel {
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly unwatch = new Map<string, () => void>();
  /** One handler at a time per coin, so a burst of curve updates can't post the same milestone twice. */
  private readonly queue = new Map<string, Promise<void>>();

  constructor(private readonly deps: SentinelDeps) {
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? ((l) => console.log(l));
  }

  private serial(mint: string, job: () => Promise<void>) {
    const next = (this.queue.get(mint) ?? Promise.resolve()).then(job).catch((e) => this.log(`[${mint}] ${e instanceof Error ? e.message : String(e)}`));
    this.queue.set(mint, next);
    return next;
  }

  private async facts(mint: string): Promise<CoinFacts | null> {
    const ticker = await this.deps.chain.ticker(mint);
    return ticker ? { mint, ticker, url: this.deps.coinUrl(mint) } : null;
  }

  /** Handles one look at the curve. The first look marks what's already reached as done, so nothing is backfilled. */
  onCurve(mint: string, state: CurveState) {
    return this.serial(mint, async () => {
      const rec = this.deps.store.get(mint);
      if (!rec) return;
      const raise = await this.deps.chain.raise();
      const done = new Set<SentinelMilestone>(rec.milestonesDone ?? []);
      const { post, markDone } = due(state, raise, done, rec.settings.milestones);
      if (rec.milestonesDone === null) {
        this.deps.store.update(mint, (r) => ({ ...r!, milestonesDone: [...done, ...markDone] }));
        return;
      }
      if (!markDone.length) return;
      const x = this.deps.xFor(mint);
      const coin = post && x ? await this.facts(mint) : null;
      if (post && x && coin) {
        await x.post(milestonePost(rec.settings.tone, post, coin, rec.settings.context));
        this.log(`[${mint}] posted the ${post} milestone as @${x.username}`);
      } else if (post) {
        this.log(`[${mint}] ${post} reached; ${x ? "ticker unknown" : "no X account set up"}, so nothing was posted`);
      }
      // Marked done only after a successful post (a failed post throws above and is retried on the next update).
      this.deps.store.update(mint, (r) => ({ ...r!, milestonesDone: [...new Set([...(r!.milestonesDone ?? []), ...markDone])] }));
    });
  }

  /** One pass over the account's mentions. */
  pollMentions(mint: string) {
    return this.serial(mint, async () => {
      const rec = this.deps.store.get(mint);
      const x = this.deps.xFor(mint);
      if (!rec?.settings.cashtagReplies || !x) return;
      const coin = await this.facts(mint);
      const state = await this.deps.chain.curve(mint);
      if (!coin || !state) return;
      const now = this.now();
      const picks = selectReplies(await x.mentions(40), x.username, coin.ticker, rec.watchingSince, now, { replied: new Set(rec.replied), lastByAuthor: rec.lastByAuthor, recent: rec.recentReplies }, this.deps.limits ?? DEFAULT_LIMITS);
      const pct = progress(state, await this.deps.chain.raise());
      for (const t of picks) {
        await x.post(replyText(rec.settings.tone, coin, t.username, t.id, pct, rec.settings.context), t.id);
        this.deps.store.update(mint, (r) => trimReplyState({ ...r!, replied: [...r!.replied, t.id], lastByAuthor: { ...r!.lastByAuthor, [t.username.toLowerCase()]: now }, recentReplies: [...r!.recentReplies, now] }, now));
        this.log(`[${mint}] replied to ${t.id} by @${t.username}`);
      }
    });
  }

  /** Starts (or restarts) watching a coin's curve. */
  watch(mint: string) {
    this.unwatch.get(mint)?.();
    this.unwatch.set(mint, this.deps.chain.watch(mint, (s) => void this.onCurve(mint, s)));
  }

  /** Polls every watched coin once: catches updates a dropped websocket missed, and RPCs without one. */
  async tick() {
    for (const mint of this.deps.store.mints()) {
      const state = await this.deps.chain.curve(mint).catch((e) => (this.log(`[${mint}] couldn't read the curve: ${e instanceof Error ? e.message : String(e)}`), null));
      if (state) await this.onCurve(mint, state);
    }
  }

  async tickMentions() {
    for (const mint of this.deps.store.mints()) await this.pollMentions(mint);
  }

  stop() {
    for (const off of this.unwatch.values()) off();
    this.unwatch.clear();
  }
}

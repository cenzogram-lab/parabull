/**
 * Fixed-window request counters for the settings API. Signature checks already keep junk away from the RPC, but any
 * wallet can sign: without a ceiling, a stream of validly signed requests from strangers would each cost one curve read
 * (to learn the coin's creator) and burn through the RPC provider's quota.
 */
export class RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
    /** Bound on tracked keys, so a flood of distinct addresses can't grow the map without limit. */
    private readonly maxKeys = 10_000,
  ) {}

  /** Counts one request for `key`. Returns 0 when it's allowed, otherwise the milliseconds until the key may retry. */
  take(key: string): number {
    const t = this.now();
    let w = this.windows.get(key);
    if (!w || t - w.start >= this.windowMs) {
      if (!w && this.windows.size >= this.maxKeys) this.prune(t);
      w = { start: t, count: 0 };
      this.windows.set(key, w);
    }
    if (w.count >= this.limit) return w.start + this.windowMs - t;
    w.count++;
    return 0;
  }

  private prune(t: number) {
    for (const [k, w] of this.windows) if (t - w.start >= this.windowMs) this.windows.delete(k);
    // Still full: every key is active. Start over rather than refuse new clients; the global ceiling still holds.
    if (this.windows.size >= this.maxKeys) this.windows.clear();
  }
}

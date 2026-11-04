/**
 * Which X client posts for each coin. A session the creator linked (sealed in the store) comes first, then the
 * operator's accounts.json. Clients are cached per mint and swapped in place when a session changes, so linking,
 * replacing or disconnecting an account takes effect at once, with no restart.
 */
import type { XSession } from "../../../app/src/lib/sentinelMessage";
import { seal, unseal, type Key } from "./seal";
import type { Store } from "./store";
import type { XAccount, XClient } from "./x";

export type XFactory = (account: XAccount) => XClient;

export class AccountError extends Error {
  readonly status = 400;
}

export class XRegistry {
  private readonly cache = new Map<string, XClient>();

  constructor(
    private readonly o: {
      store: Store;
      /** Seals creator sessions at rest; null refuses them. */
      key: Key | null;
      /** accounts.json, keyed by mint. */
      operator: Record<string, XAccount>;
      make: XFactory;
      log?: (line: string) => void;
    },
  ) {}

  source(mint: string): "creator" | "operator" | null {
    if (this.o.store.get(mint)?.session) return "creator";
    return this.o.operator[mint]?.username ? "operator" : null;
  }

  for(mint: string): XClient | null {
    const cached = this.cache.get(mint);
    if (cached) return cached;
    const rec = this.o.store.get(mint);
    let account: XAccount | null = null;
    if (rec?.session && this.o.key) {
      try {
        account = unseal(this.o.key, mint, rec.session.sealed);
      } catch {
        this.o.log?.(`[${mint}] couldn't unseal the linked X session (was SENTINEL_SECRET changed?); ask the creator to link it again`);
      }
    } else if (!rec?.session && this.o.operator[mint]?.username) {
      account = this.o.operator[mint];
    }
    if (!account) return null;
    const client = this.o.make({ ...account, username: account.username.replace(/^@/, "") });
    this.cache.set(mint, client);
    return client;
  }

  /** Drops the cached client, so the next use picks up a changed session (or none). */
  invalidate(mint: string) {
    this.cache.delete(mint);
  }

  /** Checks a creator's session with X (in live mode) and returns it sealed for the store, with X's own spelling of the handle. */
  async prepare(mint: string, session: XSession): Promise<{ username: string; sealed: string }> {
    if (!this.o.key) throw new AccountError("this sentinel isn't set up to keep X sessions (SENTINEL_SECRET is unset); ask its operator");
    let username: string;
    try {
      username = await this.o.make(session).verify();
    } catch (e) {
      throw new AccountError(`X didn't accept that session: ${e instanceof Error ? e.message : String(e)}`);
    }
    return { username, sealed: seal(this.o.key, mint, { ...session, username }) };
  }
}

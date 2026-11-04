/** Settings and progress per coin, kept in one JSON file under the data directory (written atomically). */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SentinelMilestone, SentinelSettings } from "../../../app/src/lib/sentinelMessage";

export interface CoinRecord {
  settings: SentinelSettings;
  updatedAt: string;
  /** Milestones posted or passed; null until the curve was first seen (nothing is backfilled). */
  milestonesDone: SentinelMilestone[] | null;
  /** When mention polling started for this coin, ms. */
  watchingSince: number;
  replied: string[];
  lastByAuthor: Record<string, number>;
  recentReplies: number[];
  /** The X session the creator linked, sealed (see seal.ts). Absent when none, or when the operator's is used. */
  session?: { username: string; sealed: string; linkedAt: string };
}

interface FileShape {
  coins: Record<string, CoinRecord>;
  /** issuedAt of the last accepted signed request per mint, ms. Kept after a disconnect, so old requests can't be replayed. */
  lastIssued: Record<string, number>;
}

export class Store {
  private data: FileShape = { coins: {}, lastIssued: {} };
  private readonly file: string;

  constructor(dir: string) {
    this.file = join(dir, "sentinel.json");
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.file, "utf8"));
    } catch {
      raw = null;
    }
    this.data = Store.migrate(raw);
  }

  /**
   * Reads either file shape. The first release wrote a plain mint → record map, with each record's last request
   * time inside it (`lastIssuedAtMs`); that is moved into `lastIssued`, so upgrading keeps every coin and its
   * replay protection.
   */
  static migrate(raw: unknown): FileShape {
    if (!raw || typeof raw !== "object") return { coins: {}, lastIssued: {} };
    const r = raw as Record<string, unknown>;
    if ("coins" in r || "lastIssued" in r) return { coins: (r.coins as FileShape["coins"]) ?? {}, lastIssued: (r.lastIssued as FileShape["lastIssued"]) ?? {} };
    const coins: FileShape["coins"] = {};
    const lastIssued: FileShape["lastIssued"] = {};
    for (const [mint, rec] of Object.entries(r)) {
      if (!rec || typeof rec !== "object" || !("settings" in rec)) continue;
      const { lastIssuedAtMs, ...rest } = rec as CoinRecord & { lastIssuedAtMs?: number };
      coins[mint] = rest;
      if (typeof lastIssuedAtMs === "number") lastIssued[mint] = lastIssuedAtMs;
    }
    return { coins, lastIssued };
  }

  get(mint: string): CoinRecord | undefined {
    return this.data.coins[mint];
  }

  mints(): string[] {
    return Object.keys(this.data.coins);
  }

  lastIssued(mint: string): number | null {
    return this.data.lastIssued[mint] ?? null;
  }

  update(mint: string, patch: (r: CoinRecord | undefined) => CoinRecord, issuedAtMs?: number): CoinRecord {
    const next = patch(this.data.coins[mint]);
    this.data.coins[mint] = next;
    if (issuedAtMs !== undefined) this.data.lastIssued[mint] = issuedAtMs;
    this.flush();
    return next;
  }

  /** Forgets the coin, including its sealed session; keeps only its last request time. */
  remove(mint: string, issuedAtMs: number) {
    delete this.data.coins[mint];
    this.data.lastIssued[mint] = issuedAtMs;
    this.flush();
  }

  private flush() {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}

/** Keeps the reply bookkeeping bounded. */
export function trimReplyState(r: CoinRecord, now: number): CoinRecord {
  const day = now - 24 * 60 * 60 * 1000;
  return {
    ...r,
    replied: r.replied.slice(-500),
    recentReplies: r.recentReplies.filter((t) => t > now - 60 * 60 * 1000),
    lastByAuthor: Object.fromEntries(Object.entries(r.lastByAuthor).filter(([, t]) => t > day)),
  };
}

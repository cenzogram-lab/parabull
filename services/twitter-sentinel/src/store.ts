/** Settings and progress per coin, kept in one JSON file under the data directory (written atomically). */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SentinelMilestone, SentinelSettings } from "../../../app/src/lib/sentinelMessage";

export interface CoinRecord {
  settings: SentinelSettings;
  updatedAt: string;
  /** issuedAt of the last accepted signed change, ms. */
  lastIssuedAtMs: number;
  /** Milestones posted or passed; null until the curve was first seen (nothing is backfilled). */
  milestonesDone: SentinelMilestone[] | null;
  /** When mention polling started for this coin, ms. */
  watchingSince: number;
  replied: string[];
  lastByAuthor: Record<string, number>;
  recentReplies: number[];
}

export class Store {
  private data: Record<string, CoinRecord> = {};
  private readonly file: string;

  constructor(dir: string) {
    this.file = join(dir, "sentinel.json");
    try {
      this.data = JSON.parse(readFileSync(this.file, "utf8"));
    } catch {
      this.data = {};
    }
  }

  get(mint: string): CoinRecord | undefined {
    return this.data[mint];
  }

  mints(): string[] {
    return Object.keys(this.data);
  }

  update(mint: string, patch: (r: CoinRecord | undefined) => CoinRecord): CoinRecord {
    const next = patch(this.data[mint]);
    this.data[mint] = next;
    this.flush();
    return next;
  }

  private flush() {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
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

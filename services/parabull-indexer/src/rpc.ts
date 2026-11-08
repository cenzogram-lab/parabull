/**
 * The Solana JSON-RPC calls the indexer makes, over plain fetch (no SDK). Account data is requested base64 and comes
 * back as bytes. Each call has a timeout; a 429 or a network failure is retried twice with backoff, and anything else
 * (a JSON-RPC error, a bad answer) throws RpcError, which callers treat as "try again next cycle".
 */
export class RpcError extends Error {}

export interface AccountBytes {
  data: Uint8Array;
  owner: string;
  lamports: number;
}
export interface KeyedAccount extends AccountBytes {
  pubkey: string;
}
export interface SignatureInfo {
  signature: string;
  slot: number;
  err: unknown;
  blockTime: number | null;
}
export interface TransactionLogs {
  slot: number;
  blockTime: number | null;
  err: unknown;
  logs: string[];
}
export type Filter = { memcmp: { offset: number; bytes: string } } | { dataSize: number };

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

const toBytes = (d: unknown): Uint8Array => {
  if (Array.isArray(d) && typeof d[0] === "string") return Uint8Array.from(Buffer.from(d[0], "base64"));
  throw new RpcError("expected base64 account data");
};
const toAccount = (a: { data: unknown; owner: string; lamports: number }): AccountBytes => ({ data: toBytes(a.data), owner: a.owner, lamports: a.lamports });

export class Rpc {
  private id = 0;
  constructor(
    readonly url: string,
    private readonly fetchImpl: Fetch = fetch,
    private readonly timeoutMs = 20_000,
  ) {}

  async call<T>(method: string, params: unknown[]): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 250 * 4 ** (attempt - 1)));
      let res: Response;
      try {
        res = await this.fetchImpl(this.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: ++this.id, method, params }),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (e) {
        lastError = e;
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        lastError = new RpcError(`${method}: HTTP ${res.status}`);
        continue;
      }
      const json = (await res.json().catch(() => null)) as { result?: T; error?: { code: number; message: string } } | null;
      if (!json) throw new RpcError(`${method}: not JSON (HTTP ${res.status})`);
      if (json.error) throw new RpcError(`${method}: ${json.error.code} ${json.error.message}`);
      if (!("result" in json)) throw new RpcError(`${method}: no result`);
      return json.result as T;
    }
    throw lastError instanceof RpcError ? lastError : new RpcError(`${method}: ${String((lastError as Error)?.message ?? lastError)}`);
  }

  /** Every account the program owns that matches `filters`, with the slot the answer reflects. */
  async getProgramAccounts(programId: string, filters: Filter[], dataSlice?: { offset: number; length: number }): Promise<{ slot: number; accounts: KeyedAccount[] }> {
    const r = await this.call<{ context: { slot: number }; value: { pubkey: string; account: { data: unknown; owner: string; lamports: number } }[] }>("getProgramAccounts", [
      programId,
      { encoding: "base64", commitment: "confirmed", withContext: true, filters, ...(dataSlice ? { dataSlice } : {}) },
    ]);
    return { slot: r.context.slot, accounts: r.value.map((v) => ({ pubkey: v.pubkey, ...toAccount(v.account) })) };
  }

  /** Up to 100 accounts per call (the RPC limit); missing accounts are null. */
  async getMultipleAccounts(keys: string[]): Promise<{ slot: number; accounts: (AccountBytes | null)[] }> {
    const out: (AccountBytes | null)[] = [];
    let slot = 0;
    for (let i = 0; i < keys.length; i += 100) {
      const r = await this.call<{ context: { slot: number }; value: ({ data: unknown; owner: string; lamports: number } | null)[] }>("getMultipleAccounts", [
        keys.slice(i, i + 100),
        { encoding: "base64", commitment: "confirmed" },
      ]);
      slot = Math.max(slot, r.context.slot);
      out.push(...r.value.map((a) => (a ? toAccount(a) : null)));
    }
    return { slot, accounts: out };
  }

  getSignaturesForAddress(address: string, opts: { before?: string; until?: string; limit: number }): Promise<SignatureInfo[]> {
    return this.call<SignatureInfo[]>("getSignaturesForAddress", [address, { commitment: "confirmed", ...opts }]);
  }

  async getTransaction(signature: string): Promise<TransactionLogs | null> {
    const r = await this.call<{ slot: number; blockTime: number | null; meta: { err: unknown; logMessages?: string[] | null } | null } | null>("getTransaction", [
      signature,
      { commitment: "confirmed", maxSupportedTransactionVersion: 0, encoding: "json" },
    ]);
    if (!r) return null;
    return { slot: r.slot, blockTime: r.blockTime, err: r.meta?.err ?? null, logs: r.meta?.logMessages ?? [] };
  }

  async getTokenAccountsByOwner(owner: string, programId: string): Promise<KeyedAccount[]> {
    const r = await this.call<{ value: { pubkey: string; account: { data: unknown; owner: string; lamports: number } }[] }>("getTokenAccountsByOwner", [
      owner,
      { programId },
      { encoding: "base64", commitment: "confirmed", dataSlice: { offset: 0, length: 72 } },
    ]);
    return r.value.map((v) => ({ pubkey: v.pubkey, ...toAccount(v.account) }));
  }

  async getBalance(address: string): Promise<number> {
    return (await this.call<{ value: number }>("getBalance", [address, { commitment: "confirmed" }])).value;
  }
}

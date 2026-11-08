/**
 * Token-2022 layouts the indexer reads. Parabull mints are Token-2022 mints carrying the TokenMetadata extension on
 * the mint itself (programs/parabull/src/instructions/create.rs), set once at `create` and never changeable, so the
 * name, symbol and URI can always be read back from the chain, even for a coin whose `TokenCreated` log was missed.
 *
 *   Mint:    82-byte base (supply at 36, decimals at 44), padded to 165, account type 1 at 165, TLV from 166
 *   Account: 165-byte base (mint 0..32, owner 32..64, amount 64..72), account type 2 at 165, TLV from 166
 *   TLV:     u16 type, u16 length, value; TokenMetadata is type 19:
 *            update_authority [32], mint [32], name, symbol, uri (u32-length strings), additional (u32 count of pairs)
 */
import { base58Encode } from "../../parabull-edge/src/solana";
import { Reader, Writer } from "./borsh";

export const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const MINT_BASE = 82;
const ACCOUNT_BASE = 165;
const ACCOUNT_TYPE_MINT = 1;
const ACCOUNT_TYPE_ACCOUNT = 2;
const EXT_TOKEN_METADATA = 19;

export interface MintInfo {
  supply: bigint;
  decimals: number;
  metadata: { name: string; symbol: string; uri: string } | null;
}

function tlv(data: Uint8Array, start: number): Map<number, Uint8Array> {
  const out = new Map<number, Uint8Array>();
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let o = start;
  while (o + 4 <= data.length) {
    const type = view.getUint16(o, true);
    const len = view.getUint16(o + 2, true);
    if (type === 0 || o + 4 + len > data.length) break;
    out.set(type, data.subarray(o + 4, o + 4 + len));
    o += 4 + len;
  }
  return out;
}

export function parseMint(data: Uint8Array): MintInfo | null {
  if (data.length < MINT_BASE) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const supply = view.getBigUint64(36, true);
  const decimals = data[44];
  if (data[45] !== 1) return null; // not initialized
  let metadata: MintInfo["metadata"] = null;
  if (data.length > ACCOUNT_BASE && data[ACCOUNT_BASE] === ACCOUNT_TYPE_MINT) {
    const value = tlv(data, ACCOUNT_BASE + 1).get(EXT_TOKEN_METADATA);
    if (value) {
      try {
        const r = new Reader(value);
        r.take(64); // update authority, mint
        metadata = { name: r.string(), symbol: r.string(), uri: r.string() };
      } catch {
        metadata = null;
      }
    }
  }
  return { supply, decimals, metadata };
}

export interface TokenAccountInfo {
  mint: string;
  owner: string;
  amount: bigint;
}

export function parseTokenAccount(data: Uint8Array): TokenAccountInfo | null {
  if (data.length < 72) return null;
  if (data.length > ACCOUNT_BASE && data[ACCOUNT_BASE] !== ACCOUNT_TYPE_ACCOUNT) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return { mint: base58Encode(data.subarray(0, 32)), owner: base58Encode(data.subarray(32, 64)), amount: view.getBigUint64(64, true) };
}

/** `owner` and `amount` from a 40-byte dataSlice at offset 32 (what holder scans ask getProgramAccounts for). */
export function parseOwnerAmount(slice: Uint8Array): { owner: string; amount: bigint } | null {
  if (slice.length < 40) return null;
  const view = new DataView(slice.buffer, slice.byteOffset, slice.byteLength);
  return { owner: base58Encode(slice.subarray(0, 32)), amount: view.getBigUint64(32, true) };
}

// ---- encoders, for tests and the mock RPC ---------------------------------------------------------------------

export function encodeMint(o: { mint: string; supply: bigint; decimals?: number; name?: string; symbol?: string; uri?: string }): Uint8Array {
  const base = new Uint8Array(ACCOUNT_BASE + 1);
  const view = new DataView(base.buffer);
  view.setBigUint64(36, o.supply, true);
  base[44] = o.decimals ?? 6;
  base[45] = 1;
  base[ACCOUNT_BASE] = ACCOUNT_TYPE_MINT;
  if (o.name === undefined) return base;
  const v = new Writer();
  v.bytes(new Uint8Array(32));
  v.pubkey(o.mint);
  v.string(o.name);
  v.string(o.symbol ?? "");
  v.string(o.uri ?? "");
  v.u32(0);
  const value = v.finish();
  const w = new Writer();
  w.bytes(base);
  w.u16(EXT_TOKEN_METADATA);
  w.u16(value.length);
  w.bytes(value);
  return w.finish();
}

export function encodeTokenAccount(o: TokenAccountInfo): Uint8Array {
  const w = new Writer();
  w.pubkey(o.mint);
  w.pubkey(o.owner);
  w.u64(o.amount);
  w.bytes(new Uint8Array(ACCOUNT_BASE - 72));
  w.u8(ACCOUNT_TYPE_ACCOUNT);
  w.u16(7); // ImmutableOwner, as associated token accounts carry
  w.u16(0);
  return w.finish();
}

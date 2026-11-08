/**
 * Just enough Solana for the Worker to answer "did this wallet create this coin?" without a Solana SDK:
 * base58, the ed25519 on-curve test, program-derived addresses, and reading the Parabull bonding curve's `creator`
 * over JSON-RPC. Checked against @solana/web3.js vectors in src/broadcast.test.ts.
 *
 * BondingCurve (app/src/idl/parabull.json): 8-byte discriminator, then bump u8, complete bool, migrated bool,
 * escrow_released bool, mint pubkey (bytes 12..44), creator pubkey (44..76), ...
 */
import { base58Decode } from "../../../app/src/lib/chatMessage";

/** The Parabull program (the committed IDL's address); PARABULL_PROGRAM_ID overrides it per cluster. */
export const PARABULL_PROGRAM_ID = "8tBGLgWXDAssTBgUaamsB4ZbyRQivNDiGFiyTMfQiPFW";
export const BONDING_CURVE_DISCRIMINATOR = [23, 183, 248, 55, 96, 216, 172, 96];

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58Encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let s = "";
  while (n > 0n) {
    s = B58[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    s = "1" + s;
  }
  return s;
}

// --- ed25519: is a 32-byte string a valid point? (RFC 8032 decoding) -------------------------------------------
const P = 2n ** 255n - 19n;
const mod = (a: bigint) => {
  const r = a % P;
  return r >= 0n ? r : r + P;
};
function pow(b: bigint, e: bigint): bigint {
  let r = 1n;
  b = mod(b);
  while (e > 0n) {
    if (e & 1n) r = (r * b) % P;
    b = (b * b) % P;
    e >>= 1n;
  }
  return r;
}
const D = mod(-121665n * pow(121666n, P - 2n));
const SQRT_M1 = pow(2n, (P - 1n) / 4n);

export function isOnCurve(bytes: Uint8Array): boolean {
  if (bytes.length !== 32) return false;
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(i === 31 ? bytes[i] & 0x7f : bytes[i]);
  if (y >= P) return false;
  const sign = (bytes[31] & 0x80) !== 0;
  const y2 = (y * y) % P;
  const u = mod(y2 - 1n);
  const v = mod(D * y2 + 1n);
  const v3 = (((v * v) % P) * v) % P;
  const v7 = (((v3 * v3) % P) * v) % P;
  let x = (((u * v3) % P) * pow((u * v7) % P, (P - 5n) / 8n)) % P;
  const vx2 = (((v * x) % P) * x) % P;
  if (vx2 !== u) {
    if (vx2 !== mod(-u)) return false;
    x = (x * SQRT_M1) % P;
  }
  return !(x === 0n && sign);
}

async function sha256(...parts: Uint8Array[]): Promise<Uint8Array> {
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.length;
  }
  return new Uint8Array(await crypto.subtle.digest("SHA-256", all));
}

const utf8 = new TextEncoder();

/** PublicKey.findProgramAddressSync: the first bump from 255 down whose hash is off the curve. */
export async function findProgramAddress(seeds: Uint8Array[], programId: string): Promise<{ address: string; bump: number }> {
  const program = base58Decode(programId);
  if (!program || program.length !== 32) throw new Error("bad program id");
  for (let bump = 255; bump >= 0; bump--) {
    const h = await sha256(...seeds, Uint8Array.of(bump), program, utf8.encode("ProgramDerivedAddress"));
    if (!isOnCurve(h)) return { address: base58Encode(h), bump };
  }
  throw new Error("no program address found");
}

export const bondingCurveAddress = (mint: string, programId = PARABULL_PROGRAM_ID) => {
  const m = base58Decode(mint);
  if (!m || m.length !== 32) throw new Error("bad mint");
  return findProgramAddress([utf8.encode("bonding-curve"), m], programId);
};

export type CreatorLookup = { ok: true; creator: string } | { ok: false; status: number; error: string };

/** The coin's creator from its on-chain bonding curve (owner, discriminator and mint all checked). */
export async function curveCreator(rpcUrl: string, mint: string, programId: string, fetchImpl: typeof fetch = fetch): Promise<CreatorLookup> {
  const { address } = await bondingCurveAddress(mint, programId);
  let value: { owner?: string; data?: [string, string] } | null;
  try {
    const res = await fetchImpl(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [address, { encoding: "base64", commitment: "confirmed" }] }),
    });
    const json = (await res.json()) as { result?: { value: typeof value }; error?: unknown };
    if (!res.ok || json.error || !json.result) return { ok: false, status: 502, error: "Solana RPC error" };
    value = json.result.value;
  } catch {
    return { ok: false, status: 502, error: "Solana RPC unreachable" };
  }
  if (!value) return { ok: false, status: 404, error: "not a Parabull coin on this cluster" };
  if (value.owner !== programId || !Array.isArray(value.data) || value.data[1] !== "base64") return { ok: false, status: 404, error: "not a Parabull bonding curve" };
  const data = Uint8Array.from(atob(value.data[0]), (c) => c.charCodeAt(0));
  if (data.length < 76 || BONDING_CURVE_DISCRIMINATOR.some((b, i) => data[i] !== b)) return { ok: false, status: 404, error: "not a Parabull bonding curve" };
  if (base58Encode(data.slice(12, 44)) !== mint) return { ok: false, status: 404, error: "bonding curve is for another mint" };
  return { ok: true, creator: base58Encode(data.slice(44, 76)) };
}

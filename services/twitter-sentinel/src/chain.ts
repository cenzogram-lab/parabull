/** Reads the Parabull program: a coin's bonding curve, its creator, its ticker, and the curve's graduation target. */
import { readFileSync } from "node:fs";
import { BorshAccountsCoder, type Idl } from "@coral-xyz/anchor";
import { getTokenMetadata, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { type Connection, PublicKey } from "@solana/web3.js";
import { graduationRaise, type CurveView } from "./milestones";

/** The committed IDL copy the app uses (app/src/idl), so the service decodes exactly what the program writes. */
export const IDL = JSON.parse(readFileSync(new URL("../../../app/src/idl/parabull.json", import.meta.url), "utf8")) as Idl;

export interface CurveState extends CurveView {
  creator: string;
}

const coder = new BorshAccountsCoder(IDL);
const big = (v: { toString(): string }) => BigInt(v.toString());

export function decodeCurve(data: Buffer): CurveState {
  const c = coder.decode("BondingCurve", data);
  return { realSol: big(c.real_sol_reserves), complete: c.complete, migrated: c.migrated, creator: (c.creator as PublicKey).toBase58() };
}

export function decodeRaise(data: Buffer): bigint {
  const g = coder.decode("Global", data);
  return graduationRaise({ virtualToken: big(g.initial_virtual_token_reserves), virtualSol: big(g.initial_virtual_sol_reserves), realToken: big(g.initial_real_token_reserves) });
}

/** What the sentinel needs from the chain; tests swap in a fake. */
export interface ChainSource {
  curve(mint: string): Promise<CurveState | null>;
  raise(): Promise<bigint>;
  ticker(mint: string): Promise<string | null>;
  /** Calls `onChange` when the curve account changes; returns an unsubscribe. */
  watch(mint: string, onChange: (state: CurveState) => void): () => void;
}

export class Chain implements ChainSource {
  private raiseCache: bigint | null = null;
  private readonly tickers = new Map<string, string>();

  constructor(
    private readonly connection: Connection,
    readonly programId: PublicKey = new PublicKey(IDL.address),
  ) {}

  curvePda(mint: string) {
    return PublicKey.findProgramAddressSync([Buffer.from("bonding-curve"), new PublicKey(mint).toBuffer()], this.programId)[0];
  }

  async curve(mint: string) {
    const info = await this.connection.getAccountInfo(this.curvePda(mint), "confirmed");
    return info ? decodeCurve(info.data) : null;
  }

  async raise() {
    if (this.raiseCache === null) {
      const global = PublicKey.findProgramAddressSync([Buffer.from("global")], this.programId)[0];
      const info = await this.connection.getAccountInfo(global, "confirmed");
      if (!info) throw new Error(`no Global account at ${global.toBase58()}: is the program initialized on this cluster?`);
      this.raiseCache = decodeRaise(info.data);
    }
    return this.raiseCache;
  }

  /** The symbol from the mint's Token-2022 metadata (set once at launch, never changeable). */
  async ticker(mint: string) {
    const known = this.tickers.get(mint);
    if (known) return known;
    const meta = await getTokenMetadata(this.connection, new PublicKey(mint), "confirmed", TOKEN_2022_PROGRAM_ID);
    if (!meta?.symbol) return null;
    this.tickers.set(mint, meta.symbol);
    return meta.symbol;
  }

  watch(mint: string, onChange: (state: CurveState) => void) {
    const id = this.connection.onAccountChange(this.curvePda(mint), (info) => onChange(decodeCurve(info.data)), { commitment: "confirmed" });
    return () => void this.connection.removeAccountChangeListener(id);
  }
}

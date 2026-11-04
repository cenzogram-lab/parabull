/** PDA seeds mirror programs/parabull/src/constants.rs (browser version of scripts/src/pdas.ts). */
import { PublicKey } from "@solana/web3.js";

const enc = (s: string) => new TextEncoder().encode(s);
const u64le = (n: bigint) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, n, true);
  return b;
};

export const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

export class Pdas {
  constructor(readonly programId: PublicKey) {}
  private find(seeds: Uint8Array[]) {
    return PublicKey.findProgramAddressSync(seeds, this.programId)[0];
  }
  global = () => this.find([enc("global")]);
  bondingCurve = (mint: PublicKey) => this.find([enc("bonding-curve"), mint.toBytes()]);
  mintAuthority = () => this.find([enc("mint-authority")]);
  ticket = (payer: PublicKey, nonce: bigint) => this.find([enc("ticket"), payer.toBytes(), u64le(nonce)]);
  tickerRegistry = (ticker: string) => this.find([enc("registry"), enc(ticker)]);
  nameRegistry = (nameHash: Uint8Array) => this.find([enc("name"), nameHash]);
  tweetRegistry = (tweetIdHash: Uint8Array) => this.find([enc("tweet"), tweetIdHash]);
  holderVault = () => this.find([enc("holder-vault")]);
  buybackVault = () => this.find([enc("buyback-vault")]);
  rewardEpoch = (epoch: bigint) => this.find([enc("reward-epoch"), u64le(epoch)]);
}

/** Token-2022 associated token account (launched mints are Token-2022). */
export const ata2022 = (mint: PublicKey, owner: PublicKey) =>
  PublicKey.findProgramAddressSync([owner.toBytes(), TOKEN_2022_PROGRAM_ID.toBytes(), mint.toBytes()], ASSOCIATED_TOKEN_PROGRAM_ID)[0];

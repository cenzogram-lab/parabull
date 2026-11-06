/**
 * One place for everything the UI does with the Parabull program: the typed
 * Anchor client (IDL synced from target/ by `npm run sync-idl`), PDAs, the
 * on-chain curve math for quotes, and the transactions the app sends.
 */
import { useCallback, useMemo } from "react";
import { AnchorProvider, BN, Program, type Wallet } from "@coral-xyz/anchor";
import { useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";
import { PublicKey, SystemProgram, type Connection, type Transaction, type VersionedTransaction } from "@solana/web3.js";
import { CONFIG } from "../config";
import idlJson from "../idl/parabull.json";
import type { Parabull } from "../idl/parabull";
import { ASSOCIATED_TOKEN_PROGRAM_ID, ata2022, Pdas, TOKEN_2022_PROGRAM_ID } from "../lib/pdas";
import { quoteBuyWithSol, quoteSellTokens } from "../lib/quote";

const idl = idlJson as unknown as Parabull;

/** Provider wallet for read-only use before a wallet connects. */
const READ_ONLY: Wallet = {
  publicKey: PublicKey.default,
  signTransaction: async <T extends Transaction | VersionedTransaction>(): Promise<T> => {
    throw new Error("Connect a wallet to sign");
  },
  signAllTransactions: async <T extends Transaction | VersionedTransaction>(): Promise<T[]> => {
    throw new Error("Connect a wallet to sign");
  },
} as unknown as Wallet;

/** A program client that can only read: for app-wide state that shouldn't wait for, or change with, the wallet. */
export const readOnlyProgram = (connection: Connection) => new Program<Parabull>(idl, new AnchorProvider(connection, READ_ONLY, { commitment: "confirmed" }));

const bn = (v: bigint | number) => new BN(v.toString());

export interface LaunchRequest {
  name: string;
  symbol: string;
  uri: string;
  tweetId: bigint | null;
}

export function useParabullProgram() {
  const { connection } = useConnection();
  const wallet = useAnchorWallet();

  const program = useMemo(
    () => new Program<Parabull>(idl, new AnchorProvider(connection, (wallet as Wallet | undefined) ?? READ_ONLY, { commitment: "confirmed" })),
    [connection, wallet],
  );
  const pdas = useMemo(() => new Pdas(program.programId), [program]);

  const requireWallet = useCallback(() => {
    if (!wallet) throw new Error("Connect a wallet first");
    return wallet;
  }, [wallet]);

  const fetchGlobal = useCallback(() => program.account.global.fetchNullable(pdas.global()), [program, pdas]);
  const fetchCurve = useCallback((mint: PublicKey) => program.account.bondingCurve.fetchNullable(pdas.bondingCurve(mint)), [program, pdas]);

  /** User pays the flat ticket; the backend's launch worker sends `create` 3-15 s later. */
  const requestLaunch = useCallback(
    async ({ name, symbol, uri, tweetId }: LaunchRequest) => {
      const w = requireWallet();
      const nonce = BigInt(Date.now());
      const ticket = pdas.ticket(w.publicKey, nonce);
      const signature = await program.methods
        .requestLaunch(bn(nonce), name, symbol, uri, tweetId === null ? null : bn(tweetId))
        .accountsStrict({ payer: w.publicKey, global: pdas.global(), ticket, systemProgram: SystemProgram.programId })
        .rpc();
      return { ticket, signature, nonce, requestedAt: Math.floor(Date.now() / 1000) };
    },
    [program, pdas, requireWallet],
  );

  /**
   * Wait for the launch worker: the ticket closes (create or refund), then
   * the ticker registry tells which. Resolves to the new mint, or null if the
   * ticket was refunded.
   */
  const waitForLaunch = useCallback(
    async (ticket: PublicKey, symbol: string, requestedAt: number, opts: { signal?: AbortSignal; pollMs?: number } = {}) => {
      const deadline = Date.now() + 11 * 60_000;
      while (await program.account.launchTicket.fetchNullable(ticket)) {
        if (opts.signal?.aborted) throw new Error("cancelled");
        if (Date.now() > deadline) throw new Error("The launch worker did not respond before the ticket expired; refund it from your wallet.");
        await new Promise((r) => setTimeout(r, opts.pollMs ?? 1500));
      }
      const reg = await program.account.tickerRegistry.fetchNullable(pdas.tickerRegistry(symbol));
      if (!reg || reg.mint.equals(PublicKey.default) || reg.launchTimestamp.toNumber() < requestedAt - 5) return null;
      return reg.mint;
    },
    [program, pdas],
  );

  const tradeAccounts = useCallback(
    (mint: PublicKey, user: PublicKey) => {
      const curve = pdas.bondingCurve(mint);
      return {
        user,
        global: pdas.global(),
        mint,
        bondingCurve: curve,
        curveTokenAccount: ata2022(mint, curve),
        userTokenAccount: ata2022(mint, user),
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      };
    },
    [pdas],
  );

  /** `buy(amount, max_sol_cost)`: exact tokens, total cost (incl. 1% fee) capped. */
  const buy = useCallback(
    async (mint: PublicKey, tokens: bigint, maxSolCost: bigint) => {
      const w = requireWallet();
      return program.methods.buy(bn(tokens), bn(maxSolCost)).accountsStrict(tradeAccounts(mint, w.publicKey)).rpc();
    },
    [program, requireWallet, tradeAccounts],
  );

  /** `sell(amount, min_sol_output)`: net of the 1% fee. */
  const sell = useCallback(
    async (mint: PublicKey, tokens: bigint, minSolOutput: bigint) => {
      const w = requireWallet();
      return program.methods.sell(bn(tokens), bn(minSolOutput)).accountsStrict(tradeAccounts(mint, w.publicKey)).rpc();
    },
    [program, requireWallet, tradeAccounts],
  );

  /** Claim a $PARABULL holder reward with a proof from the epoch's snapshot artifact. */
  const claimHolderReward = useCallback(
    async (epoch: number, index: number, amount: bigint, proof: Uint8Array[]) => {
      const w = requireWallet();
      return program.methods
        .claimHolderReward(bn(epoch), index, bn(amount), proof.map((p) => Array.from(p)))
        .accountsStrict({ holderVault: pdas.holderVault(), rewardEpoch: pdas.rewardEpoch(BigInt(epoch)), claimant: w.publicKey })
        .rpc();
    },
    [program, pdas, requireWallet],
  );

  return {
    mode: CONFIG.mode,
    program,
    pdas,
    connected: Boolean(wallet),
    publicKey: wallet?.publicKey ?? null,
    fetchGlobal,
    fetchCurve,
    requestLaunch,
    waitForLaunch,
    buy,
    sell,
    claimHolderReward,
    quoteBuyWithSol,
    quoteSellTokens,
  };
}

export type ParabullClient = ReturnType<typeof useParabullProgram>;

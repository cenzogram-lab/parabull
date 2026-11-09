/**
 * One place for everything the UI does with the Parabull program: the typed
 * Anchor client (IDL synced from target/ by `npm run sync-idl`), PDAs, the
 * on-chain curve math for quotes, and the transactions the app sends.
 */
import { useCallback, useMemo } from "react";
import { AnchorProvider, BN, Program, type Wallet } from "@coral-xyz/anchor";
import { useConnection } from "@solana/wallet-adapter-react";
import { PublicKey, SystemProgram, type Connection, type Transaction, type TransactionInstruction, type VersionedTransaction } from "@solana/web3.js";
import { CONFIG } from "../config";
import idlJson from "../idl/parabull.json";
import type { Parabull } from "../idl/parabull";
import { clusterUnixTime, launchedBy } from "../lib/launchLocks";
import { launchWaitDeadline } from "../lib/launchRules";
import { sendBudgeted, type IdlError } from "../lib/txSend";
import { ASSOCIATED_TOKEN_PROGRAM_ID, ata2022, Pdas, TOKEN_2022_PROGRAM_ID } from "../lib/pdas";
import { quoteBuyWithSol, quoteSellTokens } from "../lib/quote";
import { buyMethod } from "../lib/buy";
import { useUnifiedWallet } from "../wallet/UnifiedWallet";

const idl = idlJson as unknown as Parabull;
const IDL_ERRORS = (idlJson as { errors?: IdlError[] }).errors ?? [];

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

/** An open launch ticket of the connected wallet, as the refund list shows it. */
export interface OpenTicket {
  address: PublicKey;
  ticker: string;
  depositLamports: bigint;
  /** Unix seconds (on-chain). */
  expiresAt: number;
}

export interface LaunchRequest {
  name: string;
  symbol: string;
  uri: string;
  tweetId: bigint | null;
}

export function useParabullProgram() {
  const { connection } = useConnection();
  // Whichever path the user connected with (browser wallet, imported key, Internet Identity) signs through this.
  const unified = useUnifiedWallet();
  const { publicKey, signTransaction, signAllTransactions } = unified;
  const wallet = useMemo<Wallet | undefined>(
    () => (publicKey ? ({ publicKey, signTransaction, signAllTransactions } as unknown as Wallet) : undefined),
    [publicKey, signTransaction, signAllTransactions],
  );

  const program = useMemo(
    () => new Program<Parabull>(idl, new AnchorProvider(connection, wallet ?? READ_ONLY, { commitment: "confirmed" })),
    [connection, wallet],
  );
  const pdas = useMemo(() => new Pdas(program.programId), [program]);

  const requireWallet = useCallback(() => {
    if (!wallet) throw new Error("Connect a wallet first");
    return wallet;
  }, [wallet]);

  const fetchGlobal = useCallback(() => program.account.global.fetchNullable(pdas.global()), [program, pdas]);
  const fetchCurve = useCallback((mint: PublicKey) => program.account.bondingCurve.fetchNullable(pdas.bondingCurve(mint), "confirmed"), [program, pdas]);
  /** The cluster's unix time (Clock sysvar), seconds. */
  const clusterTime = useCallback(() => clusterUnixTime(connection), [connection]);

  /**
   * Sends instructions as the connected wallet with a simulated compute limit, a priority fee priced on `feeAccounts`,
   * and confirmation by polling with rebroadcast until the blockhash expires (lib/txSend.ts).
   */
  const sendIxs = useCallback(
    async (instructions: TransactionInstruction[], feeAccounts: PublicKey[]) => {
      const w = requireWallet();
      const { signature } = await sendBudgeted({
        connection,
        payer: w.publicKey,
        signTransaction: (tx) => w.signTransaction(tx),
        instructions,
        feeAccounts,
        idlErrors: IDL_ERRORS,
      });
      return signature;
    },
    [connection, requireWallet],
  );

  /** User pays the flat ticket; the backend's launch worker sends `create` 3-15 s later. */
  const requestLaunch = useCallback(
    async ({ name, symbol, uri, tweetId }: LaunchRequest) => {
      const w = requireWallet();
      const nonce = BigInt(Date.now());
      const ticket = pdas.ticket(w.publicKey, nonce);
      const ix = await program.methods
        .requestLaunch(bn(nonce), name, symbol, uri, tweetId === null ? null : bn(tweetId))
        .accountsStrict({ payer: w.publicKey, global: pdas.global(), ticket, tickerRegistry: pdas.tickerRegistry(symbol), systemProgram: SystemProgram.programId })
        .instruction();
      // Confirmed by polling until the blockhash expires: a ticket that is still landing is never reported as failed.
      const signature = await sendIxs([ix], [pdas.global()]);
      const requestedAt = await clusterUnixTime(connection).catch(() => Math.floor(Date.now() / 1000));
      return { ticket, signature, nonce, payer: w.publicKey, requestedAt };
    },
    [program, pdas, requireWallet, connection, sendIxs],
  );

  /** The payer's own refund (refund_ticket): the program allows it once the ticket has expired. */
  const refundTicket = useCallback(
    async (ticket: PublicKey) => {
      const w = requireWallet();
      const ix = await program.methods.refundTicket().accountsStrict({ authority: w.publicKey, payer: w.publicKey, global: pdas.global(), ticket }).instruction();
      return sendIxs([ix], [ticket]);
    },
    [program, pdas, requireWallet, sendIxs],
  );

  /** The wallet's open launch tickets (LaunchTicket.payer sits after the discriminator and bump, at byte 9). */
  const openTickets = useCallback(
    async (payer: PublicKey): Promise<OpenTicket[]> => {
      const all = await program.account.launchTicket.all([{ memcmp: { offset: 9, bytes: payer.toBase58() } }]);
      return all
        .map(({ publicKey, account: t }) => ({
          address: publicKey,
          ticker: String.fromCharCode(...t.ticker.slice(0, t.tickerLen)),
          depositLamports: BigInt(t.depositLamports.toString()),
          expiresAt: t.expiresAt.toNumber(),
        }))
        .sort((a, b) => a.expiresAt - b.expiresAt);
    },
    [program],
  );

  /**
   * Wait for the launch worker: the ticket closes (create or refund), then the ticker registry and the new curve's
   * creator tell which (`launchedBy`). Resolves to our new mint, or null if the ticket was refunded. Gives up at the
   * ticket's own on-chain expiry (plus a short grace), judged at cluster time, since the program refuses `create`
   * after it; the ticket can then be refunded (TicketExpiredError).
   */
  const waitForLaunch = useCallback(
    async (ticket: PublicKey, symbol: string, requestedAt: number, payer: PublicKey, opts: { signal?: AbortSignal; pollMs?: number } = {}) => {
      let deadline: number | null = null;
      // Cluster time minus local time, so the deadline doesn't depend on this device's clock.
      const skewMs = await clusterUnixTime(connection).then((t) => t * 1000 - Date.now()).catch(() => 0);
      for (;;) {
        const open = await program.account.launchTicket.fetchNullable(ticket);
        if (!open) break;
        if (opts.signal?.aborted) throw new Error("cancelled");
        deadline ??= launchWaitDeadline(open.expiresAt.toNumber());
        if (Date.now() + skewMs > deadline) throw new TicketExpiredError(ticket);
        await new Promise((r) => setTimeout(r, opts.pollMs ?? 1500));
      }
      const reg = await program.account.tickerRegistry.fetchNullable(pdas.tickerRegistry(symbol));
      const curve = reg && !reg.mint.equals(PublicKey.default) ? await program.account.bondingCurve.fetchNullable(pdas.bondingCurve(reg.mint)) : null;
      return launchedBy(reg, curve?.creator ?? null, payer, requestedAt);
    },
    [program, pdas, connection],
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

  /**
   * `buy(amount, max_sol_cost)`: exact tokens, total cost (incl. 1% fee) capped. `refCalloutId` adds the referral Memo
   * instruction after it (src/lib/referral.ts).
   */
  const buy = useCallback(
    async (mint: PublicKey, tokens: bigint, maxSolCost: bigint, refCalloutId: string | null = null) => {
      const w = requireWallet();
      const accounts = tradeAccounts(mint, w.publicKey);
      const tx = await buyMethod(program, accounts, bn(tokens), bn(maxSolCost), refCalloutId).transaction();
      return sendIxs(tx.instructions, [accounts.bondingCurve]);
    },
    [program, requireWallet, tradeAccounts, sendIxs],
  );

  /** `sell(amount, min_sol_output)`: net of the 1% fee. */
  const sell = useCallback(
    async (mint: PublicKey, tokens: bigint, minSolOutput: bigint) => {
      const w = requireWallet();
      const accounts = tradeAccounts(mint, w.publicKey);
      const ix = await program.methods.sell(bn(tokens), bn(minSolOutput)).accountsStrict(accounts).instruction();
      return sendIxs([ix], [accounts.bondingCurve]);
    },
    [program, requireWallet, tradeAccounts, sendIxs],
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
    walletType: unified.walletType,
    program,
    pdas,
    connected: Boolean(wallet),
    publicKey: wallet?.publicKey ?? null,
    fetchGlobal,
    fetchCurve,
    clusterTime,
    requestLaunch,
    waitForLaunch,
    refundTicket,
    openTickets,
    buy,
    sell,
    claimHolderReward,
    quoteBuyWithSol,
    quoteSellTokens,
  };
}

export type ParabullClient = ReturnType<typeof useParabullProgram>;

/** The ticket outlived its expiry without a `create`: only a refund can close it now. */
export class TicketExpiredError extends Error {
  constructor(readonly ticket: PublicKey) {
    super("The ticket expired before the launch worker created the coin. Its full deposit can be refunded to your wallet.");
    this.name = "TicketExpiredError";
  }
}

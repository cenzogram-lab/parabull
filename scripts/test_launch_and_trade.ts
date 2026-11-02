/**
 * Devnet smoke test of the launch + trading path:
 *   request_launch (user pays the ticket) -> create (launch authority + fresh
 *   mint keypair) -> a buy inside the slot delay (expect TradingNotOpenYet) ->
 *   wait for trading_open_slot -> buy -> sell, with slippage from src/curve.ts.
 *
 *   CLUSTER=devnet npm run smoke
 * Env: ADMIN_KEYPAIR (funds the test user and pays fees), LAUNCH_AUTHORITY_KEYPAIR,
 * TWEET (optional announcement tweet URL or status ID; locked for 3 days).
 */
import { Keypair, LAMPORTS_PER_SOL, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { roles } from "./src/config";
import { applySlippage, quoteBuyExactTokens, quoteSell } from "./src/curve";
import { canonicalTicker, nameHash, parseTweetId, tweetIdHash } from "./src/launch";
import { ata2022 } from "./src/pdas";
import { anchorErrorName, big, bn, connect, send } from "./src/program";

const SLIPPAGE_BPS = 200n;
const TOKENS = 10_000_000_000_000n; // 10M tokens (6 decimals)

async function main() {
  const { admin, launchAuthority } = roles();
  const { connection, program, pdas } = connect(admin);
  const global = await program.account.global.fetch(pdas.global());
  const feeBps = BigInt(global.platformFeeBps);

  // A throwaway user funded by the admin (devnet faucets are rate-limited).
  const user = Keypair.generate();
  await sendAndConfirmTransaction(
    connection,
    new Transaction().add(SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: user.publicKey, lamports: 1.5 * LAMPORTS_PER_SOL })),
    [admin],
  );

  // ---- 1. request_launch ----
  const suffix = Math.random().toString(36).slice(2, 7).toUpperCase().replace(/[^A-Z0-9]/g, "X");
  const symbol = canonicalTicker(`PB${suffix}`);
  const name = `Parabull Smoke ${suffix}`;
  const uri = "https://example.com/parabull-smoke.json";
  const nonce = BigInt(Date.now());
  const ticket = pdas.ticket(user.publicKey, nonce);
  const tweetId = process.env.TWEET ? parseTweetId(process.env.TWEET) : null;
  await program.methods
    .requestLaunch(bn(nonce), name, symbol, uri, tweetId === null ? null : bn(tweetId))
    .accountsStrict({ payer: user.publicKey, global: pdas.global(), ticket, systemProgram: SystemProgram.programId })
    .signers([user])
    .rpc();
  console.log(`ticket ${ticket.toBase58()} for $${symbol}`);

  // ---- 2. create (backend: launch authority + fresh mint keypair) ----
  const mint = Keypair.generate();
  const curve = pdas.bondingCurve(mint.publicKey);
  const createIx = await program.methods
    .create(name, symbol, uri)
    .accountsStrict({
      launchAuthority: launchAuthority.publicKey,
      global: pdas.global(),
      ticket,
      payer: user.publicKey,
      treasury: global.treasury,
      mint: mint.publicKey,
      mintAuthority: pdas.mintAuthority(),
      bondingCurve: curve,
      curveTokenAccount: ata2022(mint.publicKey, curve),
      tickerRegistry: pdas.tickerRegistry(symbol),
      nameRegistry: pdas.nameRegistry(nameHash(name)),
      tweetRegistry: tweetId === null ? null : pdas.tweetRegistry(tweetIdHash(tweetId)),
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
  await send(connection, [createIx], [admin, launchAuthority, mint].filter((k, i, a) => a.findIndex((x) => x.publicKey.equals(k.publicKey)) === i));
  let c = await program.account.bondingCurve.fetch(curve);
  console.log(`created mint ${mint.publicKey.toBase58()} at slot ${c.createdSlot}, trading opens at ${c.tradingOpenSlot}`);

  const tradeAccounts = {
    user: user.publicKey,
    global: pdas.global(),
    mint: mint.publicKey,
    bondingCurve: curve,
    curveTokenAccount: ata2022(mint.publicKey, curve),
    userTokenAccount: ata2022(mint.publicKey, user.publicKey),
    tokenProgram: TOKEN_2022_PROGRAM_ID,
    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
  };
  const reserves = () => ({ virtualToken: big(c.virtualTokenReserves), virtualSol: big(c.virtualSolReserves), realToken: big(c.realTokenReserves), realSol: big(c.realSolReserves) });

  // ---- 3. buy inside the slot delay: expected to be rejected ----
  if ((await connection.getSlot("confirmed")) < big(c.tradingOpenSlot)) {
    try {
      await program.methods.buy(bn(TOKENS), bn(10n ** 12n)).accountsStrict(tradeAccounts).signers([user]).rpc();
      console.log("WARNING: early buy landed (slot advanced past the delay before it executed)");
    } catch (e) {
      console.log(`early buy rejected as expected: ${anchorErrorName(e) ?? e}`);
    }
  }

  // ---- 4. wait for the open slot, then buy and sell ----
  while ((await connection.getSlot("confirmed")) < big(c.tradingOpenSlot)) await new Promise((r) => setTimeout(r, 400));
  c = await program.account.bondingCurve.fetch(curve);
  const q = quoteBuyExactTokens(reserves(), TOKENS, feeBps);
  const maxCost = applySlippage(q.total, SLIPPAGE_BPS, true);
  await program.methods.buy(bn(TOKENS), bn(maxCost)).accountsStrict(tradeAccounts).signers([user]).rpc();
  console.log(`bought ${q.tokensOut} for ~${q.total} lamports (max ${maxCost})`);

  c = await program.account.bondingCurve.fetch(curve);
  const sellAmt = TOKENS / 2n;
  const s = quoteSell(reserves(), sellAmt, feeBps);
  const minOut = applySlippage(s.solNet, SLIPPAGE_BPS, false);
  await program.methods.sell(bn(sellAmt), bn(minOut)).accountsStrict(tradeAccounts).signers([user]).rpc();
  console.log(`sold ${sellAmt} for ~${s.solNet} lamports (min ${minOut})`);

  c = await program.account.bondingCurve.fetch(curve);
  console.log("curve after trades:", {
    realSol: c.realSolReserves.toString(),
    escrow: c.escrowAccrued.toString(),
    buyback: c.buybackAccrued.toString(),
    holder: c.holderAccrued.toString(),
    treasury: c.treasuryAccrued.toString(),
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

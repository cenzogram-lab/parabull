import { test } from "node:test";
import assert from "node:assert/strict";
import { AnchorProvider, BN, BorshCoder, Program, Wallet } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage } from "@solana/web3.js";
import type { Parabull } from "../../target/types/parabull";
import { metadataCommitment, nameHash } from "./launch";
import { createLaunchWorker } from "./launchWorkerRunner";
import { Pdas } from "./pdas";
import { ParabullProgram, loadIdl } from "./program";

const NAME = "Parabull E2E ABCDE";
const SYMBOL = "E2EABCDE";
const URI = "https://example.com/e2e.json";
const NOW = 1_800_000_000n;

const real = new Program<Parabull>(loadIdl(), new AnchorProvider(new Connection("http://127.0.0.1:8899"), new Wallet(Keypair.generate()), {}));
const coder = real.coder as BorshCoder;
const pdas = new Pdas(real.programId);

interface Sent {
  name: string;
  ix: TransactionInstruction;
  signers: Keypair[];
}

/** A fake cluster holding one open ticket; `send` applies create / refund_ticket to it. */
async function harness(o: { metadataHash?: Buffer; paused?: boolean; open?: boolean; createErrors?: string[]; uri?: string } = {}) {
  const payer = Keypair.generate().publicKey;
  const treasury = Keypair.generate().publicKey;
  const launchAuthority = Keypair.generate();
  const nonce = 7n;
  const ticket = pdas.ticket(payer, nonce);
  const uri = o.uri ?? URI;
  const requestIx = await real.methods
    .requestLaunch(new BN(nonce.toString()), NAME, SYMBOL, uri, null)
    .accountsStrict({ payer, global: pdas.global(), ticket, systemProgram: SystemProgram.programId })
    .instruction();
  const message = new TransactionMessage({ payerKey: payer, recentBlockhash: PublicKey.default.toBase58(), instructions: [requestIx] }).compileToV0Message();
  const requestTx = { transaction: { message, signatures: [] }, meta: null };
  const tickerBytes = [...Buffer.from(SYMBOL), ...Array(10 - SYMBOL.length).fill(0)];
  const t = {
    payer,
    ticker: tickerBytes,
    tickerLen: SYMBOL.length,
    nameHash: [...nameHash(NAME)],
    metadataHash: [...(o.metadataHash ?? metadataCommitment(NAME, SYMBOL, uri))],
    tweetIdHash: null,
    expiresAt: new BN((NOW + 600n).toString()),
  };
  let open = o.open ?? true;
  const createErrors = [...(o.createErrors ?? [])];
  const minted = new Set<string>();
  const sent: Sent[] = [];
  const sleeps: number[] = [];
  const lookups: string[] = [];

  const program = {
    programId: real.programId,
    coder: real.coder,
    methods: real.methods,
    account: {
      global: { fetch: async () => ({ paused: o.paused ?? false, registryLockSeconds: new BN(259_200), treasury }) },
      launchTicket: {
        fetchNullable: async (k: PublicKey) => (open && k.equals(ticket) ? t : null),
        all: async () => (open ? [{ publicKey: ticket, account: t }] : []),
      },
      tickerRegistry: { fetchNullable: async () => null },
      nameRegistry: { fetchNullable: async () => null },
      tweetRegistry: { fetchNullable: async () => null },
    },
  } as unknown as ParabullProgram;
  const connection = {
    getSignaturesForAddress: async () => {
      lookups.push("signatures");
      return [{ signature: "request-sig" }];
    },
    getTransaction: async (sig: string) => (sig === "request-sig" ? requestTx : null),
    getAccountInfo: async (k: PublicKey) => ((k.equals(ticket) && open) || minted.has(k.toBase58()) ? { lamports: 1 } : null),
  } as unknown as Connection;
  const send = async (ixs: TransactionInstruction[], signers: Keypair[]) => {
    const ix = ixs[0];
    const name = coder.instruction.decode(ix.data)!.name;
    sent.push({ name, ix, signers });
    if (name === "create") {
      const err = createErrors.shift();
      if (err) throw Object.assign(new Error("Simulation failed"), { logs: err.startsWith("rpc:") ? [] : [`Program log: AnchorError occurred. Error Code: ${err}. Error Number: 6000.`] });
      open = false;
      minted.add(signers[1].publicKey.toBase58());
      return "create-sig";
    }
    if (name === "refundTicket") {
      open = false;
      return "refund-sig";
    }
    throw new Error(`unexpected ${name}`);
  };
  const worker = createLaunchWorker({
    connection,
    program,
    pdas,
    launchAuthority,
    skipMetadataFetch: o.uri === undefined,
    delayMs: () => 4_321,
    sleep: async (ms) => void sleeps.push(ms),
    send,
    now: () => NOW,
  });
  return { worker, ticket, payer, treasury, launchAuthority, sent, sleeps, lookups };
}

test("worker runner: recovers the request, waits its delay, then creates with the launch authority and a fresh mint", async () => {
  const h = await harness();
  const out = await h.worker.handle(h.ticket, "request-sig");
  assert.equal(out.kind, "created");
  if (out.kind !== "created") return;
  assert.equal(out.signature, "create-sig");
  assert.equal(out.delayMs, 4_321);
  assert.equal(out.symbol, SYMBOL);
  assert.deepEqual(h.sleeps, [4_321], "the create waits for the delay");
  assert.deepEqual(h.lookups, [], "the caller's request signature skips the lookup");
  assert.deepEqual(h.sent.map((s) => s.name), ["create"]);
  const create = h.sent[0];
  assert.ok(create.signers[0].publicKey.equals(h.launchAuthority.publicKey));
  assert.ok(create.signers[1].publicKey.equals(out.mint), "the outcome's mint is the one that signed");
  const args = coder.instruction.decode(create.ix.data)!.data as { name: string; symbol: string; uri: string };
  assert.deepEqual([args.name, args.symbol, args.uri], [NAME, SYMBOL, URI], "metadata recovered from request_launch");
  const keys = create.ix.keys.map((k) => k.pubkey.toBase58());
  for (const k of [h.ticket, h.payer, h.treasury, pdas.bondingCurve(out.mint), pdas.tickerRegistry(SYMBOL), pdas.nameRegistry(nameHash(NAME))]) {
    assert.ok(keys.includes(k.toBase58()), `create includes ${k.toBase58()}`);
  }
});

test("worker runner: without a hint it finds the request by the ticket's signatures", async () => {
  const h = await harness();
  assert.equal((await h.worker.handle(h.ticket)).kind, "created");
  assert.deepEqual(h.lookups, ["signatures"]);
});

test("worker runner: a ticket whose metadata doesn't match its commitment is refunded at once", async () => {
  const h = await harness({ metadataHash: Buffer.alloc(32) });
  const out = await h.worker.handle(h.ticket, "request-sig");
  assert.deepEqual({ ...out, ticket: undefined }, { kind: "refunded", ticket: undefined, reason: "metadata does not match the ticket commitment", signature: "refund-sig" });
  assert.deepEqual(h.sent.map((s) => s.name), ["refundTicket"]);
  assert.deepEqual(h.sleeps, [], "no delay before a refund");
});

test("worker runner: the metadata check runs unless skipped, and a failure refunds", async () => {
  const h = await harness({ uri: "http://plain.example/meta.json" });
  const out = await h.worker.handle(h.ticket, "request-sig");
  assert.equal(out.kind, "refunded");
  assert.match(out.kind === "refunded" ? out.reason : "", /https/);
});

test("worker runner: closed and paused tickets are left alone", async () => {
  const closed = await harness({ open: false });
  assert.equal((await closed.worker.handle(closed.ticket)).kind, "closed");
  const paused = await harness({ paused: true });
  assert.deepEqual({ ...(await paused.worker.handle(paused.ticket, "request-sig")), ticket: undefined }, { kind: "skipped", ticket: undefined, reason: "wait: program paused" });
  assert.deepEqual([...closed.sent, ...paused.sent], []);
});

test("worker runner: a create that can never succeed is refunded; a transient failure retries with the same mint", async () => {
  const terminal = await harness({ createErrors: ["TickerLocked"] });
  const out = await terminal.worker.handle(terminal.ticket, "request-sig");
  assert.equal(out.kind, "refunded");
  assert.equal(out.kind === "refunded" && out.reason, "TickerLocked");
  assert.deepEqual(terminal.sent.map((s) => s.name), ["create", "refundTicket"]);

  const flaky = await harness({ createErrors: ["rpc:blockhash"] });
  const again = await flaky.worker.handle(flaky.ticket, "request-sig");
  assert.equal(again.kind, "created");
  assert.deepEqual(flaky.sent.map((s) => s.name), ["create", "create"]);
  assert.ok(flaky.sent[0].signers[1].publicKey.equals(flaky.sent[1].signers[1].publicKey), "same mint keypair on retry");
  assert.deepEqual(flaky.sleeps, [4_321, 2_000], "the delay, then a 2 s back-off");
});

test("worker runner: one ticket is handled once at a time, and pollOnce covers every open ticket", async () => {
  const h = await harness();
  const [a, b] = await Promise.all([h.worker.handle(h.ticket, "request-sig"), h.worker.handle(h.ticket, "request-sig")]);
  assert.deepEqual([a.kind, b.kind].sort(), ["created", "skipped"]);
  assert.equal(h.sent.length, 1);
  const p = await harness();
  assert.deepEqual((await p.worker.pollOnce()).map((x) => x.kind), ["created"]);
});

// web3.js and Anchor use Node's Buffer (and read process.env) in the browser.
// Imported first by main.tsx so it runs before any Solana module evaluates.
import { Buffer } from "buffer";

const g = globalThis as unknown as { Buffer?: typeof Buffer; process?: { env: Record<string, string | undefined> } };
g.Buffer ??= Buffer;
g.process ??= { env: {} };

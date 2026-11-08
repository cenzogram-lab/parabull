/**
 * Program events from a transaction's log messages. Anchor's `emit!` writes "Program data: <base64>" while the
 * program is executing; other programs (Raydium CPMM during graduation, for one) write their own "Program data:"
 * lines. So, like Anchor's EventParser, this follows the invoke stack ("Program X invoke [n]" / "Program X success" /
 * "Program X failed") and decodes a data line only when this program is the one running. A failed transaction emits
 * nothing (its logs are dropped by the caller, which checks `meta.err`), and an unknown discriminator is skipped.
 */
import { decodeEvent, type ProgramEvent } from "./borsh";

const INVOKE = /^Program (\S+) invoke \[(\d+)\]$/;
const EXIT = /^Program (\S+) (success|failed.*)$/;
const DATA = /^Program data: (.+)$/;

export function eventsFromLogs(logs: readonly string[], programId: string): ProgramEvent[] {
  const stack: string[] = [];
  const out: ProgramEvent[] = [];
  for (const line of logs) {
    const invoke = INVOKE.exec(line);
    if (invoke) {
      stack.push(invoke[1]);
      continue;
    }
    const exit = EXIT.exec(line);
    if (exit) {
      if (stack[stack.length - 1] === exit[1]) stack.pop();
      continue;
    }
    if (stack[stack.length - 1] !== programId) continue;
    const data = DATA.exec(line);
    if (!data) continue;
    // sol_log_data writes each slice base64 and space-separated; Anchor emits one slice per event.
    for (const chunk of data[1].split(" ")) {
      let bytes: Uint8Array;
      try {
        bytes = Uint8Array.from(Buffer.from(chunk, "base64"));
      } catch {
        continue;
      }
      const ev = decodeEvent(bytes);
      if (ev) out.push(ev);
    }
  }
  return out;
}

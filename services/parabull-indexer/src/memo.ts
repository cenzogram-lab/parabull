/**
 * Memos from a transaction's log messages. The SPL Memo program (v2) logs each memo as
 *   Program MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr invoke [1]
 *   Program log: Memo (len 25): "parabull:ref:AbCdEfGhJkLm"
 *   Program MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr success
 * Only top-level memos count (invoke depth 1, the Memo program itself running): a memo some other program makes in a
 * CPI is that program's, not the signer's. The text is Rust's Debug form of the string; anything that isn't plain
 * (escapes JSON can't read, or a length that doesn't match) is skipped. Logs are all the indexer has from the
 * websocket, and the poller reads the same lines, so both paths see the same memos.
 */
export const MEMO_PROGRAM_ID = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

const INVOKE = /^Program (\S+) invoke \[(\d+)\]$/;
const EXIT = /^Program (\S+) (success|failed.*)$/;
const MEMO = /^Program log: Memo \(len (\d+)\): "(.*)"$/;

export function topLevelMemos(logs: readonly string[]): string[] {
  const stack: string[] = [];
  const out: string[] = [];
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
    if (stack.length !== 1 || stack[0] !== MEMO_PROGRAM_ID) continue;
    const m = MEMO.exec(line);
    if (!m) continue;
    let text: string;
    try {
      text = JSON.parse(`"${m[2]}"`) as string;
    } catch {
      continue;
    }
    if (Buffer.byteLength(text, "utf8") === Number(m[1])) out.push(text);
  }
  return out;
}

/** The log lines the Memo program writes for `text` at the top level (the mock chain's buys use this). */
export function memoLogLines(text: string): string[] {
  return [`Program ${MEMO_PROGRAM_ID} invoke [1]`, `Program log: Memo (len ${Buffer.byteLength(text, "utf8")}): ${JSON.stringify(text)}`, `Program ${MEMO_PROGRAM_ID} consumed 7000 of 200000 compute units`, `Program ${MEMO_PROGRAM_ID} success`];
}

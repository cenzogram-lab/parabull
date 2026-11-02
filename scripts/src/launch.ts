/** Port of state.rs `normalize_ticker` / `normalize_name_hash`. */
import { createHash } from "crypto";

export function canonicalTicker(input: string): string {
  let s = input.trim();
  if (s.startsWith("$")) s = s.slice(1);
  if (!/^[A-Za-z0-9]{1,10}$/.test(s)) throw new Error(`invalid ticker ${input}`);
  return s.toUpperCase();
}

/** sha256 of the name: trimmed, ASCII whitespace runs -> one space, ASCII lowercased. */
export function nameHash(name: string): Buffer {
  const raw = Buffer.from(name.trim(), "utf8");
  if (raw.length === 0 || raw.length > 32) throw new Error("name must be 1-32 bytes");
  const out: number[] = [];
  let prevSpace = false;
  for (const b of raw) {
    const ws = b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0c || b === 0x0d;
    if (ws) {
      if (!prevSpace) out.push(0x20);
      prevSpace = true;
    } else {
      out.push(b >= 0x41 && b <= 0x5a ? b + 32 : b);
      prevSpace = false;
    }
  }
  return createHash("sha256").update(Buffer.from(out)).digest();
}

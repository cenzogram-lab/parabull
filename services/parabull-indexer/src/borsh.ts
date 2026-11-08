/**
 * Borsh, driven by the program's committed IDL (app/src/idl/parabull.json, which CI keeps equal to the program's own
 * IDL build). Accounts and events are decoded field by field from their IDL definitions, so a layout change in the
 * program shows up here without hand-kept offsets. Values come out as:
 *   pubkey → base58 string; u8/u16/u32/i32/bool → number/boolean; u64/i64/u128 → bigint; string → string;
 *   [T; n] of u8 → Uint8Array, other arrays → arrays; Option<T> → T | null; defined structs → objects.
 * The encoder is the exact inverse; the tests and the mock RPC build accounts and events with it.
 */
import idlJson from "../../../app/src/idl/parabull.json";
import { base58Decode } from "../../../app/src/lib/chatMessage";
import { base58Encode } from "../../parabull-edge/src/solana";

type IdlType =
  | string
  | { array: [IdlType, number] }
  | { option: IdlType }
  | { vec: IdlType }
  | { defined: { name: string } };
interface IdlField {
  name: string;
  type: IdlType;
}
interface IdlTypeDef {
  name: string;
  type: { kind: "struct"; fields: IdlField[] } | { kind: "enum"; variants: { name: string }[] };
}
interface Idl {
  address: string;
  accounts: { name: string; discriminator: number[] }[];
  events: { name: string; discriminator: number[] }[];
  types: IdlTypeDef[];
}

export const IDL = idlJson as unknown as Idl;
export const PROGRAM_ID = IDL.address;
const TYPES = new Map(IDL.types.map((t) => [t.name, t]));

export type Decoded = Record<string, unknown>;

export class Reader {
  private view: DataView;
  offset = 0;
  constructor(readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  private need(n: number) {
    if (this.offset + n > this.bytes.length) throw new RangeError(`borsh: read past end (${this.offset}+${n} > ${this.bytes.length})`);
  }
  u8() {
    this.need(1);
    return this.bytes[this.offset++];
  }
  u16() {
    this.need(2);
    const v = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return v;
  }
  u32() {
    this.need(4);
    const v = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return v;
  }
  i32() {
    this.need(4);
    const v = this.view.getInt32(this.offset, true);
    this.offset += 4;
    return v;
  }
  u64() {
    this.need(8);
    const v = this.view.getBigUint64(this.offset, true);
    this.offset += 8;
    return v;
  }
  i64() {
    this.need(8);
    const v = this.view.getBigInt64(this.offset, true);
    this.offset += 8;
    return v;
  }
  u128() {
    const lo = this.u64();
    return (this.u64() << 64n) | lo;
  }
  take(n: number) {
    this.need(n);
    const v = this.bytes.subarray(this.offset, this.offset + n);
    this.offset += n;
    return v;
  }
  pubkey() {
    return base58Encode(this.take(32));
  }
  string() {
    return new TextDecoder("utf-8", { fatal: false }).decode(this.take(this.u32()));
  }
}

export class Writer {
  private parts: number[] = [];
  u8(v: number) {
    this.parts.push(v & 255);
  }
  bytes(b: ArrayLike<number>) {
    for (let i = 0; i < b.length; i++) this.parts.push(b[i]);
  }
  private le(v: bigint, n: number) {
    for (let i = 0; i < n; i++) this.parts.push(Number((v >> BigInt(8 * i)) & 255n));
  }
  u16(v: number) {
    this.le(BigInt(v), 2);
  }
  u32(v: number) {
    this.le(BigInt(v), 4);
  }
  i32(v: number) {
    this.le(BigInt.asUintN(32, BigInt(v)), 4);
  }
  u64(v: bigint) {
    this.le(BigInt.asUintN(64, v), 8);
  }
  i64(v: bigint) {
    this.le(BigInt.asUintN(64, v), 8);
  }
  u128(v: bigint) {
    this.le(BigInt.asUintN(128, v), 16);
  }
  pubkey(v: string) {
    const b = base58Decode(v);
    if (!b || b.length !== 32) throw new Error(`borsh: not a pubkey: ${v}`);
    this.bytes(b);
  }
  string(v: string) {
    const b = new TextEncoder().encode(v);
    this.u32(b.length);
    this.bytes(b);
  }
  finish() {
    return Uint8Array.from(this.parts);
  }
}

function decodeValue(t: IdlType, r: Reader): unknown {
  if (typeof t === "string") {
    switch (t) {
      case "u8":
        return r.u8();
      case "bool":
        return r.u8() !== 0;
      case "u16":
        return r.u16();
      case "u32":
        return r.u32();
      case "i32":
        return r.i32();
      case "u64":
        return r.u64();
      case "i64":
        return r.i64();
      case "u128":
        return r.u128();
      case "pubkey":
        return r.pubkey();
      case "string":
        return r.string();
      case "bytes":
        return r.take(r.u32()).slice();
      default:
        throw new Error(`borsh: unsupported type ${t}`);
    }
  }
  if ("array" in t) {
    const [inner, n] = t.array;
    if (inner === "u8") return r.take(n).slice();
    return Array.from({ length: n }, () => decodeValue(inner, r));
  }
  if ("option" in t) return r.u8() === 0 ? null : decodeValue(t.option, r);
  if ("vec" in t) return Array.from({ length: r.u32() }, () => decodeValue(t.vec, r));
  return decodeDefined(t.defined.name, r);
}

function decodeDefined(name: string, r: Reader): unknown {
  const def = TYPES.get(name);
  if (!def) throw new Error(`borsh: no IDL type ${name}`);
  if (def.type.kind === "enum") {
    const i = r.u8();
    const v = def.type.variants[i];
    if (!v) throw new Error(`borsh: ${name} has no variant ${i}`);
    return v.name;
  }
  const out: Decoded = {};
  for (const f of def.type.fields) out[f.name] = decodeValue(f.type, r);
  return out;
}

function encodeValue(t: IdlType, v: unknown, w: Writer): void {
  if (typeof t === "string") {
    switch (t) {
      case "u8":
        return w.u8(v as number);
      case "bool":
        return w.u8(v ? 1 : 0);
      case "u16":
        return w.u16(v as number);
      case "u32":
        return w.u32(v as number);
      case "i32":
        return w.i32(v as number);
      case "u64":
        return w.u64(BigInt(v as bigint));
      case "i64":
        return w.i64(BigInt(v as bigint));
      case "u128":
        return w.u128(BigInt(v as bigint));
      case "pubkey":
        return w.pubkey(v as string);
      case "string":
        return w.string(v as string);
      case "bytes": {
        const b = v as Uint8Array;
        w.u32(b.length);
        return w.bytes(b);
      }
      default:
        throw new Error(`borsh: unsupported type ${t}`);
    }
  }
  if ("array" in t) {
    const [inner, n] = t.array;
    const items = (v ?? new Uint8Array(n)) as ArrayLike<unknown>;
    if (items.length !== n) throw new Error(`borsh: array of ${n}, got ${items.length}`);
    for (let i = 0; i < n; i++) encodeValue(inner, items[i], w);
    return;
  }
  if ("option" in t) {
    if (v === null || v === undefined) return w.u8(0);
    w.u8(1);
    return encodeValue(t.option, v, w);
  }
  if ("vec" in t) {
    const items = v as unknown[];
    w.u32(items.length);
    for (const x of items) encodeValue(t.vec, x, w);
    return;
  }
  encodeDefined(t.defined.name, v, w);
}

function encodeDefined(name: string, v: unknown, w: Writer): void {
  const def = TYPES.get(name);
  if (!def) throw new Error(`borsh: no IDL type ${name}`);
  if (def.type.kind === "enum") return w.u8(def.type.variants.findIndex((x) => x.name === v));
  const obj = (v ?? {}) as Decoded;
  for (const f of def.type.fields) encodeValue(f.type, obj[f.name], w);
}

const sameBytes = (a: ArrayLike<number>, b: ArrayLike<number>) => a.length === b.length && Array.from(a).every((x, i) => x === b[i]);

/** An account's data, if its 8-byte discriminator is `name`'s. */
export function decodeAccount<T = Decoded>(name: string, data: Uint8Array): T | null {
  const acc = IDL.accounts.find((a) => a.name === name);
  if (!acc) throw new Error(`borsh: no IDL account ${name}`);
  if (data.length < 8 || !sameBytes(data.subarray(0, 8), acc.discriminator)) return null;
  return decodeDefined(name, new Reader(data.subarray(8))) as T;
}

export function encodeAccount(name: string, value: Decoded): Uint8Array {
  const acc = IDL.accounts.find((a) => a.name === name)!;
  const w = new Writer();
  w.bytes(acc.discriminator);
  encodeDefined(name, value, w);
  return w.finish();
}

export interface ProgramEvent {
  name: string;
  data: Decoded;
}

/** An `emit!` payload (discriminator + borsh), as it appears base64-encoded after "Program data: ". */
export function decodeEvent(bytes: Uint8Array): ProgramEvent | null {
  if (bytes.length < 8) return null;
  const ev = IDL.events.find((e) => sameBytes(bytes.subarray(0, 8), e.discriminator));
  if (!ev) return null;
  try {
    return { name: ev.name, data: decodeDefined(ev.name, new Reader(bytes.subarray(8))) as Decoded };
  } catch {
    return null;
  }
}

export function encodeEvent(name: string, value: Decoded): Uint8Array {
  const ev = IDL.events.find((e) => e.name === name);
  if (!ev) throw new Error(`borsh: no IDL event ${name}`);
  const w = new Writer();
  w.bytes(ev.discriminator);
  encodeDefined(name, value, w);
  return w.finish();
}

export const accountDiscriminator = (name: string) => Uint8Array.from(IDL.accounts.find((a) => a.name === name)!.discriminator);

function zero(t: IdlType): unknown {
  if (typeof t === "string") {
    if (t === "pubkey") return "11111111111111111111111111111111";
    if (t === "bool") return false;
    if (t === "string") return "";
    if (t === "bytes") return new Uint8Array(0);
    return t === "u64" || t === "i64" || t === "u128" ? 0n : 0;
  }
  if ("array" in t) return t.array[0] === "u8" ? new Uint8Array(t.array[1]) : Array.from({ length: t.array[1] }, () => zero(t.array[0]));
  if ("option" in t) return null;
  if ("vec" in t) return [];
  return zeroValue(t.defined.name);
}

/** Every field of an IDL struct at its zero value (tests override the ones they care about). */
export function zeroValue(name: string): Decoded {
  const def = TYPES.get(name);
  if (!def || def.type.kind !== "struct") throw new Error(`borsh: no IDL struct ${name}`);
  return Object.fromEntries(def.type.fields.map((f) => [f.name, zero(f.type)]));
}

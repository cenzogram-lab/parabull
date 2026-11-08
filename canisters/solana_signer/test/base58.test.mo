import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Text "mo:core/Text";
import Base58 "../lib/Base58";

// Reference vectors (Bitcoin alphabet), checked against an independent implementation.
assert Base58.encode([]) == "";
assert Base58.encode([0]) == "1";
assert Base58.encode([0, 0, 0x28, 0x7f, 0xb4, 0xcd]) == "11233QC4";
assert Base58.encode("Hello World!".encodeUtf8().toArray()) == "2NEpo7TZRRrLZSi2U";

// Solana addresses: the system program (32 zero bytes) and the SPL Token program.
assert Base58.encode(Array.repeat(0 : Nat8, 32)) == "11111111111111111111111111111111";
assert Base58.encode([
  6, 221, 246, 225, 215, 101, 161, 147, 217, 203, 225, 70, 206, 235, 121, 172,
  28, 180, 133, 237, 95, 91, 55, 145, 58, 140, 245, 133, 126, 255, 0, 169,
]) == "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

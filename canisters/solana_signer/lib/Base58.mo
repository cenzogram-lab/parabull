import Char "mo:core/Char";
import Nat "mo:core/Nat";
import Nat8 "mo:core/Nat8";

/// Base58 with the Bitcoin alphabet, the encoding of Solana addresses.
module {
  let ALPHABET : [Char] = [
    '1', '2', '3', '4', '5', '6', '7', '8', '9', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'J', 'K', 'L', 'M', 'N', 'P',
    'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'm', 'n',
    'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z',
  ];

  /// Each leading zero byte becomes '1'; the rest is the big-endian number in base 58.
  public func encode(bytes : [Nat8]) : Text {
    var zeros = 0;
    var leading = true;
    var n = 0;
    for (b in bytes.values()) {
      if (leading and b == 0) { zeros += 1 } else { leading := false };
      n := n * 256 + b.toNat();
    };
    var out = "";
    while (n > 0) {
      out := ALPHABET[n % 58].toText() # out;
      n := n / 58;
    };
    for (_ in Nat.range(0, zeros)) { out := "1" # out };
    out;
  };
};

import Array "mo:core/Array";
import Principal "mo:core/Principal";
import Request "../lib/Request";

let anonymous = Principal.anonymous();
let user = Principal.fromText("ryjl3-tyaaa-aaaaa-aaaba-cai");

// Anonymous callers and owners are refused.
assert Request.checkCaller(anonymous) != #ok;
assert Request.checkCaller(user) == #ok;
assert Request.checkOwner(anonymous) != #ok;
assert Request.checkOwner(user) == #ok;

// Message size: 1 to 1232 bytes; the expected signer is a 32-byte key.
let key = Array.repeat(7 : Nat8, 32);
assert Request.checkSignRequest(Array.repeat(1 : Nat8, 1).toBlob(), key) == #ok;
assert Request.checkSignRequest(Array.repeat(1 : Nat8, 1232).toBlob(), key) == #ok;
assert Request.checkSignRequest(Array.repeat(1 : Nat8, 0).toBlob(), key) != #ok;
assert Request.checkSignRequest(Array.repeat(1 : Nat8, 1233).toBlob(), key) != #ok;
assert Request.checkSignRequest(Array.repeat(1 : Nat8, 10).toBlob(), Array.repeat(7 : Nat8, 31)) != #ok;
assert Request.checkSignRequest(Array.repeat(1 : Nat8, 10).toBlob(), Array.repeat(7 : Nat8, 33)) != #ok;

// The caller's derived key must be exactly the expected signer.
assert Request.matchesExpected(key.toBlob(), key);
assert not Request.matchesExpected(key.toBlob(), Array.repeat(8 : Nat8, 32));
assert not Request.matchesExpected(Array.repeat(7 : Nat8, 31).toBlob(), key);

// Only the three threshold Ed25519 key names.
assert Request.checkKeyName("key_1") == #ok;
assert Request.checkKeyName("test_key_1") == #ok;
assert Request.checkKeyName("dfx_test_key") == #ok;
assert Request.checkKeyName("key_2") != #ok;
assert Request.checkKeyName("") != #ok;

import Principal "mo:core/Principal";
import RateLimit "../lib/RateLimit";

let alice = Principal.fromText("ryjl3-tyaaa-aaaaa-aaaba-cai");
let bob = Principal.fromText("rrkah-fqaaa-aaaaa-aaaaq-cai");
let dave = Principal.fromText("r7inp-6aaaa-aaaaa-aaabq-cai");

let limits = (2, 3); // per caller, global
let state = RateLimit.new();
let t0 : Int = 1_700_000_000_000_000_000;

// Per caller: two requests a minute.
assert RateLimit.take(state, alice, t0, limits.0, limits.1) == #ok;
assert RateLimit.take(state, alice, t0 + 1, limits.0, limits.1) == #ok;
assert RateLimit.take(state, alice, t0 + 2, limits.0, limits.1) != #ok;

// The refused request counted nothing, so the global window still has room for one more.
assert RateLimit.take(state, bob, t0 + 3, limits.0, limits.1) == #ok;
// Global: three requests a minute from everyone together.
assert RateLimit.take(state, dave, t0 + 4, limits.0, limits.1) != #ok;

// A minute later both windows start over.
let later = t0 + RateLimit.WINDOW_NANOS;
assert RateLimit.take(state, alice, later, limits.0, limits.1) == #ok;
assert RateLimit.take(state, alice, later + 1, limits.0, limits.1) == #ok;
assert RateLimit.take(state, dave, later + 2, limits.0, limits.1) == #ok;
assert RateLimit.take(state, bob, later + 3, limits.0, limits.1) != #ok;

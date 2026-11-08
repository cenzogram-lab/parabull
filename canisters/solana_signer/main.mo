// Chain Fusion Solana signer: each Internet Identity principal gets a Solana address (a threshold Ed25519 public key
// derived from that principal) and can have Solana transactions signed with it, by `sign_with_schnorr`. The canister
// holds no private keys. Composition root: state lives here, the API is in mixins/SignerApi.mo.
import Map "mo:core/Map";
import Types "types";
import RateLimit "lib/RateLimit";
import SignerApi "mixins/SignerApi";

actor {
  /// Each caller's own public key, cached once derived (keys never change for a fixed canister and key name).
  let addresses : Map.Map<Principal, Blob>;
  let settings : Types.Settings;
  /// Request counters; resetting them on an upgrade is harmless.
  transient let limiter = RateLimit.new();

  include SignerApi(addresses, settings, limiter);
};

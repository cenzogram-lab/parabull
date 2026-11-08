import Blob "mo:core/Blob";
import Error "mo:core/Error";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Option "mo:core/Option";
import Principal "mo:core/Principal";
import Result "mo:core/Result";
import Time "mo:core/Time";
import Types "../types";
import Base58 "../lib/Base58";
import Management "../lib/Management";
import RateLimit "../lib/RateLimit";
import Request "../lib/Request";

/// The signer's public API. The interface is fixed by app/src/lib/auth/solana_signer.did, so refusals are rejects
/// (with a reason) rather than Result values; the app shows the reason.
mixin (addresses : Map.Map<Principal, Blob>, settings : Types.Settings, limiter : RateLimit.State) {
  transient let ic : Management.Service = actor "aaaaa-aa";

  func ensure(check : Result.Result<(), Text>) : async* () {
    switch (check) {
      case (#err(reason)) { throw Error.reject(reason) };
      case (#ok) {};
    };
  };

  func countRequest(caller : Principal) : async* () {
    await* ensure(RateLimit.take(limiter, caller, Time.now(), settings.per_caller_per_minute, settings.global_per_minute));
  };

  /// `owner`'s Ed25519 public key under `keyName`: from the cache, or derived by the management canister. Only a
  /// caller's own key is cached, so lookups of other principals can't grow the canister's memory.
  func publicKey(owner : Principal, keyName : Text, remember : Bool) : async* Blob {
    switch (addresses.get(owner)) {
      case (?known) { return known };
      case null {};
    };
    let { public_key } = await ic.schnorr_public_key({
      canister_id = null;
      derivation_path = Management.derivationPath(owner);
      key_id = Management.ed25519Key(keyName);
    });
    if (public_key.size() != Request.ED25519_PUBLIC_KEY_BYTES) {
      throw Error.reject("the management canister returned a " # public_key.size().toText() # "-byte Ed25519 key");
    };
    // The key name can only change while no address is cached, so a key derived before such a change isn't kept.
    if (remember and settings.key_name == keyName) { addresses.add(owner, public_key) };
    public_key;
  };

  /// The Solana address (base58 Ed25519 public key) of `owner`. An update call: deriving a key calls the management
  /// canister, which a query can't do. Cached keys answer without that call, and without counting against the limits.
  public shared ({ caller }) func get_solana_address(owner : Principal) : async Text {
    await* ensure(Request.checkCaller(caller));
    await* ensure(Request.checkOwner(owner));
    let key = switch (addresses.get(owner)) {
      case (?known) { known };
      case null {
        await* countRequest(caller);
        let keyName = settings.key_name;
        let derived = await* publicKey(owner, keyName, owner == caller);
        // A controller may have switched the key while it was being derived (possible only while no address is
        // cached); an address under the old key would never match what signing derives.
        if (settings.key_name != keyName) {
          throw Error.reject("the signer's configuration changed during this request; try again");
        };
        derived;
      };
    };
    Base58.encode(key.toArray());
  };

  /// The cached address of `owner`, if `owner` has used the signer; a fast query for a returning user.
  public query func lookup_solana_address(owner : Principal) : async ?Text {
    addresses.get(owner).map(func key = Base58.encode(key.toArray()));
  };

  /// Signs a serialized Solana transaction message with the caller's key, and only the caller's: the key's derivation
  /// path is the caller's principal. `expectedSigner` is the 32-byte address the client is signing for; the request is
  /// refused unless it is the caller's own, before any signature is requested. Returns the 64-byte Ed25519 signature.
  public shared ({ caller }) func sign_solana_transaction(message : Blob, expectedSigner : [Nat8]) : async Blob {
    await* ensure(Request.checkCaller(caller));
    if (settings.signing_paused) {
      throw Error.reject("signing is paused by the signer's controllers");
    };
    await* ensure(Request.checkSignRequest(message, expectedSigner));
    await* countRequest(caller);
    let keyName = settings.key_name;
    let derived = await* publicKey(caller, keyName, true);
    if (not Request.matchesExpected(derived, expectedSigner)) {
      throw Error.reject("expected signer mismatch: that address isn't the caller's Solana address");
    };
    // Settings may have changed while the key was being derived.
    if (settings.signing_paused or settings.key_name != keyName) {
      throw Error.reject("the signer's configuration changed during this request; try again");
    };
    let { signature } = await (with cycles = Management.SIGN_WITH_SCHNORR_CYCLES) ic.sign_with_schnorr({
      message;
      derivation_path = Management.derivationPath(caller);
      key_id = Management.ed25519Key(keyName);
      aux = null;
    });
    settings.signatures_issued += 1;
    signature;
  };

  /// Controllers only: pause or resume signing, change the limits, or pick the threshold key. The key can change only
  /// while no address exists, since changing it changes every user's Solana address.
  public shared ({ caller }) func configure(update : Types.ConfigUpdate) : async () {
    if (not caller.isController()) {
      throw Error.reject("only the signer's controllers can configure it");
    };
    switch (update.key_name) {
      case (?name) {
        await* ensure(Request.checkKeyName(name));
        if (name != settings.key_name and (addresses.size() > 0 or settings.signatures_issued > 0)) {
          throw Error.reject("the key can't change once addresses exist: every user's Solana address would change");
        };
      };
      case null {};
    };
    // Every check has passed; apply the whole update.
    switch (update.key_name) { case (?name) { settings.key_name := name }; case null {} };
    switch (update.signing_paused) { case (?paused) { settings.signing_paused := paused }; case null {} };
    switch (update.limits) {
      case (?limits) {
        settings.per_caller_per_minute := limits.per_caller_per_minute;
        settings.global_per_minute := limits.global_per_minute;
      };
      case null {};
    };
  };

  public query func status() : async Types.Status {
    {
      key_name = settings.key_name;
      signing_paused = settings.signing_paused;
      limits = {
        per_caller_per_minute = settings.per_caller_per_minute;
        global_per_minute = settings.global_per_minute;
      };
      known_addresses = addresses.size();
      signatures_issued = settings.signatures_issued;
    };
  };
};

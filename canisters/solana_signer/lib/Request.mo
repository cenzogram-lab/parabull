import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Nat "mo:core/Nat";
import Principal "mo:core/Principal";
import Result "mo:core/Result";
import Text "mo:core/Text";

/// Checks on what callers send, before anything reaches the management canister.
module {
  /// A whole Solana transaction, signatures included, fits in one 1232-byte packet; its message can't be longer.
  public let MAX_MESSAGE_BYTES : Nat = 1232;

  public let ED25519_PUBLIC_KEY_BYTES : Nat = 32;

  /// Threshold Ed25519 keys: "key_1" (production), "test_key_1" (mainnet testing), "dfx_test_key" (local).
  public let KEY_NAMES : [Text] = ["key_1", "test_key_1", "dfx_test_key"];

  public func checkCaller(caller : Principal) : Result.Result<(), Text> {
    if (caller.isAnonymous()) {
      #err("anonymous callers can't use the signer; sign in with Internet Identity first");
    } else { #ok };
  };

  public func checkOwner(owner : Principal) : Result.Result<(), Text> {
    if (owner.isAnonymous()) { #err("the anonymous principal has no Solana address") } else { #ok };
  };

  public func checkSignRequest(message : Blob, expectedSigner : [Nat8]) : Result.Result<(), Text> {
    if (message.size() == 0) {
      return #err("the transaction message is empty");
    };
    if (message.size() > MAX_MESSAGE_BYTES) {
      return #err("the transaction message is " # message.size().toText() # " bytes; a Solana transaction message is at most " # MAX_MESSAGE_BYTES.toText());
    };
    if (expectedSigner.size() != ED25519_PUBLIC_KEY_BYTES) {
      return #err("the expected signer is " # expectedSigner.size().toText() # " bytes; a Solana address is a 32-byte public key");
    };
    #ok;
  };

  /// Whether the caller's derived key is the one the client expects to sign as.
  public func matchesExpected(derived : Blob, expectedSigner : [Nat8]) : Bool {
    derived == expectedSigner.toBlob();
  };

  public func checkKeyName(name : Text) : Result.Result<(), Text> {
    if (KEY_NAMES.contains(name)) { #ok } else {
      #err("unknown key name \"" # name # "\"; use key_1, test_key_1 or dfx_test_key");
    };
  };
};

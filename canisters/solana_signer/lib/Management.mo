import Principal "mo:core/Principal";

/// The management canister's threshold Schnorr API (ICP interface spec: schnorr_public_key, sign_with_schnorr).
module {
  public type SchnorrAlgorithm = { #bip340secp256k1; #ed25519 };

  public type SchnorrKeyId = { algorithm : SchnorrAlgorithm; name : Text };

  public type SchnorrAux = { #bip341 : { merkle_root_hash : Blob } };

  public type Service = actor {
    schnorr_public_key : shared ({
      canister_id : ?Principal;
      derivation_path : [Blob];
      key_id : SchnorrKeyId;
    }) -> async { public_key : Blob; chain_code : Blob };
    sign_with_schnorr : shared ({
      message : Blob;
      derivation_path : [Blob];
      key_id : SchnorrKeyId;
      aux : ?SchnorrAux;
    }) -> async { signature : Blob };
  };

  /// The fee for one signature with `key_1` (the most expensive key); the unused part is refunded.
  public let SIGN_WITH_SCHNORR_CYCLES : Nat = 26_153_846_153;

  public func ed25519Key(name : Text) : SchnorrKeyId = { algorithm = #ed25519; name };

  /// The only derivation path the signer uses: the owner's principal, so each principal has its own key.
  public func derivationPath(owner : Principal) : [Blob] = [owner.toBlob()];
};

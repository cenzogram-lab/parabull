module {
  /// The signer's settings, shared by reference with the API mixin (a record, so its writes reach the actor).
  public type Settings = {
    /// Threshold key on the subnet that holds it: "key_1" (mainnet, PocketIC), "test_key_1", "dfx_test_key".
    var key_name : Text;
    var signing_paused : Bool;
    var per_caller_per_minute : Nat;
    var global_per_minute : Nat;
    var signatures_issued : Nat;
  };

  /// Requests that reach the management canister: per caller, and for everyone together (the cycles budget).
  public type Limits = {
    per_caller_per_minute : Nat;
    global_per_minute : Nat;
  };

  /// A controller's change; absent fields stay as they are.
  public type ConfigUpdate = {
    key_name : ?Text;
    signing_paused : ?Bool;
    limits : ?Limits;
  };

  public type Status = {
    key_name : Text;
    signing_paused : Bool;
    limits : Limits;
    known_addresses : Nat;
    signatures_issued : Nat;
  };
};

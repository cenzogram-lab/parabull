import Map "mo:core/Map";

module {
  type OldActor = {};

  type NewActor = {
    addresses : Map.Map<Principal, Blob>;
    settings : {
      var key_name : Text;
      var signing_paused : Bool;
      var per_caller_per_minute : Nat;
      var global_per_minute : Nat;
      var signatures_issued : Nat;
    };
  };

  public func migration(_old : OldActor) : NewActor {
    {
      addresses = Map.empty();
      settings = {
        // The production key (mainnet fiduciary and II subnets, and PocketIC). Controllers can switch to
        // "test_key_1" or "dfx_test_key" while no address exists yet.
        var key_name = "key_1";
        var signing_paused = false;
        var per_caller_per_minute = 10;
        // Each signature costs about 26B cycles; this caps the spend at about 0.8T cycles a minute.
        var global_per_minute = 30;
        var signatures_issued = 0;
      };
    };
  };
};

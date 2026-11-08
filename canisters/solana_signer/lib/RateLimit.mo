import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Principal "mo:core/Principal";
import Result "mo:core/Result";

/// Fixed one-minute windows per caller, plus one for everyone together. Any principal can sign for its own key, and
/// new principals cost nothing to make, so the global window is what bounds the cycles the signer can be made to spend.
module {
  public let WINDOW_NANOS : Int = 60_000_000_000;

  /// Bound on tracked callers. Past it the per-caller windows start over; the global window still holds.
  let MAX_TRACKED : Nat = 10_000;

  public type Window = { var start : Int; var count : Nat };

  public type State = { perCaller : Map.Map<Principal, Window>; global : Window };

  public func new() : State = { perCaller = Map.empty(); global = { var start = 0; var count = 0 } };

  /// Counts one request by `caller` at `now`. A refused request counts nothing.
  public func take(state : State, caller : Principal, now : Int, perCallerLimit : Nat, globalLimit : Nat) : Result.Result<(), Text> {
    roll(state.global, now);
    if (state.global.count >= globalLimit) {
      return #err("the signer is at its limit of " # globalLimit.toText() # " requests a minute; try again shortly");
    };
    let w = switch (state.perCaller.get(caller)) {
      case (?known) { known };
      case null {
        if (state.perCaller.size() >= MAX_TRACKED) { state.perCaller.clear() };
        let fresh : Window = { var start = now; var count = 0 };
        state.perCaller.add(caller, fresh);
        fresh;
      };
    };
    roll(w, now);
    if (w.count >= perCallerLimit) {
      return #err("rate limit: at most " # perCallerLimit.toText() # " requests a minute per caller; try again shortly");
    };
    w.count += 1;
    state.global.count += 1;
    #ok;
  };

  func roll(w : Window, now : Int) {
    if (now - w.start >= WINDOW_NANOS) {
      w.start := now;
      w.count := 0;
    };
  };
};

/** Candid interface of the Chain Fusion signer canister (solana_signer.did), for agent-js actors. */
import type { IDL as CandidIDL } from "@icp-sdk/core/candid";

export const idlFactory = ({ IDL }: { IDL: typeof CandidIDL }) =>
  IDL.Service({
    // Update calls: both reach the management canister (schnorr_public_key / sign_with_schnorr).
    get_solana_address: IDL.Func([IDL.Principal], [IDL.Text], []),
    sign_solana_transaction: IDL.Func([IDL.Vec(IDL.Nat8), IDL.Vec(IDL.Nat8)], [IDL.Vec(IDL.Nat8)], []),
  });

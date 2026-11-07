/**
 * Which Internet Identity path (Path A) this build offers:
 * - `canister`: real II sign-in, Solana signatures from the threshold-Ed25519 signer canister (VITE_II_SIGNER_CANISTER_ID).
 * - `mock-signer`: real II sign-in, but no canister configured, so a development key derived from the principal signs.
 *   Demo builds and the dev server only.
 * - `offline`: no II at all (a localnet build, fully offline): a random per-tab principal and the development key.
 * - `off`: a production chain build without a signer canister: the option is shown but disabled.
 */
export type IiMode = { kind: "canister"; canisterId: string } | { kind: "mock-signer" } | { kind: "offline" } | { kind: "off"; reason: string };

export interface IiEnv {
  canisterId?: string;
  isDemo: boolean;
  cluster: string;
  dev: boolean;
}

/** Textual canister/principal IDs: base32 groups of 5 separated by dashes, ending in a shorter group. */
const PRINCIPAL_TEXT = /^[a-z2-7]{5}(-[a-z2-7]{5})*(-[a-z2-7]{1,5})?$/;

export function resolveIiMode(env: IiEnv): IiMode {
  const id = env.canisterId?.trim();
  if (id) return PRINCIPAL_TEXT.test(id) ? { kind: "canister", canisterId: id } : { kind: "off", reason: `VITE_II_SIGNER_CANISTER_ID isn't a canister ID: ${id}` };
  if (env.cluster === "localnet" && !env.isDemo) return { kind: "offline" };
  if (env.isDemo || env.dev) return { kind: "mock-signer" };
  return { kind: "off", reason: "Sign-in with Internet Identity needs the Solana signer canister (VITE_II_SIGNER_CANISTER_ID)" };
}

/** Production II: the frontend canister's /authorize page (the internet-identity skill; `https://id.ai` alone never returns a delegation). */
export const II_AUTHORIZE_URL = "https://id.ai/authorize";
export const II_CANISTER_ID = "rdmx6-jaaaa-aaaaa-aaadq-cai";

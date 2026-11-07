/**
 * Path A, Internet Identity sign-in (skills.internetcomputer.org `internet-identity` skill: @icp-sdk/auth 11 with
 * @icp-sdk/core 6). This module and the SDK load only when someone picks Path A, so the main bundle doesn't carry them.
 *
 * - One AuthClient for the page, mainnet II by default (`https://id.ai`), no `identityProvider` override.
 * - `signIn()` must be called synchronously in the click handler or Safari blocks the popup, so the client is created
 *   ahead of time (`prepare`) and `beginSignIn` calls it directly.
 * - Canister calls use an HttpAgent with no `host` and the root key from the `ic_env` cookie when the app is served by
 *   a canister; never `fetchRootKey()`.
 */
import { AuthClient } from "@icp-sdk/auth/client";
import { Actor, HttpAgent } from "@icp-sdk/core/agent";
import { safeGetCanisterEnv } from "@icp-sdk/core/agent/canister-env";
import { Principal } from "@icp-sdk/core/principal";
import { canisterSigner, mockSigner, type SolanaSigner, type SolanaSignerActor } from "./chainFusionSigner";
import type { IiMode } from "./iiConfig";
import { idlFactory } from "./solanaSignerIdl";

let client: AuthClient | null = null;

/** Create the client ahead of the click, so `beginSignIn` can open the popup synchronously. */
export function prepare(): AuthClient {
  client ??= new AuthClient();
  return client;
}

/** Opens Internet Identity. Call directly from the click handler; the promise rejects if the user closes the popup. */
export function beginSignIn(): Promise<unknown> {
  return prepare().signIn();
}

/** The signed-in principal, if a session is held (restored silently after a reload). */
export function currentPrincipal(): Principal | null {
  const c = prepare();
  if (!c.isAuthenticated()) return null;
  const p = c.getPrincipal();
  return p && !p.isAnonymous() ? p : null;
}

/** Ends the session at II (every tab of this origin is signed out). */
export async function signOut(): Promise<void> {
  if (client) await client.signOut();
}

const OFFLINE_KEY = "parabull:ii-offline-principal";

/** Offline mode: a random self-authenticating principal for this tab (no II available, e.g. a localnet build). */
export function offlinePrincipal(): Principal {
  try {
    const saved = sessionStorage.getItem(OFFLINE_KEY);
    if (saved) return Principal.fromText(saved);
  } catch {
    // sessionStorage unavailable: a fresh principal each time.
  }
  const p = Principal.selfAuthenticating(crypto.getRandomValues(new Uint8Array(32)));
  try {
    sessionStorage.setItem(OFFLINE_KEY, p.toText());
  } catch {
    // ignore
  }
  return p;
}

export function clearOffline() {
  try {
    sessionStorage.removeItem(OFFLINE_KEY);
  } catch {
    // ignore
  }
}

/** The Solana signer for a signed-in principal, per the build's mode. */
export async function signerFor(mode: IiMode, principal: Principal): Promise<SolanaSigner> {
  if (mode.kind === "canister") {
    const identity = await prepare().getIdentity();
    const agent = await HttpAgent.create({ identity, rootKey: safeGetCanisterEnv()?.IC_ROOT_KEY });
    const actor = Actor.createActor<SolanaSignerActor>(idlFactory as never, { agent, canisterId: mode.canisterId });
    return canisterSigner(principal, actor);
  }
  return mockSigner(principal.toText());
}

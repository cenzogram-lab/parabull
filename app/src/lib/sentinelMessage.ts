/**
 * The X sentinel's per-coin settings and the message a creator signs to change them. Shared, byte for byte, by the
 * app and services/twitter-sentinel (which imports this file), so both sides build the same text to sign and verify.
 * Pure: no imports, no browser or Node APIs.
 */

export const SENTINEL_TONES = [
  { value: "bull", label: "Wall St. Bull", hint: "Loud, confident, all caps on the big moments" },
  { value: "wojak", label: "Satirical Wojak", hint: "Self-aware, ironic, meme-literate" },
  { value: "macro", label: "Institutional Macro", hint: "Measured, data-first, no hype words" },
] as const;

export type SentinelTone = (typeof SENTINEL_TONES)[number]["value"];

export type SentinelMilestone = "p25" | "p50" | "p75" | "graduation";

export const SENTINEL_MILESTONES: readonly { key: SentinelMilestone; label: string }[] = [
  { key: "p25", label: "25% of the curve" },
  { key: "p50", label: "50% of the curve" },
  { key: "p75", label: "75% of the curve" },
  { key: "graduation", label: "Raydium graduation" },
];

export const CONTEXT_MAX = 1000;

export interface SentinelSettings {
  milestones: Record<SentinelMilestone, boolean>;
  /** Reply to posts that mention the project's account and include $TICKER. */
  cashtagReplies: boolean;
  tone: SentinelTone;
  /** What the creator wants the agent to know: news, roadmap, links. Plain text. */
  context: string;
}

export const DEFAULT_SETTINGS: SentinelSettings = {
  milestones: { p25: true, p50: true, p75: true, graduation: true },
  cashtagReplies: false,
  tone: "bull",
  context: "",
};

/** Validates untrusted input and returns settings in canonical form, or an error message. */
export function normalizeSettings(input: unknown): { ok: true; value: SentinelSettings } | { ok: false; error: string } {
  if (!input || typeof input !== "object") return { ok: false, error: "settings must be an object" };
  const s = input as Record<string, unknown>;
  const m = s.milestones as Record<string, unknown> | undefined;
  if (!m || typeof m !== "object") return { ok: false, error: "milestones must be an object" };
  const milestones = {} as Record<SentinelMilestone, boolean>;
  for (const { key } of SENTINEL_MILESTONES) {
    if (typeof m[key] !== "boolean") return { ok: false, error: `milestones.${key} must be true or false` };
    milestones[key] = m[key] as boolean;
  }
  if (typeof s.cashtagReplies !== "boolean") return { ok: false, error: "cashtagReplies must be true or false" };
  if (!SENTINEL_TONES.some((t) => t.value === s.tone)) return { ok: false, error: "tone is not one of the personas" };
  if (typeof s.context !== "string") return { ok: false, error: "context must be text" };
  // Control characters (other than line breaks) are dropped; the text is trimmed.
  const context = s.context.replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, "").trim();
  if (context.length > CONTEXT_MAX) return { ok: false, error: `context is longer than ${CONTEXT_MAX} characters` };
  return { ok: true, value: { milestones, cashtagReplies: s.cashtagReplies, tone: s.tone as SentinelTone, context } };
}

/** Fixed key order, so the same settings always hash the same. */
export function canonicalSettingsJson(s: SentinelSettings): string {
  return JSON.stringify({
    milestones: { p25: s.milestones.p25, p50: s.milestones.p50, p75: s.milestones.p75, graduation: s.milestones.graduation },
    cashtagReplies: s.cashtagReplies,
    tone: s.tone,
    context: s.context,
  });
}

/**
 * An X web session the creator links for their coin: the account's handle and the `auth_token` and `ct0` cookies of
 * a signed-in browser. Sent once over HTTPS; the sentinel seals it at rest and never returns it.
 */
export interface XSession {
  username: string;
  authToken: string;
  ct0: string;
}

/** Validates an untrusted session (the handle may start with @), or returns an error message. */
export function normalizeSession(input: unknown): { ok: true; value: XSession } | { ok: false; error: string } {
  if (!input || typeof input !== "object") return { ok: false, error: "the X session must be an object" };
  const s = input as Record<string, unknown>;
  const username = typeof s.username === "string" ? s.username.trim().replace(/^@/, "") : "";
  const authToken = typeof s.authToken === "string" ? s.authToken.trim() : "";
  const ct0 = typeof s.ct0 === "string" ? s.ct0.trim() : "";
  if (!/^[A-Za-z0-9_]{1,15}$/.test(username)) return { ok: false, error: "the X handle is 1-15 letters, digits or underscores" };
  // X's cookies are long hex strings; anything else is a copy-paste mistake.
  if (!/^[A-Za-z0-9]{20,400}$/.test(authToken)) return { ok: false, error: "auth_token doesn't look like an X session cookie" };
  if (!/^[A-Za-z0-9]{20,400}$/.test(ct0)) return { ok: false, error: "ct0 doesn't look like an X session cookie" };
  return { ok: true, value: { username, authToken, ct0 } };
}

export type SentinelAction = "update settings" | "disconnect";

/**
 * What the signature covers, in a fixed order: the settings and the session being linked (null when unchanged).
 * A disconnect signs `{"settings":null,"session":null}`.
 */
export function signedPayloadJson(settings: SentinelSettings | null, session: XSession | null): string {
  const s = settings ? JSON.parse(canonicalSettingsJson(settings)) : null;
  return JSON.stringify({ settings: s, session: session ? { username: session.username, authToken: session.authToken, ct0: session.ct0 } : null });
}

/**
 * The text the creator's wallet signs (Solana signMessage). `digestHex` is SHA-256 of signedPayloadJson, so the
 * wallet shows the action and a fingerprint, never the cookies themselves.
 */
export function sentinelMessage(action: SentinelAction, mint: string, issuedAt: string, digestHex: string): string {
  return ["Parabull X sentinel", `Action: ${action}`, `Mint: ${mint}`, `Issued: ${issuedAt}`, `Payload SHA-256: ${digestHex}`].join("\n");
}

/** What PUT /api/sentinel/:mint/settings takes. `session` links or replaces the X session; omit it to keep the current one. `signature` is base64. */
export interface SignedSettings {
  settings: SentinelSettings;
  session?: XSession | null;
  issuedAt: string;
  signer: string;
  signature: string;
}

/** What DELETE /api/sentinel/:mint/settings takes. */
export interface SignedDisconnect {
  issuedAt: string;
  signer: string;
  signature: string;
}

/** What GET /api/sentinel/:mint/settings returns. It never includes session cookies. */
export interface SentinelStatus {
  mint: string;
  /** "dry-run": posts are logged, not sent. */
  mode: "live" | "dry-run";
  /** The X account the service posts as for this coin: linked by the creator, or set up by the operator. Null when none. */
  account: { username: string; source: "creator" | "operator"; linkedAt: string | null } | null;
  /** The sentinel is watching this coin (it has saved settings). */
  active: boolean;
  settings: SentinelSettings | null;
  updatedAt: string | null;
}

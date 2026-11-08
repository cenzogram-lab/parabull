/**
 * Metadata upload for `request_launch`. The URI is committed on-chain (with
 * name and symbol) at request time, so it must exist before the ticket is paid.
 * A backend at VITE_METADATA_UPLOAD_URL pins the image and JSON (IPFS/Arweave)
 * and returns { uri }.
 */
import { byteLength } from "./launchRules";

export interface MetadataInput {
  name: string;
  symbol: string;
  description: string;
  image: File;
  website?: string;
  x?: string;
  telegram?: string;
}

const ALLOWED = /^(https:\/\/|ipfs:\/\/|ar:\/\/)/i;

/** The launch worker refuses larger images (scripts/src/launchWorker.ts checkMetadataUri), and so does parabull-edge. */
export const MAX_IMAGE_BYTES = 5_000_000;

export function checkUri(uri: string): string | null {
  if (!ALLOWED.test(uri)) return "Metadata URI must start with https://, ipfs:// or ar://";
  if (byteLength(uri) > 200) return "Metadata URI is at most 200 bytes";
  return null;
}

export async function uploadMetadata(endpoint: string, m: MetadataInput): Promise<string> {
  const form = new FormData();
  form.append("image", m.image);
  form.append("metadata", JSON.stringify({ name: m.name, symbol: m.symbol, description: m.description, website: m.website, twitter: m.x, telegram: m.telegram }));
  const res = await fetch(endpoint, { method: "POST", body: form });
  if (!res.ok) throw new Error(`Metadata upload failed (${res.status})`);
  const { uri } = (await res.json()) as { uri?: string };
  const err = uri ? checkUri(uri) : "Upload response had no uri";
  if (err) throw new Error(err);
  return uri!;
}

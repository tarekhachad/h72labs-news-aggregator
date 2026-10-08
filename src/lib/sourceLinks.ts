/**
 * Proof that a card's source link was written by this server.
 *
 * The full report fetches a card's source pages server-side, and a card's
 * `sources` reach the database through `persist_generated_cards`, which any
 * signed-in user can call directly with whatever links they like. So the
 * server signs every link it writes, and fetches only links whose signature
 * checks out: a link a user stored by hand cannot carry a valid one without
 * the server-only secret. Rendering is unaffected (links are allow-listed
 * where they are shown); this guards only what the server itself fetches.
 *
 * The signature is HMAC-SHA256 over a fixed label and the exact URL, as
 * base64url.
 */

import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { bestEffortLog } from "@/lib/bestEffortLog";

/** 32 bytes of entropy as base64 is 44 characters; anything shorter is refused. */
const MIN_SECRET_LENGTH = 32;

/** Keeps a signature for this purpose from ever matching an HMAC made for another. */
const LABEL = "pna-source-link-v1";

let warnedMissing = false;

/**
 * The signing secret, or null when it is missing or too short. Null means no
 * link can be signed or verified, so the full report fetches no pages and is
 * written from the stored snippets, as for a card whose pages all refused.
 */
export function sourceLinkSecret(): string | null {
  const secret = process.env.SOURCE_LINK_SECRET;
  if (!secret || secret.length < MIN_SECRET_LENGTH) {
    if (!warnedMissing) {
      warnedMissing = true;
      bestEffortLog("warn", "[sourceLinks] SOURCE_LINK_SECRET is missing or too short; source pages will not be fetched");
    }
    return null;
  }
  return secret;
}

export function signSourceLink(url: string, secret: string): string {
  return createHmac("sha256", secret).update(`${LABEL}\n${url}`).digest("base64url");
}

/** True only for a signature this server made for exactly this URL. */
export function verifySourceLink(url: string, sig: unknown, secret: string): boolean {
  if (typeof sig !== "string" || sig.length === 0) return false;
  const expected = Buffer.from(signSourceLink(url, secret));
  const given = Buffer.from(sig);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

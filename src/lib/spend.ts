/**
 * Spend caps: reserve a worst-case amount before any Claude call, settle it
 * to the real figure afterwards.
 *
 * The enforcement is NOT here. It is `public.reserve_spend` and
 * `public.settle_spend` in supabase/schema.sql, which decide the amount and
 * every limit under one lock in a table no session can touch. This file only
 * calls them and turns their answers into responses.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import {
  spendRefusalMessage,
  type SpendKind,
  type SpendRefusalBody,
  type SpendRefusalReason,
} from "@/lib/spendMessage";

export type Reservation = {
  id: string;
  /** Never logged, never sent to a browser. */
  token: string;
  reservedUsd: number;
};

export type ReserveResult =
  | { status: "ok"; reservation: Reservation }
  | { status: "refused"; reason: SpendRefusalReason; availableAt: string | null }
  | { status: "error" };

const RESERVE_TIMEOUT_MS = 10_000;
const SETTLE_TIMEOUT_MS = 5_000;

const Granted = z.object({
  ok: z.literal(true),
  reservation_id: z.string().uuid(),
  settle_token: z.string().min(1),
  reserved_usd: z.number().positive(),
});

const Refused = z.object({
  ok: z.literal(false),
  reason: z.enum(["disabled", "user_count", "too_large", "user_budget", "global_budget"]),
  available_at: z.string().nullable(),
});

class Timeout extends Error {}

function withTimeout<T>(promise: PromiseLike<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    Promise.resolve(promise),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Timeout(`timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Asks the database for permission to spend. Anything other than a clean
 * grant — an RPC error, a timeout, a response of the wrong shape — is
 * `error`, and the caller must not run.
 *
 * `supabase` must be the signed-in user's client: reserve_spend reads the
 * user from the session.
 *
 * A timeout does not cancel the database call. If it commits anyway, the
 * grant arrives after the caller has given up, and nothing would ever settle
 * it: a full reservation would count against the user for 24 hours with no
 * run behind it. So a grant that arrives late is settled at $0. `keepAlive`
 * receives that cleanup so a route can hand it to Next's `after()`, which
 * keeps a serverless function running after its response until it finishes.
 */
export async function reserveSpend(
  supabase: SupabaseClient,
  kind: SpendKind,
  options: { topicCount?: number; ref?: string; keepAlive?: (task: Promise<void>) => void } = {}
): Promise<ReserveResult> {
  let call: Promise<{ data: unknown; error: { message: string } | null }> | undefined;
  try {
    call = Promise.resolve(
      supabase.rpc("reserve_spend", {
        p_kind: kind,
        p_topic_count: options.topicCount ?? null,
        p_ref: options.ref ?? null,
      })
    );
    const { data, error } = await withTimeout(call, RESERVE_TIMEOUT_MS);
    if (error) {
      console.error(`[spend] reserve_spend failed: ${error.message}`);
      return { status: "error" };
    }
    const granted = Granted.safeParse(data);
    if (granted.success) {
      return {
        status: "ok",
        reservation: {
          id: granted.data.reservation_id,
          token: granted.data.settle_token,
          reservedUsd: granted.data.reserved_usd,
        },
      };
    }
    const refused = Refused.safeParse(data);
    if (refused.success) {
      const at = refused.data.available_at;
      return {
        status: "refused",
        reason: refused.data.reason,
        availableAt: at !== null && Number.isFinite(new Date(at).getTime()) ? new Date(at).toISOString() : null,
      };
    }
    // Deliberately not logging `data`: a malformed grant could still carry a token.
    console.error("[spend] reserve_spend returned an unexpected shape");
    return { status: "error" };
  } catch (err) {
    console.error(`[spend] reserve_spend threw: ${err instanceof Error ? err.message : "unknown error"}`);
    if (err instanceof Timeout && call !== undefined) {
      const cleanup = settleLateGrant(call);
      try {
        options.keepAlive?.(cleanup);
      } catch (keepAliveErr) {
        console.error(
          `[spend] could not schedule late-grant cleanup: ${keepAliveErr instanceof Error ? keepAliveErr.message : "unknown error"}`
        );
      }
    }
    return { status: "error" };
  }
}

async function settleLateGrant(
  call: Promise<{ data: unknown; error: { message: string } | null }>
): Promise<void> {
  try {
    const { data } = await call;
    const granted = Granted.safeParse(data);
    if (!granted.success) return;
    console.error(`[spend] releasing reservation ${granted.data.reservation_id}, granted after the timeout`);
    await settleSpend(
      {
        id: granted.data.reservation_id,
        token: granted.data.settle_token,
        reservedUsd: granted.data.reserved_usd,
      },
      0
    );
  } catch {
    // The call failed after all: there is no reservation to release.
  }
}

/**
 * What a finished run settles to, or null to keep the full reservation.
 *
 * A floor record means some calls went unpriced, so its total is a lower
 * bound: the reservation stands unless the known figure already exceeds it.
 * No record at all (building it threw) keeps the reservation too.
 */
export function settleAmount(
  reservedUsd: number,
  record: { totalBilledUsd: number; isFloor: boolean } | null
): number | null {
  if (record === null) return null;
  const total = record.totalBilledUsd;
  if (!Number.isFinite(total) || total < 0) return null;
  return record.isFloor ? Math.max(total, reservedUsd) : total;
}

/**
 * The client settle_spend is called through: publishable key, no session.
 * The settle token is the credential, so a user session that expired during
 * a long run cannot block the settle and strand the worst-case amount.
 */
function settleClient(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

/**
 * Settles a reservation to `amountUsd`, or leaves it at its full amount when
 * `amountUsd` is null. Never throws and never waits longer than
 * SETTLE_TIMEOUT_MS, because it runs in the same `finally` that releases the
 * generation claim. Returns whether the ledger row was settled.
 */
export async function settleSpend(reservation: Reservation, amountUsd: number | null): Promise<boolean> {
  if (amountUsd === null) {
    console.error(`[spend] keeping the full reservation ${reservation.id} (no trustworthy total)`);
    return false;
  }
  try {
    const client = settleClient();
    if (client === null) {
      console.error("[spend] cannot settle: Supabase URL or publishable key is not set");
      return false;
    }
    const { data, error } = await withTimeout(
      client.rpc("settle_spend", {
        p_id: reservation.id,
        p_token: reservation.token,
        p_actual_usd: amountUsd,
      }),
      SETTLE_TIMEOUT_MS
    );
    if (error) {
      console.error(`[spend] settle_spend failed for ${reservation.id}: ${error.message}`);
      return false;
    }
    if (data !== true) {
      console.error(`[spend] settle_spend did not settle ${reservation.id}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(
      `[spend] settle_spend threw for ${reservation.id}: ${err instanceof Error ? err.message : "unknown error"}`
    );
    return false;
  }
}

/** 503 when generation is switched off or the check itself failed; 429 for every limit. */
export function spendRefusalResponse(
  kind: SpendKind,
  result: Exclude<ReserveResult, { status: "ok" }>
): Response {
  const reason = result.status === "refused" ? result.reason : "error";
  const body: SpendRefusalBody = {
    reason,
    message: spendRefusalMessage(kind, reason),
    availableAt: result.status === "refused" ? result.availableAt : null,
  };
  const status = reason === "disabled" || reason === "error" ? 503 : 429;
  return Response.json(body, { status });
}

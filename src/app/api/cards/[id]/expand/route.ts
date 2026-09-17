import { z } from "zod";
import { after } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { generateExpandedReport } from "@/lib/cards";
import type { Card, Topic } from "@/types";
import { createUsageCollector, withUsageCollector } from "@/lib/usageCollector";
import { buildUsageRunRecord, type UsageRunRecord } from "@/lib/usageRecord";
import { defaultUsageSinks, emitUsageRun } from "@/lib/usageSinks";
import { reserveSpend, settleAmount, settleSpend, spendRefusalResponse } from "@/lib/spend";

const CardId = z.string().uuid();

// generateExpandedReport is a Claude call — same runtime/timeout reasoning
// as /api/digest.
export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  const parsedId = CardId.safeParse(id);
  if (!parsedId.success) return new Response("Invalid card id", { status: 400 });

  // `cards` has no direct user_id column — its "select own cards" RLS
  // policy already scopes this to rows reachable via the caller's own
  // digests, so a card that exists but belongs to someone else returns
  // nothing here, identical to a card that doesn't exist at all.
  const { data: card, error } = await supabase
    .from("cards")
    .select("id, topic, short_summary, expanded_report, sources")
    .eq("id", id)
    .maybeSingle();

  if (error) return new Response("Something went wrong", { status: 500 });
  if (!card) return new Response("Card not found", { status: 404 });

  // Already generated once — cached read, no Claude call. Checked against
  // null rather than falsiness: generateExpandedReport falls back to ""
  // when Claude's structured output has no report field, and a truthy test
  // would treat that persisted "" as "never generated" and pay for another
  // Sonnet call on every single expand of that card, forever. The client
  // (NewsCard's generate guard, FocusOverlay's render branch) already
  // treats "" as generated; this keeps the server's half of that contract.
  if (card.expanded_report !== null && card.expanded_report !== undefined) {
    return Response.json({ expandedReport: card.expanded_report });
  }

  // Reserved only on a cache miss, so a cached read never counts against a
  // limit.
  const reserved = await reserveSpend(supabase, "expand", {
    ref: id,
    keepAlive: (task) => after(task),
  });
  if (reserved.status !== "ok") return spendRefusalResponse("expand", reserved);
  const { reservation } = reserved;

  // Only reached on a genuine cache miss, so exactly one Sonnet call is
  // expected here. Reported in a finally so the 502 path below still says
  // what it spent — a failed generation is billed the same as a successful
  // one, and it's the case most likely to go unnoticed.
  const usage = createUsageCollector();
  let generated = false;
  let expandedReport: string;
  try {
    expandedReport = await withUsageCollector(usage, () =>
      generateExpandedReport({
        topic: card.topic as Topic,
        shortSummary: card.short_summary,
        sources: card.sources as Card["sources"],
      })
    );
    generated = true;
  } catch (err) {
    console.error("[cards/expand] generateExpandedReport failed:", err);
    return new Response("Couldn't generate the full report — try again.", { status: 502 });
  } finally {
    // Labelled by what actually happened, matching the digest route: a
    // failed generation is billed exactly like a successful one, and a line
    // reading "complete" for a run that returned a 502 would misattribute
    // that spend to anyone grepping these logs. `report` swallows its own
    // failures, so this can't affect the response either way.
    const label = generated ? "expand complete" : "expand failed";
    usage.report({ label, expectedCalls: { expand: 1 } });

    // The durable counterpart to the line above. Unlike the digest route
    // there is no generation mutex here to strand, so ordering carries less
    // weight — but it is kept the same way round regardless, so both routes
    // read alike and neither becomes the odd one that a later edit "fixes"
    // in the wrong direction.
    //
    // Every digest-shaped field is null, and that is the honest value rather
    // than a placeholder: an expand has no articles, no clusters and no
    // ranking pass, so 0 would assert a measurement that was never taken.
    // runShape is "unknown" for the same reason — an expand has no
    // first-of-day/top-up dimension at all — which is why reports must segment by route before
    // they segment by shape, or these rows would pool with digests whose
    // shape genuinely could not be determined.
    //
    // Note what this does NOT cover: a cache hit returns long before this
    // point, so a free read writes no row, exactly as it prints no line.
    //
    // This IS awaited before the response goes out, unlike the digest route
    // where the emit lands after the stream's last event. So an uncached
    // expand pays the sink's latency — a Supabase insert, bounded at 2s by
    // emitUsageRun. Accepted rather than fired-and-forgotten because on a
    // serverless platform an unawaited promise can be frozen the moment the
    // response is returned, which would drop the record silently on exactly
    // the runs that cost money. If that latency ever matters, Next's
    // `after()` is the right tool and not a try/catch.
    let record: UsageRunRecord | null = null;
    try {
      record = buildUsageRunRecord(
        usage.summarize(),
        {
          userId: user.id,
          route: "expand",
          digestId: null,
          cardId: id,
          outcome: generated ? "complete" : "endedEarly",
          label,
          runShape: "unknown",
          topicCount: null,
          sourceCount: null,
          articleCount: null,
          clusterCount: null,
          clustersAfterDedup: null,
          notableCount: null,
          cardsDroppedByCap: null,
          cardsWritten: null,
          cardsFailed: null,
          rankApplied: null,
          expectedCalls: { expand: 1 },
        },
        usage.at,
        crypto.randomUUID()
      );
    } catch (err) {
      console.error("[cards/expand] failed to build this run's cost record:", err);
    }

    // Settled before the record is written, the same order as the digest
    // route. Never throws, and bounded by its own timeout.
    await settleSpend(reservation, settleAmount(reservation.reservedUsd, record));
    if (record !== null) {
      try {
        await emitUsageRun(defaultUsageSinks(supabase), record);
      } catch (err) {
        console.error("[cards/expand] failed to write this run's cost record:", err);
      }
    }
  }

  // Conditioned on still being null: the read-then-generate above isn't
  // atomic, so two near-simultaneous requests for the same card (the
  // client already guards against this, but belt-and-suspenders) could
  // both reach this point, each having generated its own report. Without
  // this condition, whichever write lands second would silently overwrite
  // the first — this way the first write wins and stays authoritative,
  // instead of the cached text flapping between two valid-but-different
  // generations depending on request timing.
  const { error: updateError } = await supabase
    .from("cards")
    .update({ expanded_report: expandedReport })
    .eq("id", id)
    .is("expanded_report", null);

  if (updateError) {
    // The user asked to read the report and got it — a failed cache write
    // shouldn't turn that into an error response. The next expand just
    // regenerates it instead of reading a cached value.
    console.error("[cards/expand] failed to persist expanded report:", updateError);
  }

  return Response.json({ expandedReport });
}

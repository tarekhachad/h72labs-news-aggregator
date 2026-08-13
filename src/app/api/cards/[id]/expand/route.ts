import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { generateExpandedReport } from "@/lib/cards";
import type { Card, Topic } from "@/types";
import { createUsageCollector, withUsageCollector } from "@/lib/usageCollector";

const CardId = z.string().uuid();

// generateExpandedReport is a Claude call — same runtime/timeout reasoning
// as /api/digest.
export const runtime = "nodejs";
export const maxDuration = 60;

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
    usage.report({
      label: generated ? "expand complete" : "expand failed",
      expectedCalls: { expand: 1 },
    });
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

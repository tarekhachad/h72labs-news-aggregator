import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { inviteState, loadInviteRequests } from "@/lib/adminRequests";
import { getUserTimeZone } from "@/lib/profile";
import { isValidTimeZone } from "@/lib/localDate";
import { RequestCard } from "./RequestCard";

export default async function AdminRequestsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const list = await loadInviteRequests(supabase);
  // A 404, not a refusal: the page does not admit to existing for a reader
  // who is not an admin. The database function is the real gate.
  if (list.kind === "not_admin") notFound();

  const now = new Date();
  // The server runs in UTC; times read in the admin's own zone.
  const timeZone = await getUserTimeZone(supabase, user.id);
  const received = new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: isValidTimeZone(timeZone) ? timeZone : "UTC",
  });
  const pending = list.kind === "ok" ? list.rows.filter((r) => r.status === "pending").length : 0;

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-8 px-6 py-16">
      <div className="text-center">
        <h1 className="text-2xl font-semibold">Invite requests</h1>
        <p className="mt-2 text-sm" style={{ color: "var(--color-muted-foreground)" }}>
          {list.kind === "ok" ? `${pending} pending. Pending first, then newest first.` : "Couldn't load the requests. Reload to try again."}
        </p>
      </div>

      {list.kind === "ok" && list.rows.length === 0 && (
        <p className="text-center text-sm" style={{ color: "var(--color-muted-foreground)" }}>
          No requests yet.
        </p>
      )}

      {list.kind === "ok" &&
        list.rows.map((row) => (
          <RequestCard
            key={row.id}
            row={row}
            inviteNote={inviteState(row, now)}
            // Formatted on the server, so the client renders the same text and hydration matches.
            receivedAt={received.format(new Date(row.created_at))}
          />
        ))}
    </main>
  );
}

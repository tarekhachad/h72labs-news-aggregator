import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { listDigestDatesForUser } from "@/lib/digests";

function formatDate(date: string): string {
  // `date` is a plain "YYYY-MM-DD" string (Postgres `date` column) — append
  // a UTC time so it parses as that calendar day regardless of the
  // browser/server's own timezone, not the day before/after.
  return new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export default async function HistoryPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // The proxy (middleware) already gates unauthenticated requests before
  // they reach here — this is defense-in-depth, not the primary check.
  if (!user) {
    redirect("/login");
  }

  const dates = await listDigestDatesForUser(supabase, user.id);

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-8 px-6 py-16">
      <div className="text-center">
        <h1 className="text-2xl font-semibold">History</h1>
        <p className="mt-2 text-sm" style={{ color: "var(--color-muted-foreground)" }}>
          Past days you&apos;ve gotten a briefing.
        </p>
      </div>

      {dates.length === 0 ? (
        <p className="text-center text-sm" style={{ color: "var(--color-muted-foreground)" }}>
          No past digests yet.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {dates.map((d) => (
            <li key={d.date}>
              <Link
                href={`/history/${d.date}`}
                className="flex items-center justify-between rounded-xl px-4 py-3 text-sm transition-opacity hover:opacity-80"
                style={{
                  border: "1px solid var(--color-border)",
                  background: "var(--color-card)",
                }}
              >
                <span className="font-medium">{formatDate(d.date)}</span>
                <span className="text-xs" style={{ color: "var(--color-muted-foreground)" }}>
                  {d.cardCount} card{d.cardCount === 1 ? "" : "s"}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

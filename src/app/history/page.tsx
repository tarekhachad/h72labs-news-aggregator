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
    <div className="min-h-screen bg-zinc-50 dark:bg-black">
      <main className="mx-auto flex max-w-2xl flex-col gap-8 px-6 py-16">
        <Link
          href="/"
          className="text-xs font-medium text-zinc-500 underline hover:text-zinc-800 dark:hover:text-zinc-200"
        >
          ← Back
        </Link>

        <div className="text-center">
          <h1 className="text-2xl font-semibold text-black dark:text-zinc-50">History</h1>
          <p className="mt-2 text-sm text-zinc-500">Past days you&apos;ve gotten a briefing.</p>
        </div>

        {dates.length === 0 ? (
          <p className="text-center text-sm text-zinc-500">No past digests yet.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {dates.map((d) => (
              <li key={d.date}>
                <Link
                  href={`/history/${d.date}`}
                  className="flex items-center justify-between rounded-xl border border-zinc-200 bg-white px-4 py-3 text-sm transition-colors hover:bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-950 dark:hover:bg-zinc-900"
                >
                  <span className="font-medium text-zinc-800 dark:text-zinc-200">
                    {formatDate(d.date)}
                  </span>
                  <span className="text-xs text-zinc-500">
                    {d.cardCount} card{d.cardCount === 1 ? "" : "s"}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}

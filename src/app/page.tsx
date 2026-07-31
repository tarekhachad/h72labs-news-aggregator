import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getUserProfile } from "@/lib/profile";
import { getTodayDigest } from "@/lib/digests";
import { signOutAction } from "@/app/auth/actions";
import { Feed } from "./Feed";

export default async function Home() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // The proxy (middleware) already gates unauthenticated requests before
  // they reach here — this is defense-in-depth, not the primary check.
  if (!user) {
    redirect("/login");
  }

  const { topics, preferredSources } = await getUserProfile(supabase, user.id);

  // Gate on both — a profile with topics but zero preferred sources would
  // otherwise pass this check and then silently produce an empty digest
  // forever (ingestArticles filters strictly by preferred source).
  if (topics.length === 0 || preferredSources.length === 0) {
    redirect("/onboarding");
  }

  const digest = await getTodayDigest(supabase, user.id);

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-black">
      <div className="mx-auto flex max-w-2xl items-center justify-end gap-4 px-6 pt-6">
        <Link
          href="/history"
          className="text-xs font-medium text-zinc-500 underline hover:text-zinc-800 dark:hover:text-zinc-200"
        >
          History
        </Link>
        <Link
          href="/saved"
          className="text-xs font-medium text-zinc-500 underline hover:text-zinc-800 dark:hover:text-zinc-200"
        >
          Saved
        </Link>
        <Link
          href="/profile"
          className="text-xs font-medium text-zinc-500 underline hover:text-zinc-800 dark:hover:text-zinc-200"
        >
          Settings
        </Link>
        <form action={signOutAction}>
          <button
            type="submit"
            className="cursor-pointer text-xs font-medium text-zinc-500 underline hover:text-zinc-800 dark:hover:text-zinc-200"
          >
            Sign out
          </button>
        </form>
      </div>
      <Feed initialDigest={digest} userTopics={topics} />
    </div>
  );
}

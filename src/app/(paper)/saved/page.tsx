import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getSavedCards } from "@/lib/bookmarks";
import { SavedList } from "./SavedList";

export default async function SavedPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // The proxy (middleware) already gates unauthenticated requests before
  // they reach here — this is defense-in-depth, not the primary check.
  if (!user) {
    redirect("/login");
  }

  const savedCards = await getSavedCards(supabase, user.id);

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-8 px-6 py-16">
      <div className="text-center">
        <h1 className="text-2xl font-semibold">Saved</h1>
        <p className="mt-2 text-sm" style={{ color: "var(--color-muted-foreground)" }}>
          Cards you&apos;ve bookmarked.
        </p>
      </div>

      <SavedList initialCards={savedCards} />
    </main>
  );
}

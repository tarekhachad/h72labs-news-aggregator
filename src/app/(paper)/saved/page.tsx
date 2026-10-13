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
    <main className="flex flex-col">
      <div className="px-6 py-6 md:px-10">
        <h1 className="font-heading text-3xl font-bold">Saved</h1>
        <p className="mt-1 text-sm" style={{ color: "var(--color-muted-foreground)" }}>
          Stories you&apos;ve saved, newest first.
        </p>
      </div>

      <SavedList initialCards={savedCards} />
    </main>
  );
}

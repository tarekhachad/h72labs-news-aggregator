import { notFound } from "next/navigation";
import { Masthead } from "@/components/newspaper/Masthead";
import { PageTransitionProvider } from "@/components/newspaper/PageTransitionContext";
import { PageTransition } from "@/components/newspaper/PageTransition";
import { PageTransitionInertBoundary } from "@/components/newspaper/PageTransitionInertBoundary";
import { DigestGenerationProvider } from "@/components/newspaper/DigestGenerationContext";
import { FrontPage } from "@/components/newspaper/FrontPage";
import { TopicPage } from "@/components/newspaper/TopicPage";
import { PreferencesForm } from "@/components/PreferencesForm";
import type { Topic } from "@/types";
import { FIXTURE_CARDS, FIXTURE_TOPICS } from "./fixtureCards";

/** The dead database address `npm run dev:fixtures` sets; see package.json. */
const FIXTURE_SUPABASE_URL = "http://127.0.0.1:9";

/**
 * Development only: the real newspaper components with sample cards, so UI
 * work can be seen and screenshotted without signing in to an account or
 * reaching the database. Start it with `npm run dev:fixtures`, which blanks
 * every production key so nothing on the page can reach the database or the
 * Claude API even by accident, and open /dev/fixtures?view=front (or empty,
 * topic, prefs). Outside `next dev` it does not exist.
 */
export default async function DevFixturesPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  if (process.env.NODE_ENV !== "development") notFound();
  // Only under `npm run dev:fixtures`: with the real keys loaded, the page's
  // Generate button would start a real, paid run for a signed-in reader.
  if (process.env.SUPABASE_URL !== FIXTURE_SUPABASE_URL) notFound();
  const { view = "front" } = await searchParams;

  async function noSave() {
    "use server";
  }

  let content: React.ReactNode;
  if (view === "empty") {
    content = <FrontPage initialDigest={null} userTopics={FIXTURE_TOPICS} timeZone="UTC" />;
  } else if (view === "topic") {
    content = (
      <TopicPage
        cards={FIXTURE_CARDS.filter((c) => c.topic === "Tech/AI")}
        topic={"Tech/AI" as Topic}
        userTopics={FIXTURE_TOPICS}
      />
    );
  } else if (view === "prefs") {
    content = (
      <div className="mx-auto max-w-2xl px-6 py-10">
        <PreferencesForm
          action={noSave}
          submitLabel="Save"
          defaultTopics={["Geopolitics", "Tech/AI", "Football"] as Topic[]}
          defaultCountries={["France", "Morocco"]}
        />
      </div>
    );
  } else {
    const today = new Date().toISOString().slice(0, 10);
    content = (
      <FrontPage
        initialDigest={{ id: "fixture-digest", date: today, lastGeneratedAt: "2026-10-08T07:12:00.000Z", cards: FIXTURE_CARDS }}
        userTopics={FIXTURE_TOPICS}
        timeZone="UTC"
      />
    );
  }

  return (
    <PageTransitionProvider>
      <PageTransitionInertBoundary masthead={<Masthead />}>
        <DigestGenerationProvider>{content}</DigestGenerationProvider>
      </PageTransitionInertBoundary>
      <PageTransition />
    </PageTransitionProvider>
  );
}

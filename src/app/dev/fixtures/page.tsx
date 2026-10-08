import { notFound } from "next/navigation";
import { Masthead } from "@/components/newspaper/Masthead";
import { PageTransitionProvider } from "@/components/newspaper/PageTransitionContext";
import { PageTransition } from "@/components/newspaper/PageTransition";
import { PageTransitionInertBoundary } from "@/components/newspaper/PageTransitionInertBoundary";
import { DigestGenerationProvider } from "@/components/newspaper/DigestGenerationContext";
import { FrontPage } from "@/components/newspaper/FrontPage";
import { TopicPage } from "@/components/newspaper/TopicPage";
import { PreferencesForm } from "@/components/PreferencesForm";
import { TOPICS, type Topic } from "@/types";
import { FIXTURE_CARDS, FIXTURE_TOPICS } from "./fixtureCards";
import { ScriptedDigestStream } from "./ScriptedDigestStream";

/** The dead database address `npm run dev:fixtures` sets; see package.json. */
const FIXTURE_SUPABASE_URL = "http://127.0.0.1:9";

/**
 * Development only: the real newspaper components with sample cards, so UI
 * work can be seen and screenshotted without signing in to an account or
 * reaching the database. Start it with `npm run dev:fixtures`, which blanks
 * every production key so nothing on the page can reach the database or the
 * Claude API even by accident, and open /dev/fixtures?view=front (or empty,
 * topic, prefs). Outside `next dev` it does not exist.
 *
 * The edition loaders: view=loader-empty (an empty day, first edition) and
 * view=loader-complete (a day with cards) answer the button with a scripted
 * stream instead of a run. `hold=<stage>` stops it at that stage, `step=<ms>`
 * sets its pace, and `topics=all` gives every topic, so the topic bar wraps.
 */
export default async function DevFixturesPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; hold?: string; step?: string; topics?: string }>;
}) {
  if (process.env.NODE_ENV !== "development") notFound();
  // Only under `npm run dev:fixtures`: with the real keys loaded, the page's
  // Generate button would start a real, paid run for a signed-in reader.
  if (process.env.SUPABASE_URL !== FIXTURE_SUPABASE_URL) notFound();
  const { view = "front", hold, step, topics } = await searchParams;
  const userTopics = topics === "all" ? [...TOPICS] : FIXTURE_TOPICS;
  const stepMs = step && Number.isFinite(Number(step)) ? Math.max(100, Number(step)) : undefined;
  const today = new Date().toISOString().slice(0, 10);

  async function noSave() {
    "use server";
  }

  let content: React.ReactNode;
  if (view === "empty") {
    content = <FrontPage initialDigest={null} userTopics={userTopics} timeZone="UTC" firstEdition />;
  } else if (view === "loader-empty") {
    content = (
      <>
        <ScriptedDigestStream doneCards={FIXTURE_CARDS} stepMs={stepMs} hold={hold} />
        <FrontPage initialDigest={null} userTopics={userTopics} timeZone="UTC" firstEdition />
      </>
    );
  } else if (view === "loader-complete") {
    content = (
      <>
        <ScriptedDigestStream
          doneCards={FIXTURE_CARDS.filter((c) => c.id === "f-t1" || c.id === "f-t2")}
          stepMs={stepMs}
          hold={hold}
        />
        <FrontPage
          initialDigest={{ id: "fixture-digest", date: today, lastGeneratedAt: "2026-10-08T07:12:00.000Z", cards: FIXTURE_CARDS }}
          userTopics={userTopics}
          timeZone="UTC"
        />
      </>
    );
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
    content = (
      <FrontPage
        initialDigest={{ id: "fixture-digest", date: today, lastGeneratedAt: "2026-10-08T07:12:00.000Z", cards: FIXTURE_CARDS }}
        userTopics={userTopics}
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

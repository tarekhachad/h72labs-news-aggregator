import { Masthead } from "@/components/newspaper/Masthead";
import { PageTransitionProvider } from "@/components/newspaper/PageTransitionContext";
import { PageTransition } from "@/components/newspaper/PageTransition";
import { PageTransitionInertBoundary } from "@/components/newspaper/PageTransitionInertBoundary";
import { DigestGenerationProvider } from "@/components/newspaper/DigestGenerationContext";
import { createClient } from "@/lib/supabase/server";
import { loadPendingRequestCount } from "@/lib/adminRequests";

/** Never rejects: a failed lookup hides the admin link, nothing more. */
async function pendingInviteRequests(): Promise<number | null> {
  try {
    return await loadPendingRequestCount(await createClient());
  } catch {
    return null;
  }
}

/**
 * Shared shell for every newspaper page (front page, topic pages, dated
 * history pages) — hosts the masthead (title + sidebar hamburger), the
 * page-flip transition (B8), and digest-generation progress (Phase 7.2),
 * all of which need to persist across the actual route change rather than
 * being scoped to one page — Next.js remounts {children} on every
 * navigation between siblings under this layout. Page-specific navigation
 * (TopicNav, rendered by FrontPage/TopicPage with or without an
 * activeTopic) is rendered by each page itself, not here, since it differs
 * per route and a shared layout has no per-child slot for it.
 */
export default function PaperLayout({ children }: { children: React.ReactNode }) {
  // Not awaited: the sidebar resolves it inside a Suspense boundary, so no
  // page waits on the admin badge, and for every reader but Tarek it is null.
  const pendingRequests = pendingInviteRequests();
  return (
    <PageTransitionProvider>
      <PageTransitionInertBoundary masthead={<Masthead pendingRequests={pendingRequests} />}>
        <DigestGenerationProvider>{children}</DigestGenerationProvider>
      </PageTransitionInertBoundary>
      <PageTransition />
    </PageTransitionProvider>
  );
}

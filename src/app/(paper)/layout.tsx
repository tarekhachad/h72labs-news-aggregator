import { Masthead } from "@/components/newspaper/Masthead";
import { PageTransitionProvider } from "@/components/newspaper/PageTransitionContext";
import { PageTransition } from "@/components/newspaper/PageTransition";
import { PageTransitionInertBoundary } from "@/components/newspaper/PageTransitionInertBoundary";
import { DigestGenerationProvider } from "@/components/newspaper/DigestGenerationContext";

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
  return (
    <PageTransitionProvider>
      <PageTransitionInertBoundary>
        <Masthead />
        <DigestGenerationProvider>{children}</DigestGenerationProvider>
      </PageTransitionInertBoundary>
      <PageTransition />
    </PageTransitionProvider>
  );
}

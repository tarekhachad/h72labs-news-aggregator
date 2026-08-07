import { Masthead } from "@/components/newspaper/Masthead";
import { PageTransitionProvider } from "@/components/newspaper/PageTransitionContext";
import { PageTransition } from "@/components/newspaper/PageTransition";
import { PageTransitionInertBoundary } from "@/components/newspaper/PageTransitionInertBoundary";

/**
 * Shared shell for every newspaper page (front page, topic pages, dated
 * history pages) — hosts the masthead (title + sidebar hamburger) and the
 * page-flip transition (B8), which needs to persist across the actual
 * route change it's animating rather than being scoped to one page. Page-
 * specific navigation (TopicNav, rendered by FrontPage/TopicPage with or
 * without an activeTopic) is rendered by each page itself, not here, since
 * it differs per route and a shared layout has no per-child slot for it.
 */
export default function PaperLayout({ children }: { children: React.ReactNode }) {
  return (
    <PageTransitionProvider>
      <PageTransitionInertBoundary>
        <Masthead />
        {children}
      </PageTransitionInertBoundary>
      <PageTransition />
    </PageTransitionProvider>
  );
}

"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { Sidebar } from "@/components/newspaper/Sidebar";
import { usePageTransitionActions } from "@/components/newspaper/PageTransitionContext";

/**
 * Back arrow's target, derived from the route — always "one level up" the
 * actual navigation path a user took to get there, not a blanket "always
 * home" like the masthead title: a topic page nested under a history date
 * goes up to that date's front page (basePath, same convention TopicNav's
 * own "Front Page" entry already uses); a history date's own front page
 * goes up to the History list (/history) it was picked from, not today's
 * edition; today's topic pages and non-newspaper pages (/saved, /profile,
 * etc.) go to today's front page ("/"). Returns null (hidden) on "/"
 * itself, already home.
 */
function getBackTarget(pathname: string): string | null {
  if (pathname === "/") return null;
  const historyTopicMatch = pathname.match(/^(\/history\/[^/]+)\/topic\/[^/]+$/);
  if (historyTopicMatch) return historyTopicMatch[1];
  if (/^\/history\/[^/]+$/.test(pathname)) return "/history";
  return "/";
}

/**
 * "Your Daily Brief" nameplate, per docs/(C) UI_DESIGN.md's core metaphor.
 * The title links back to the front page from any topic page, triggering
 * the page-flip transition (B8) — always a single flip to "/" regardless
 * of how many topics deep the user is (per B5's design: the masthead is a
 * global "home" action, not scoped to the user's topic list the way
 * TopicNav's "Front Page" entry is date/context-scoped), so this needs
 * no topics/basePath data to do the right thing. The hamburger (Sidebar)
 * is present on every page.
 */
export function Masthead() {
  const { navigate } = usePageTransitionActions();
  const pathname = usePathname();
  const backTarget = getBackTarget(pathname);

  function handleTitleClick(e: React.MouseEvent) {
    // Let a modified click (open in new tab, etc.) behave like a normal
    // link — only intercept a plain left click to run the flip.
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    navigate("/");
  }

  function handleBackClick(e: React.MouseEvent) {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    if (!backTarget) return;
    e.preventDefault();
    navigate(backTarget);
  }

  return (
    <header
      // Three equal-width columns, not flex+justify-between: the title
      // needs to stay centered on the header as a whole regardless of
      // whether the left group is just the hamburger or hamburger+arrow
      // (a varying-width left group can't be balanced by a fixed-width
      // spacer on the right the way the old two-item layout did). With
      // three 1fr columns, the middle column is always the header's exact
      // center, independent of what either side contains.
      className="grid grid-cols-3 items-center border-b px-6 py-4 md:px-10"
      style={{ borderColor: "var(--color-rule)" }}
    >
      <div className="flex items-center justify-self-start">
        <Sidebar />
        {backTarget && (
          <Link
            href={backTarget}
            onClick={handleBackClick}
            aria-label="Back"
            className="flex size-9 items-center justify-center rounded-md hover:bg-[var(--color-muted)]"
          >
            <ArrowLeft className="size-4" />
          </Link>
        )}
      </div>
      <Link
        href="/"
        onClick={handleTitleClick}
        className="justify-self-center font-heading text-3xl font-bold tracking-tight md:text-4xl"
      >
        Your Daily Brief
      </Link>
    </header>
  );
}

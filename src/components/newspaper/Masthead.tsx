"use client";

import Link from "next/link";
import { Sidebar } from "@/components/newspaper/Sidebar";
import { usePageTransitionActions } from "@/components/newspaper/PageTransitionContext";

/**
 * "Your Daily Brief" nameplate, per docs/(C) UI_DESIGN.md's core metaphor.
 * The title links back to the front page from any topic page, triggering
 * the page-flip transition (B8) — always a single flip to "/" regardless
 * of how many topics deep the user is (per B5's design: the masthead is a
 * global "home" action, not scoped to the user's topic list the way
 * TopicNavBox's "Front Page" entry is date/context-scoped), so this needs
 * no topics/basePath data to do the right thing. The hamburger (Sidebar)
 * is present on every page.
 */
export function Masthead() {
  const { navigate } = usePageTransitionActions();

  function handleClick(e: React.MouseEvent) {
    // Let a modified click (open in new tab, etc.) behave like a normal
    // link — only intercept a plain left click to run the flip.
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    navigate("/");
  }

  return (
    <header
      className="flex items-center justify-between border-b px-6 py-4 md:px-10"
      style={{ borderColor: "var(--color-rule)" }}
    >
      <Sidebar />
      <Link
        href="/"
        onClick={handleClick}
        className="font-heading text-3xl font-bold tracking-tight md:text-4xl"
      >
        Your Daily Brief
      </Link>
      {/* Balances the hamburger's width so the title stays visually centered. */}
      <div className="size-9" aria-hidden />
    </header>
  );
}

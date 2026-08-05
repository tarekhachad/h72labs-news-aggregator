import Link from "next/link";
import { Sidebar } from "@/components/newspaper/Sidebar";

/**
 * "Your Daily Brief" nameplate, per docs/(C) UI_DESIGN.md's core metaphor.
 * The title links back to the front page from any topic page — in B5 this
 * is a plain navigation; B8 intercepts it to trigger the page-flip
 * transition instead. The hamburger (Sidebar) is present on every page.
 */
export function Masthead() {
  return (
    <header
      className="flex items-center justify-between border-b px-6 py-4 md:px-10"
      style={{ borderColor: "var(--color-rule)" }}
    >
      <Sidebar />
      <Link href="/" className="font-heading text-3xl font-bold tracking-tight md:text-4xl">
        Your Daily Brief
      </Link>
      {/* Balances the hamburger's width so the title stays visually centered. */}
      <div className="size-9" aria-hidden />
    </header>
  );
}

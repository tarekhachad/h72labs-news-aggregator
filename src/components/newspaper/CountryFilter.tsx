import Link from "next/link";
import { countryToSlug } from "@/config/countries";

/**
 * The Countries page's filter: "All", then one plain link per country among
 * the cards being shown, each setting `?country=<slug>` on the same page.
 * The current choice is marked with aria-current.
 */
export function CountryFilter({
  countries,
  activeSlug,
  pageHref,
}: {
  /** Distinct country names, in display order. */
  countries: readonly string[];
  /** The slug being filtered by, or null for all. */
  activeSlug: string | null;
  /** This topic page's path, without a query string. */
  pageHref: string;
}) {
  const entries = [
    { label: "All", slug: null as string | null },
    ...countries.map((country) => ({ label: country, slug: countryToSlug(country) })),
  ];

  return (
    <nav aria-label="Filter by country" className="flex flex-wrap gap-x-4 gap-y-2 px-6 pb-6 md:px-10">
      {entries.map(({ label, slug }) => {
        const current = slug === activeSlug;
        return (
          <Link
            key={label}
            href={slug === null ? pageHref : `${pageHref}?country=${encodeURIComponent(slug)}`}
            aria-current={current ? "page" : undefined}
            className={current ? "text-sm font-semibold underline underline-offset-4" : "text-sm hover:underline"}
            style={{ color: current ? "var(--color-foreground)" : "var(--color-muted-foreground)" }}
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}

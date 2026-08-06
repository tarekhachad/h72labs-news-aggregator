/**
 * Shared 6-column grid used by both the front page and every topic page.
 * Each child's position is computed explicitly by packGrid.ts and applied
 * as an inline `gridColumn`/`gridRow` style by the caller (FrontPage.tsx /
 * TopicPage.tsx via NewsCard's `gridPosition` prop) — CSS `grid-auto-flow:
 * dense` was tried first but doesn't work here: it bin-packs gaps by
 * reordering later items into exact-fit holes, but never resizes an item to
 * close a gap nothing fits exactly, which reliably left some rows not
 * filling the full page width (see packGrid.ts's doc comment for the exact
 * mechanism). `dense` is kept as a defensive fallback only, for the case
 * where a child has no explicit position (shouldn't happen — every card
 * passed to PageGrid should have a corresponding packGrid entry).
 */
export function PageGrid({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="grid grid-cols-6 auto-rows-[180px] gap-5"
      style={{ gridAutoFlow: "dense" }}
    >
      {children}
    </div>
  );
}

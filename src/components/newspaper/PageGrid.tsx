/**
 * Shared 6-column `grid-auto-flow: dense` grid used by both the front page
 * and every topic page. `dense` auto-placement bin-packs gaps for free —
 * chosen over template-areas (breaks on topic pages' unbounded, variable
 * card counts) or a masonry library (unnecessary machinery when the browser
 * already does this). Ordering comes entirely from DOM order (children
 * should already be sorted by the caller); `dense` just fills gaps within
 * that order, it doesn't reorder the underlying reading order.
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

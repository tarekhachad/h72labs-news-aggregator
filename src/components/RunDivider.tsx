import { formatRelativeTime } from "@/lib/time";

/**
 * Marks the boundary between two same-day generation runs within a topic's
 * card list (digests are additive — a later "Complete today's news" run
 * appends to, not replaces, the current one). Deliberately isolated into
 * its own tiny component so a later visual-design pass can restyle or
 * animate this one place without touching Feed.tsx's list logic at all.
 */
export function RunDivider({ generatedAt }: { generatedAt: string }) {
  return (
    <div className="flex items-center gap-3 py-1" role="separator">
      <div className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />
      <span className="whitespace-nowrap text-[11px] font-medium uppercase tracking-wide text-zinc-400">
        Earlier update · {formatRelativeTime(generatedAt)}
      </span>
      <div className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />
    </div>
  );
}

"use client";

import type { Source, Topic } from "@/types";
import { TOPIC_GROUPS } from "@/config/topicGroups";
import { MAX_READING_UNITS } from "@/lib/readingUnits";
import { picksPhrase, unitsOf } from "@/components/onboarding/picks";

/**
 * "Your edition will read…": the picks the save will send, each line with an
 * Edit link back to its step. Topics are grouped as the grid groups them.
 */
export function ReviewStep({
  topics,
  countries,
  sources,
  onEdit,
}: {
  topics: readonly Topic[];
  countries: readonly string[];
  sources: readonly Source[];
  onEdit: (step: number) => void;
}) {
  const picked = new Set(topics);
  const groups = TOPIC_GROUPS.map((group) => ({
    name: group.name,
    topics: group.topics.filter((topic) => picked.has(topic)),
  })).filter((group) => group.topics.length > 0);

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm tabular-nums" data-testid="review-units">
        {`${picksPhrase(topics.length, countries.length)} · ${unitsOf(topics, countries)} of ${MAX_READING_UNITS}`}
      </p>
      <dl className="flex flex-col">
        <ReviewRow label="Topics" step={0} onEdit={onEdit}>
          {groups.length === 0 ? (
            <span style={{ color: "var(--color-muted-foreground)" }}>None yet</span>
          ) : (
            <ul className="flex flex-col gap-1">
              {groups.map((group) => (
                <li key={group.name}>
                  <span className="font-semibold [font-variant-caps:small-caps]">{group.name}:</span>{" "}
                  {group.topics.join(", ")}
                </li>
              ))}
            </ul>
          )}
        </ReviewRow>
        <ReviewRow label="Countries" step={1} onEdit={onEdit}>
          {countries.length === 0 ? (
            <span style={{ color: "var(--color-muted-foreground)" }}>None</span>
          ) : (
            countries.join(", ")
          )}
        </ReviewRow>
        <ReviewRow label="Outlets" step={2} onEdit={onEdit}>
          {sources.length === 0 ? "Every outlet for your topics" : sources.join(", ")}
        </ReviewRow>
      </dl>
    </div>
  );
}

function ReviewRow({
  label,
  step,
  onEdit,
  children,
}: {
  label: string;
  step: number;
  onEdit: (step: number) => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className="grid grid-cols-[7rem_1fr_auto] items-baseline gap-4 border-t py-3 text-sm"
      style={{ borderColor: "var(--color-border)" }}
    >
      <dt className="font-semibold [font-variant-caps:small-caps]">{label}</dt>
      <dd>{children}</dd>
      <dd>
        <button
          type="button"
          onClick={() => onEdit(step)}
          className="cursor-pointer rounded-[2px] underline underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]"
        >
          Edit<span className="sr-only">{` ${label.toLowerCase()}`}</span>
        </button>
      </dd>
    </div>
  );
}

"use client";

import { useId, useState } from "react";
import { Search } from "lucide-react";
import type { Topic } from "@/types";
import { TOPIC_GROUPS } from "@/config/topicGroups";
import { TOPIC_DESCRIPTIONS } from "@/config/topicDescriptions";
import { counterText } from "@/components/ui/multi-select";

/** Lower case with accents dropped, so "elysee" finds "Élysée". */
function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}

function matches(topic: Topic, terms: string[]): boolean {
  if (terms.length === 0) return true;
  const haystack = fold(`${topic} ${TOPIC_DESCRIPTIONS[topic as keyof typeof TOPIC_DESCRIPTIONS] ?? ""}`);
  return terms.every((term) => haystack.includes(term));
}

/**
 * Every pickable topic as a toggle chip under the catalog's six groups, with
 * a search box that filters the grid in place (names and descriptions).
 *
 * Controlled: the picks live in the parent's React state and submit as one
 * hidden <input name={name}> each, so formData.getAll(name) reads them and
 * React's reset of the form after an action leaves them alone (a hidden
 * input's value is its attribute). The chips are buttons with aria-pressed
 * rather than checkboxes for the same reason: a checkbox's checked state is
 * DOM state that the reset would put back to its default.
 *
 * `countOf` counts the picks against the shared limit (topics plus the
 * countries picked elsewhere). At `max`, unpicked chips are aria-disabled
 * rather than disabled, so they stay focusable and are described by the
 * counter's reason.
 */
export function TopicGrid({
  id,
  name,
  value,
  onChange,
  countOf,
  min,
  max,
  noun,
  stickyCounter = false,
}: {
  id: string;
  name: string;
  value: readonly Topic[];
  onChange: (next: Topic[]) => void;
  countOf: (picked: readonly Topic[]) => number;
  min: number;
  max: number;
  /** Plural noun for the over-limit notice, e.g. "topics and countries". */
  noun: string;
  /**
   * Pin the label and counter to the top of the viewport while the grid
   * scrolls, so the limit's reason stays in sight. Only where nothing else is
   * pinned there: /profile's masthead is.
   */
  stickyCounter?: boolean;
}) {
  const [query, setQuery] = useState("");
  const uid = useId();

  const count = countOf(value);
  const atMax = count >= max;
  const overMax = count > max;
  const picked = new Set(value);

  const labelId = `${id}-label`;
  const hintId = `${id}-hint`;
  const counterId = `${id}-count`;
  const searchId = `${id}-search`;

  const terms = fold(query).split(/\s+/).filter(Boolean);
  const groups = TOPIC_GROUPS.map((group) => ({
    ...group,
    shown: group.topics.filter((topic) => matches(topic, terms)),
  })).filter((group) => group.shown.length > 0);
  const shownCount = groups.reduce((total, group) => total + group.shown.length, 0);

  // The one place the limit is enforced for a chip: removing is always
  // allowed, adding only while under the limit.
  function toggle(topic: Topic) {
    if (picked.has(topic)) {
      onChange(value.filter((t) => t !== topic));
    } else {
      if (atMax || countOf([...value, topic]) > max) return;
      onChange([...value, topic]);
    }
  }

  // Enter in the search box never submits the form or moves the steps on.
  function holdEnter(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") event.preventDefault();
  }

  return (
    <div className="flex flex-col gap-3">
      <div
        className={`flex items-baseline justify-between gap-4 ${
          stickyCounter ? "sticky top-0 z-10 -mx-1 border-b px-1 py-2" : ""
        }`}
        style={stickyCounter ? { background: "var(--color-background)", borderColor: "var(--color-border)" } : undefined}
      >
        <span id={labelId} className="text-sm font-medium">
          Topics
        </span>
        <span
          id={counterId}
          aria-live="polite"
          className="text-sm tabular-nums"
          style={{ color: overMax ? "var(--color-destructive)" : "var(--color-muted-foreground)" }}
        >
          {counterText(count, min, max)}
        </span>
      </div>
      <p id={hintId} className="text-sm" style={{ color: "var(--color-muted-foreground)" }}>
        {`Pick ${min} to ${max}. Search, or browse the groups below.`}
      </p>

      {overMax && (
        <p role="status" className="text-sm" style={{ color: "var(--color-destructive)" }}>
          {`You follow ${count} ${noun}; the limit is now ${max}. Remove ${count - max} before you next save.`}
        </p>
      )}

      <div className="relative">
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
          style={{ color: "var(--color-muted-foreground)" }}
        />
        <label htmlFor={searchId} className="sr-only">
          Search topics
        </label>
        <input
          id={searchId}
          type="search"
          autoComplete="off"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={holdEnter}
          placeholder="Search topics"
          aria-describedby={`${uid}-matches`}
          className="w-full rounded-[2px] border bg-[var(--color-card)] py-2 pr-3 pl-9 text-sm outline-none focus-visible:border-[var(--color-foreground)] focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]/30"
          style={{ borderColor: "var(--color-border)" }}
        />
        <span id={`${uid}-matches`} aria-live="polite" className="sr-only">
          {terms.length > 0 ? `${shownCount} ${shownCount === 1 ? "topic matches" : "topics match"}` : ""}
        </span>
      </div>

      <div role="group" aria-labelledby={labelId} aria-describedby={`${hintId} ${counterId}`}>
        {groups.length === 0 ? (
          <p className="py-6 text-center text-sm" style={{ color: "var(--color-muted-foreground)" }}>
            {`No topic matches “${query.trim()}”.`}
          </p>
        ) : (
          <div className="flex flex-col gap-5">
            {groups.map((group) => {
              const headingId = `${uid}-group-${group.name.replace(/\W+/g, "-")}`;
              return (
                <section key={group.name} aria-labelledby={headingId}>
                  <h3
                    id={headingId}
                    className="mb-2 border-t pt-1.5 text-xs font-semibold tracking-[0.12em] uppercase"
                    style={{ borderColor: "var(--color-rule)" }}
                  >
                    {group.name}
                  </h3>
                  <ul className="grid grid-cols-[repeat(auto-fill,minmax(13rem,1fr))] gap-1.5">
                    {group.shown.map((topic) => (
                      <li key={topic}>
                        <TopicChip
                          topic={topic}
                          picked={picked.has(topic)}
                          blocked={atMax && !picked.has(topic)}
                          counterId={counterId}
                          idBase={`${uid}-${topic.replace(/\W+/g, "-")}`}
                          onToggle={toggle}
                        />
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
          </div>
        )}
      </div>

      {value.map((topic) => (
        <input key={topic} type="hidden" name={name} value={topic} />
      ))}
    </div>
  );
}

function TopicChip({
  topic,
  picked,
  blocked,
  counterId,
  idBase,
  onToggle,
}: {
  topic: Topic;
  picked: boolean;
  blocked: boolean;
  counterId: string;
  idBase: string;
  onToggle: (topic: Topic) => void;
}) {
  const nameId = `${idBase}-name`;
  const descriptionId = `${idBase}-description`;
  const state = picked
    ? "border-[var(--color-foreground)] bg-[var(--color-foreground)] text-[var(--color-background)] cursor-pointer"
    : blocked
      ? "border-[var(--color-border)] bg-[var(--color-background)] text-[var(--color-foreground)] cursor-not-allowed opacity-50"
      : "border-[var(--color-border)] bg-[var(--color-background)] text-[var(--color-foreground)] cursor-pointer hover:border-[var(--color-foreground)]";
  return (
    <button
      type="button"
      data-slot="topic-chip"
      aria-pressed={picked}
      aria-disabled={blocked || undefined}
      aria-labelledby={nameId}
      aria-describedby={blocked ? `${descriptionId} ${counterId}` : descriptionId}
      onClick={() => onToggle(topic)}
      className={`flex h-full w-full flex-col items-start gap-0.5 rounded-[2px] border px-3 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-background)] ${state}`}
    >
      <span id={nameId} className="text-[15px] leading-tight font-semibold [font-variant-caps:small-caps]">
        {topic}
      </span>
      <span
        id={descriptionId}
        className="text-xs leading-snug"
        style={{ color: picked ? "var(--color-background)" : "var(--color-muted-foreground)" }}
      >
        {TOPIC_DESCRIPTIONS[topic as keyof typeof TOPIC_DESCRIPTIONS]}
      </span>
    </button>
  );
}

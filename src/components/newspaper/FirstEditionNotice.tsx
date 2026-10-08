/**
 * Shown on an empty day to a reader who has never had an edition: what the
 * button below it does, before they press it. The run limit is the spend
 * caps' `max_digest_runs_per_window` (4 in any rolling 24 hours, see
 * supabase/schema.sql); keep the sentence in step with it.
 */
export function FirstEditionNotice() {
  return (
    <section
      aria-labelledby="first-edition-notice"
      data-testid="first-edition-notice"
      className="w-full max-w-[460px] border-t pt-3 text-left"
      style={{ borderColor: "var(--color-rule)" }}
    >
      <p className="text-[11px] tracking-[0.12em] uppercase" style={{ color: "var(--color-muted-foreground)" }}>
        Notice to readers
      </p>
      <h2 id="first-edition-notice" className="mt-1 font-heading text-xl font-bold">
        Your first edition
      </h2>
      <p className="mt-1.5 text-[15px] leading-normal">
        Press the button and the paper reads your outlets, merges repeated reports into single stories, and writes
        today&apos;s edition in about a minute. You can run it up to 4 times in any 24 hours; each later run adds
        what&apos;s new since the last one.
      </p>
    </section>
  );
}

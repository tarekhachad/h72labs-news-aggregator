"use client";

import { useId } from "react";
import { useFormStatus } from "react-dom";

/**
 * The preference forms' submit button: disabled while a save is in flight
 * (the save is delete-then-insert, so a double submit could race itself) and
 * while `blockedReason` is set, with that reason shown beside it.
 */
export function SaveButton({
  children,
  blockedReason,
  pendingLabel = "Saving…",
}: {
  children: React.ReactNode;
  blockedReason: string | null;
  pendingLabel?: string;
}) {
  const { pending } = useFormStatus();
  const reasonId = useId();
  return (
    <div className="flex flex-col items-center gap-2">
      <button
        type="submit"
        disabled={pending || blockedReason !== null}
        aria-describedby={blockedReason !== null ? reasonId : undefined}
        className="cursor-pointer rounded-full px-8 py-3 text-sm font-medium transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
        style={{ background: "var(--color-primary)", color: "var(--color-on-primary)" }}
      >
        {pending ? pendingLabel : children}
      </button>
      {blockedReason !== null && (
        <p id={reasonId} className="text-center text-sm" style={{ color: "var(--color-muted-foreground)" }}>
          {blockedReason}
        </p>
      )}
    </div>
  );
}

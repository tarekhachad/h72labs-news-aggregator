"use client";

import { useFormStatus } from "react-dom";

// A form's own delete-then-insert (or any non-idempotent) action can race
// itself if double-clicked before the first submission redirects — disabling
// while pending closes that off without needing client-side state per form.
export function SubmitButton({
  children,
  className,
  style,
  pendingLabel = "Saving…",
}: {
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  pendingLabel?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className={className} style={style}>
      {pending ? pendingLabel : children}
    </button>
  );
}

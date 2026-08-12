"use client";

import { useEffect, useId, useRef } from "react";
import { motion } from "motion/react";
import { Button } from "@/components/ui/button";
import { Backdrop } from "@/components/newspaper/Backdrop";
import { useInertBackground } from "@/hooks/useInertBackground";

/**
 * A small centered confirmation box — the "are you sure?" gate in front of
 * an action that can't be undone from the UI. Added in Phase 8.2 for sign
 * out; written generically because the shape is reusable, not because a
 * second caller exists yet.
 *
 * Deliberately built on the same primitives as focus mode (Backdrop, a
 * portaled panel, useInertBackground) rather than on Base UI's Dialog,
 * which is what Sheet uses. Two reasons: it matches focus mode visually,
 * which is what Tarek asked for; and the one caller today lives inside an
 * open Sheet, so a Base UI dialog nested in that subtree would have to
 * negotiate with the Sheet's own focus trap. Closing the Sheet first and
 * rendering this as a plain sibling portal avoids that entirely.
 *
 * Sized to its content, not to a fraction of the viewport like
 * FocusOverlay's 75% box — the message is one line, so a card-sized panel
 * would read as an error.
 *
 * The caller portals this to document.body and unmounts it to dismiss;
 * this component owns no open/closed state of its own. That mirrors
 * FocusOverlay and keeps the "only one inert sweep at a time" rule easy to
 * reason about at the call site.
 */
export function ConfirmDialog({
  title,
  description,
  confirmLabel,
  onConfirm,
  onCancel,
  destructive = false,
  pending = false,
  error = null,
}: {
  title: string;
  description: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  /** Styles the confirm button as destructive. Does not change behavior. */
  destructive?: boolean;
  /** Disables both buttons while the confirmed action is in flight. */
  pending?: boolean;
  /**
   * Message shown when the confirmed action failed. The dialog stays open
   * so the user can retry or back out — the caller is expected to clear
   * `pending` alongside setting this.
   */
  error?: string | null;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  // Initial focus goes to Cancel, not the confirm button: this dialog
  // exists specifically to stop an accidental action, so the keyboard
  // default must be the safe one. A stray Enter should dismiss, never
  // confirm.
  useInertBackground(rootRef, cancelButtonRef);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Escape routes through the same onCancel as the Cancel button and
      // the backdrop, so all three dismiss paths behave identically —
      // including whether they do anything at all mid-flight, which is the
      // caller's call to make, not this component's. (The sign-out caller
      // no-ops all three while its action is in flight.)
      if (e.key === "Escape") onCancel();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onCancel]);

  return (
    <div ref={rootRef}>
      <Backdrop onClick={onCancel} />
      <motion.div
        // Instant, matching Backdrop and FocusOverlay — this codebase's
        // overlays don't animate (Phase 6.3, Tarek's call).
        transition={{ duration: 0 }}
        className="fixed inset-0 z-50 flex items-center justify-center p-6"
        // The flex wrapper spans the viewport for centering, so it would
        // otherwise swallow every backdrop click behind it.
        style={{ pointerEvents: "none" }}
      >
        <div
          className="w-full max-w-sm rounded-md p-6"
          style={{
            pointerEvents: "auto",
            background: "var(--color-card)",
            color: "var(--color-card-foreground)",
            border: "1px solid var(--color-border)",
            boxShadow: "0 10px 24px rgba(26,26,26,0.16)",
          }}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={descriptionId}
        >
          <h2 id={titleId} className="font-heading text-lg font-bold">
            {title}
          </h2>
          <p
            id={descriptionId}
            className="mt-2 text-sm leading-6"
            style={{ color: "var(--color-muted-foreground)" }}
          >
            {description}
          </p>
          {error && (
            <p className="mt-3 text-sm" style={{ color: "var(--color-destructive)" }} role="alert">
              {error}
            </p>
          )}
          <div className="mt-6 flex justify-end gap-2">
            <Button
              ref={cancelButtonRef}
              variant="outline"
              onClick={onCancel}
              disabled={pending}
              className="cursor-pointer"
            >
              Cancel
            </Button>
            <Button
              variant={destructive ? "destructive" : "default"}
              onClick={onConfirm}
              disabled={pending}
              className="cursor-pointer"
            >
              {confirmLabel}
            </Button>
          </div>
        </div>
      </motion.div>
    </div>
  );
}

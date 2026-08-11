"use client";

import { motion } from "motion/react";

/**
 * Dimmed, blurred full-viewport backdrop — shared primitive for focus mode
 * (see FocusOverlay.tsx). Sidebar has its own equivalent via shadcn's Sheet
 * (already shipped, converged, and reviewed in B5) rather than this one —
 * not worth an unrelated refactor of already-working code just to share
 * this component, per the 4.3 plan's "also usable by Sidebar" note being a
 * capability, not a mandate to migrate existing UI.
 */
export function Backdrop({ onClick }: { onClick: () => void }) {
  return (
    <motion.div
      className="fixed inset-0 z-40"
      style={{ background: "rgba(26,26,26,0.4)", backdropFilter: "blur(6px)" }}
      onClick={onClick}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      // No `exit` prop: its caller removes this via a plain conditional,
      // not AnimatePresence, so an exit animation would never actually
      // run — the fade-in above still works (it's driven by mount, not
      // exit), only the close is an instant unmount. Instant fade-in too
      // (duration 0), per Tarek's request to remove the focus-mode
      // animation entirely.
      transition={{ duration: 0 }}
      aria-hidden
    />
  );
}

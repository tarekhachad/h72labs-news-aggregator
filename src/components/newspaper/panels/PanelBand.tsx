import type { ReactNode } from "react";

/**
 * The slim band a topic panel sits in, under the topic heading and above the
 * cards. Each panel renders it only when it has something to show, so a panel
 * with no data leaves no empty strip behind.
 */
export function PanelBand({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section aria-label={label} className="px-6 pb-6 md:px-10">
      {children}
    </section>
  );
}

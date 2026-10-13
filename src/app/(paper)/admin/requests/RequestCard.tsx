"use client";

import { useActionState, useState } from "react";
import { approveRequest, declineRequest, type AdminRowState } from "./actions";
import { ADMIN_RESULT_MESSAGES, type AdminResultCode } from "@/lib/inviteRequest";
import { safeExternalHref } from "@/lib/safeHref";
import type { InviteRequestRow } from "@/lib/adminRequests";

const NONE: AdminRowState = { code: null };

/** Results that leave the request pending, so it can still be decided. */
const REFUSALS = new Set<AdminResultCode>(["has_account", "failed"]);

const BUTTON_CLASS =
  "cursor-pointer rounded-full px-5 py-2 text-sm font-medium transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60";

const STATUS_LABEL = { pending: "Pending", approved: "Approved", declined: "Declined" } as const;

/**
 * One request. Keyed by id, so the result of an approve or decline (and,
 * when the email failed, the only copy of the link) survives the refresh the
 * action triggers, even though the decided card moves below the pending ones.
 */
export function RequestCard({ row, inviteNote, receivedAt }: { row: InviteRequestRow; inviteNote: string | null; receivedAt: string }) {
  const [approved, approve, approving] = useActionState(approveRequest, NONE);
  const [declined, decline, declining] = useActionState(declineRequest, NONE);
  const busy = approving || declining;
  // A refusal that left the request pending keeps the buttons, so Tarek can
  // decline after "has an account" or retry after a failure without a reload.
  // Until something settles, the card shows the outcome of the last action
  // he took, so a second refusal replaces the first.
  const [last, setLast] = useState<"approve" | "decline" | null>(null);
  const settled = (state: AdminRowState) => state.code !== null && !REFUSALS.has(state.code);
  const latest = last === "approve" ? approved : last === "decline" ? declined : NONE;
  const result = settled(approved) ? approved : settled(declined) ? declined : latest.code ? latest : null;
  const decidable = row.status === "pending" && !settled(approved) && !settled(declined);
  const link = row.link ? safeExternalHref(row.link) : undefined;

  return (
    <article className="flex flex-col gap-3 rounded-xl border p-5" style={{ borderColor: "var(--color-border)", background: "var(--color-card)" }}>
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-heading text-lg font-semibold">
          {row.name} <span className="text-sm font-normal" style={{ color: "var(--color-muted-foreground)" }}>{row.email}</span>
        </h2>
        <span className="text-xs" style={{ color: "var(--color-muted-foreground)" }}>
          {STATUS_LABEL[row.status]}
          {inviteNote ? ` · ${inviteNote}` : ""} · {receivedAt}
        </span>
      </header>

      <dl className="grid gap-2 text-sm">
        <Detail term="How they heard about it" value={row.referral} />
        <Detail term="What they'd like to read" value={row.interests} />
        <Detail term="Their note" value={row.note} />
        {row.link && (
          <Detail
            term="Link"
            value={
              link ? (
                <a href={link} target="_blank" rel="noopener noreferrer nofollow" className="break-all underline">
                  {row.link}
                </a>
              ) : (
                row.link
              )
            }
          />
        )}
      </dl>

      {(row.has_account || row.had_account || row.earlier_requests > 0) && (
        <p className="text-xs" style={{ color: "var(--color-muted-foreground)" }}>
          {row.has_account ? "This email has an account." : row.had_account ? "This email had an account when it asked." : null}
          {row.earlier_requests > 0 ? ` ${row.earlier_requests} earlier request${row.earlier_requests === 1 ? "" : "s"} from this email.` : null}
        </p>
      )}

      {decidable && (
        <div className="flex flex-wrap items-center gap-3">
          <form action={approve} onSubmit={() => setLast("approve")}>
            <input type="hidden" name="id" value={row.id} />
            <button
              type="submit"
              disabled={busy}
              className={BUTTON_CLASS}
              style={{ background: "var(--color-primary)", color: "var(--color-on-primary)" }}
            >
              {approving ? "Approving…" : "Approve and send invite"}
            </button>
          </form>
          <form action={decline} onSubmit={() => setLast("decline")} className="flex items-center gap-3">
            <input type="hidden" name="id" value={row.id} />
            <button type="submit" disabled={busy} className={`${BUTTON_CLASS} border`} style={{ borderColor: "var(--color-border)" }}>
              {declining ? "Declining…" : "Decline"}
            </button>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="notify" disabled={busy} /> Send a polite email
            </label>
          </form>
        </div>
      )}

      {result?.code && (
        <div role="status" className="flex flex-col gap-2 text-sm">
          <p>{ADMIN_RESULT_MESSAGES[result.code]}</p>
          {result.link && (
            <input
              readOnly
              value={result.link}
              aria-label="Invite link"
              onFocus={(e) => e.currentTarget.select()}
              className="rounded-md border px-3 py-2 font-mono text-xs"
              style={{ borderColor: "var(--color-border)", background: "var(--color-background)" }}
            />
          )}
        </div>
      )}
    </article>
  );
}

function Detail({ term, value }: { term: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs" style={{ color: "var(--color-muted-foreground)" }}>
        {term}
      </dt>
      <dd className="whitespace-pre-wrap break-words">{value}</dd>
    </div>
  );
}

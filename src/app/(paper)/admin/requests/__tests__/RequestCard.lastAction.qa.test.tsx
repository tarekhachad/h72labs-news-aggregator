// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { InviteRequestRow } from "@/lib/adminRequests";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({ approve: vi.fn(), decline: vi.fn() }));
vi.mock("@/app/(paper)/admin/requests/actions", () => ({
  approveRequest: mocks.approve,
  declineRequest: mocks.decline,
}));

const { RequestCard } = await import("@/app/(paper)/admin/requests/RequestCard");
const { ADMIN_RESULT_MESSAGES } = await import("@/lib/inviteRequest");

const ID = "7d3c9a0e-4b7f-4c8e-9a51-1f2e3d4c5b6a";
const ROW: InviteRequestRow = {
  id: ID,
  created_at: "2026-10-12T10:00:00Z",
  name: "Ann",
  email: "ann@example.com",
  referral: "A friend",
  interests: "Morocco",
  note: "",
  link: null,
  had_account: false,
  has_account: false,
  earlier_requests: 0,
  status: "pending",
  decided_at: null,
  invite_expires_at: null,
  invite_consumed_at: null,
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  mocks.approve.mockReset();
  mocks.decline.mockReset();
});

afterEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  await act(async () => root.unmount());
  document.body.innerHTML = "";
});

async function render(row: InviteRequestRow = ROW) {
  await act(async () => root.render(<RequestCard key={row.id} row={row} inviteNote={null} receivedAt="Oct 12, 2026" />));
}

const button = (label: RegExp) => [...container.querySelectorAll("button")].find((b) => label.test(b.textContent ?? ""));
const status = () => container.querySelector('[role="status"]')?.textContent ?? null;
const approveForm = () => button(/Approve/)!.closest("form")!;
const declineForm = () => button(/Decline/)!.closest("form")!;

async function submit(form: HTMLFormElement) {
  await act(async () => form.requestSubmit());
  await act(async () => new Promise((r) => setTimeout(r, 0)));
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe("RequestCard: the outcome of the last action", () => {
  it("approve fails, approve fails again: still the failure, both buttons still live", async () => {
    mocks.approve.mockResolvedValue({ code: "failed" });
    await render();
    await submit(approveForm());
    await submit(approveForm());
    expect(mocks.approve).toHaveBeenCalledTimes(2);
    expect(status()).toBe(ADMIN_RESULT_MESSAGES.failed);
    expect(button(/Approve/)!.disabled).toBe(false);
    expect(button(/Decline/)!.disabled).toBe(false);
  });

  it("approve fails, approve retried succeeds with the email sent: shows approved, no link, no buttons", async () => {
    mocks.approve.mockResolvedValueOnce({ code: "failed" }).mockResolvedValueOnce({ code: "approved" });
    await render();
    await submit(approveForm());
    await submit(approveForm());
    expect(status()).toBe(ADMIN_RESULT_MESSAGES.approved);
    expect(container.querySelector('input[aria-label="Invite link"]')).toBeNull();
    expect(button(/Approve/)).toBeUndefined();
    expect(button(/Decline/)).toBeUndefined();
  });

  it("decline fails, then approve sends an unsent invite: the link shows, the failure does not", async () => {
    const link = "https://news.example.test/signup?invite=X&email=ann%40example.com";
    mocks.decline.mockResolvedValue({ code: "failed" });
    mocks.approve.mockResolvedValue({ code: "approved_unsent", link });
    await render();
    await submit(declineForm());
    expect(status()).toBe(ADMIN_RESULT_MESSAGES.failed);
    await submit(approveForm());
    expect(status()).toContain(ADMIN_RESULT_MESSAGES.approved_unsent);
    expect(status()).not.toContain(ADMIN_RESULT_MESSAGES.failed);
    expect((container.querySelector('input[aria-label="Invite link"]') as HTMLInputElement).value).toBe(link);
    // The revalidation re-render keeps the one-time link.
    await render({ ...ROW, status: "approved", decided_at: "2026-10-12T11:00:00Z" });
    expect((container.querySelector('input[aria-label="Invite link"]') as HTMLInputElement).value).toBe(link);
  });

  it("decline fails, then approve is refused for an account: shows the account refusal, not the decline failure", async () => {
    mocks.decline.mockResolvedValue({ code: "failed" });
    mocks.approve.mockResolvedValue({ code: "has_account" });
    await render({ ...ROW, has_account: true });
    await submit(declineForm());
    await submit(approveForm());
    expect(status()).toBe(ADMIN_RESULT_MESSAGES.has_account);
    expect(button(/Decline/)!.disabled).toBe(false);
  });

  it("has_account, decline fails, approve again refused: the newest refusal (has_account) shows", async () => {
    mocks.approve.mockResolvedValue({ code: "has_account" });
    mocks.decline.mockResolvedValue({ code: "failed" });
    await render({ ...ROW, has_account: true });
    await submit(approveForm());
    await submit(declineForm());
    expect(status()).toBe(ADMIN_RESULT_MESSAGES.failed);
    await submit(approveForm());
    expect(mocks.approve).toHaveBeenCalledTimes(2);
    expect(status()).toBe(ADMIN_RESULT_MESSAGES.has_account);
  });

  it("decline fails, approve refused, decline succeeds: the decline's settled result wins and the buttons go", async () => {
    mocks.decline.mockResolvedValueOnce({ code: "failed" }).mockResolvedValueOnce({ code: "declined_emailed" });
    mocks.approve.mockResolvedValue({ code: "has_account" });
    await render({ ...ROW, has_account: true });
    await submit(declineForm());
    await submit(approveForm());
    await submit(declineForm());
    expect(status()).toBe(ADMIN_RESULT_MESSAGES.declined_emailed);
    expect(button(/Approve/)).toBeUndefined();
    expect(button(/Decline/)).toBeUndefined();
  });

  it("a settled approve is not hidden by a later stale decline refusal", async () => {
    // decline failed first; approve then settles. The settled one shows even though decline also has a code.
    mocks.decline.mockResolvedValue({ code: "failed" });
    mocks.approve.mockResolvedValue({ code: "not_pending" });
    await render();
    await submit(declineForm());
    await submit(approveForm());
    expect(status()).toBe(ADMIN_RESULT_MESSAGES.not_pending);
    expect(button(/Approve/)).toBeUndefined();
  });
});

describe("RequestCard: while an action is running", () => {
  it("the other action's stale refusal is not shown while a decline runs, and its outcome lands after", async () => {
    mocks.approve.mockResolvedValue({ code: "has_account" });
    const d = deferred<{ code: "failed" }>();
    mocks.decline.mockReturnValue(d.promise);
    await render({ ...ROW, has_account: true });
    await submit(approveForm());
    await act(async () => declineForm().requestSubmit());
    try {
      expect(button(/Declining/)!.disabled).toBe(true);
      expect(button(/Approve/)!.disabled).toBe(true);
      expect(status() ?? "").not.toContain(ADMIN_RESULT_MESSAGES.has_account);
    } finally {
      // React entangles every pending async action, so an unresolved one would stall later tests.
      await act(async () => d.resolve({ code: "failed" }));
    }
    expect(status()).toBe(ADMIN_RESULT_MESSAGES.failed);
    expect(button(/Decline/)!.disabled).toBe(false);
  });

  it("onSubmit's record of the last action is committed in the same render as the pending state", async () => {
    // If setLast lagged behind the action (or never ran), the first pending render would still
    // show the approve refusal under a "Declining…" button. Checked at the first commit.
    mocks.approve.mockResolvedValue({ code: "has_account" });
    const d = deferred<{ code: "failed" }>();
    mocks.decline.mockReturnValue(d.promise);
    await render({ ...ROW, has_account: true });
    await submit(approveForm());
    const seen: Array<{ declining: boolean; status: string | null }> = [];
    const obs = new MutationObserver(() => seen.push({ declining: !!button(/Declining/), status: status() }));
    obs.observe(container, { childList: true, subtree: true, characterData: true });
    await act(async () => declineForm().requestSubmit());
    try {
      obs.disconnect();
      expect(seen.some((s) => s.declining)).toBe(true);
      for (const s of seen) if (s.declining) expect(s.status ?? "").not.toContain(ADMIN_RESULT_MESSAGES.has_account);
    } finally {
      await act(async () => d.resolve({ code: "failed" }));
    }
  });
});

describe("RequestCard: double submissions", () => {
  it("a double click on Approve (real events, no act batching) calls the action once", async () => {
    const d = deferred<{ code: "approved" }>();
    mocks.approve.mockReturnValue(d.promise);
    await render();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
    // Each browser click is its own task, so microtasks (where React flushes) run between them.
    const nextTask = () => new Promise((r) => setTimeout(r, 0));
    const approveButton = button(/Approve/)!;
    approveButton.click();
    await nextTask();
    expect(approveButton.disabled).toBe(true);
    approveButton.click();
    await nextTask();
    button(/Decline/)!.click();
    await nextTask();
    expect(mocks.decline).not.toHaveBeenCalled();
    d.resolve({ code: "approved" });
    for (let i = 0; i < 50 && status() === null; i++) await nextTask();
    // useActionState queues a second dispatch behind the first, so count only after it settles.
    expect(mocks.approve).toHaveBeenCalledTimes(1);
    expect(status()).toBe(ADMIN_RESULT_MESSAGES.approved);
  });
});

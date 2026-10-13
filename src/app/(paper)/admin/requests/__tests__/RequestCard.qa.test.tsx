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
  note: "Curious\nsecond line",
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
  await act(async () => root.unmount());
  document.body.innerHTML = "";
});

async function render(row: InviteRequestRow, inviteNote: string | null = null) {
  await act(async () =>
    root.render(
      <div>
        <RequestCard key={row.id} row={row} inviteNote={inviteNote} receivedAt="Oct 12, 2026, 10:00 AM" />
      </div>
    )
  );
}

const button = (label: RegExp) => [...container.querySelectorAll("button")].find((b) => label.test(b.textContent ?? ""));

async function submit(form: HTMLFormElement) {
  await act(async () => form.requestSubmit());
  await act(async () => new Promise((r) => setTimeout(r, 0)));
}

describe("RequestCard", () => {
  it("shows the requester's text as text and offers both decisions while pending", async () => {
    await render(ROW);
    expect(container.textContent).toContain("Ann");
    expect(container.textContent).toContain("ann@example.com");
    expect(container.textContent).toContain("Curious\nsecond line");
    expect(button(/Approve and send invite/)).toBeDefined();
    expect(button(/Decline/)).toBeDefined();
    expect(container.querySelectorAll('input[name="id"]').length).toBe(2);
    for (const input of container.querySelectorAll<HTMLInputElement>('input[name="id"]')) expect(input.value).toBe(ID);
  });

  it("links an http(s) link with noopener and nofollow, and shows anything else as plain text", async () => {
    await render({ ...ROW, link: "https://ann.example/me" });
    const a = container.querySelector("dd a") as HTMLAnchorElement;
    expect(a.getAttribute("href")).toBe("https://ann.example/me");
    expect(a.rel).toContain("noopener");
    expect(a.rel).toContain("nofollow");
    expect(a.target).toBe("_blank");

    await act(async () => root.unmount());
    root = createRoot(container);
    await render({ ...ROW, link: "javascript:alert(document.cookie)" });
    expect(container.querySelector("dd a")).toBeNull();
    expect(container.textContent).toContain("javascript:alert(document.cookie)");
  });

  it("renders a requester's markup as inert text", async () => {
    await render({ ...ROW, name: "<img src=x onerror=alert(1)>", note: "<script>alert(1)</script>" });
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toContain("<script>alert(1)</script>");
  });

  it("offers no decision on an already decided row, and shows its invite state", async () => {
    await render({ ...ROW, status: "approved", decided_at: "2026-10-12T11:00:00Z" }, "Invite not used yet");
    expect(button(/Approve/)).toBeUndefined();
    expect(button(/Decline/)).toBeUndefined();
    expect(container.textContent).toContain("Approved · Invite not used yet");
  });

  it("notes an existing account and earlier requests", async () => {
    await render({ ...ROW, has_account: true, earlier_requests: 2 });
    expect(container.textContent).toContain("This email has an account.");
    expect(container.textContent).toContain("2 earlier requests from this email.");
  });

  it("notes an account the requester had when asking, and a single earlier request", async () => {
    await render({ ...ROW, had_account: true, earlier_requests: 1 });
    expect(container.textContent).toContain("This email had an account when it asked.");
    expect(container.textContent).toContain("1 earlier request from this email.");
  });

  it("keeps the fallback link on screen after the refresh turns the row approved", async () => {
    const link = "https://news.example.test/signup?invite=TOKEN&email=ann%40example.com";
    mocks.approve.mockResolvedValue({ code: "approved_unsent", link });
    await render(ROW);
    await submit(button(/Approve/)!.closest("form")!);

    const fd: FormData = mocks.approve.mock.calls[0][1];
    expect(fd.get("id")).toBe(ID);
    const status = container.querySelector('[role="status"]')!;
    expect(status.textContent).toContain(ADMIN_RESULT_MESSAGES.approved_unsent);
    expect((container.querySelector('input[aria-label="Invite link"]') as HTMLInputElement).value).toBe(link);
    expect(button(/Approve/)).toBeUndefined();

    // revalidatePath re-renders the page: the same card, keyed by id, now approved.
    await render({ ...ROW, status: "approved", decided_at: "2026-10-12T11:00:00Z" }, "Invite not used yet");
    expect((container.querySelector('input[aria-label="Invite link"]') as HTMLInputElement).value).toBe(link);
    expect(container.textContent).toContain(ADMIN_RESULT_MESSAGES.approved_unsent);
  });

  it("shows no link input when the email went out", async () => {
    mocks.approve.mockResolvedValue({ code: "approved" });
    await render(ROW);
    await submit(button(/Approve/)!.closest("form")!);
    expect(container.textContent).toContain(ADMIN_RESULT_MESSAGES.approved);
    expect(container.querySelector('input[aria-label="Invite link"]')).toBeNull();
  });

  it("sends notify=on only when the box is ticked", async () => {
    mocks.decline.mockResolvedValue({ code: "declined_emailed" });
    await render(ROW);
    const declineForm = button(/Decline/)!.closest("form")!;
    (declineForm.querySelector('input[name="notify"]') as HTMLInputElement).click();
    await submit(declineForm);
    const fd: FormData = mocks.decline.mock.calls[0][1];
    expect(fd.get("notify")).toBe("on");
    expect(fd.get("id")).toBe(ID);
    expect(container.textContent).toContain(ADMIN_RESULT_MESSAGES.declined_emailed);
  });

  it("omits notify when the box is not ticked", async () => {
    mocks.decline.mockResolvedValue({ code: "declined" });
    await render(ROW);
    await submit(button(/Decline/)!.closest("form")!);
    expect((mocks.decline.mock.calls[0][1] as FormData).get("notify")).toBeNull();
  });

  it("shows a refusal and hides the buttons", async () => {
    mocks.approve.mockResolvedValue({ code: "not_pending" });
    await render(ROW);
    await submit(button(/Approve/)!.closest("form")!);
    expect(container.textContent).toContain(ADMIN_RESULT_MESSAGES.not_pending);
  });

  it("keeps both decisions after 'has an account', and then shows the decline that followed", async () => {
    mocks.approve.mockResolvedValue({ code: "has_account" });
    mocks.decline.mockResolvedValue({ code: "declined" });
    await render({ ...ROW, has_account: true });
    await submit(button(/Approve/)!.closest("form")!);
    expect(container.querySelector('[role="status"]')!.textContent).toBe(ADMIN_RESULT_MESSAGES.has_account);
    expect(button(/Approve/)).toBeDefined();
    expect(button(/Decline/)!.disabled).toBe(false);

    await submit(button(/Decline/)!.closest("form")!);
    expect(mocks.decline).toHaveBeenCalledTimes(1);
    // The card shows the decline, not the earlier refusal, and offers nothing more.
    expect(container.querySelector('[role="status"]')!.textContent).toBe(ADMIN_RESULT_MESSAGES.declined);
    expect(container.textContent).not.toContain(ADMIN_RESULT_MESSAGES.has_account);
    expect(button(/Approve/)).toBeUndefined();
    expect(button(/Decline/)).toBeUndefined();

    // The refresh turns the row declined; the outcome stays.
    await render({ ...ROW, has_account: true, status: "declined", decided_at: "2026-10-12T11:00:00Z" });
    expect(container.querySelector('[role="status"]')!.textContent).toBe(ADMIN_RESULT_MESSAGES.declined);
  });

  it("keeps both decisions after a failure, and a retried approval replaces it with its link", async () => {
    const link = "https://news.example.test/signup?invite=T&email=ann%40example.com";
    mocks.approve.mockResolvedValueOnce({ code: "failed" }).mockResolvedValueOnce({ code: "approved_unsent", link });
    await render(ROW);
    await submit(button(/Approve/)!.closest("form")!);
    expect(container.querySelector('[role="status"]')!.textContent).toBe(ADMIN_RESULT_MESSAGES.failed);
    expect(button(/Approve/)!.disabled).toBe(false);

    await submit(button(/Approve/)!.closest("form")!);
    expect(mocks.approve).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[role="status"]')!.textContent).toContain(ADMIN_RESULT_MESSAGES.approved_unsent);
    expect(container.textContent).not.toContain(ADMIN_RESULT_MESSAGES.failed);
    expect((container.querySelector('input[aria-label="Invite link"]') as HTMLInputElement).value).toBe(link);
    expect(button(/Approve/)).toBeUndefined();
  });

  it("a decline that fails after a refusal is what the card shows, not the older refusal", async () => {
    mocks.approve.mockResolvedValue({ code: "has_account" });
    mocks.decline.mockResolvedValue({ code: "failed" });
    await render({ ...ROW, has_account: true });
    await submit(button(/Approve/)!.closest("form")!);
    await submit(button(/Decline/)!.closest("form")!);
    expect(mocks.decline).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[role="status"]')!.textContent).toBe(ADMIN_RESULT_MESSAGES.failed);
  });

  it.each(["not_pending", "unknown", "declined_unsent"] as const)("hides both decisions after a settled '%s'", async (code) => {
    mocks.decline.mockResolvedValue({ code });
    await render(ROW);
    await submit(button(/Decline/)!.closest("form")!);
    expect(container.querySelector('[role="status"]')!.textContent).toBe(ADMIN_RESULT_MESSAGES[code]);
    expect(button(/Approve/)).toBeUndefined();
    expect(button(/Decline/)).toBeUndefined();
  });

  it("keeps a card's result when the refresh moves it below the pending ones", async () => {
    const link = "https://news.example.test/signup?invite=ONCE&email=ann%40example.com";
    mocks.approve.mockResolvedValue({ code: "approved_unsent", link });
    const OTHER: InviteRequestRow = { ...ROW, id: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d", name: "Bea", email: "bea@example.com" };
    const list = async (rows: InviteRequestRow[]) =>
      act(async () =>
        root.render(
          <div>
            {rows.map((r) => (
              <RequestCard key={r.id} row={r} inviteNote={null} receivedAt="Oct 12, 2026, 10:00 AM" />
            ))}
          </div>
        )
      );
    // Ann (newer) above Bea, both pending.
    await list([ROW, OTHER]);
    const annCard = () => [...container.querySelectorAll("article")].find((a) => a.textContent!.includes("ann@example.com"))!;
    const beaCard = () => [...container.querySelectorAll("article")].find((a) => a.textContent!.includes("bea@example.com"))!;
    await submit(annCard().querySelector("form")!);
    expect(mocks.approve.mock.calls[0][1].get("id")).toBe(ID);

    // The refresh: Ann is approved and drops below the still-pending Bea.
    await list([OTHER, { ...ROW, status: "approved", decided_at: "2026-10-12T11:00:00Z" }]);
    const articles = [...container.querySelectorAll("article")];
    expect(articles[0].textContent).toContain("bea@example.com");
    expect(articles[1].textContent).toContain("ann@example.com");
    expect((annCard().querySelector('input[aria-label="Invite link"]') as HTMLInputElement).value).toBe(link);
    expect(beaCard().querySelector('[role="status"]')).toBeNull();
    expect(beaCard().querySelectorAll("button").length).toBe(2);
  });

  it("disables both decisions while one is running", async () => {
    let finish!: (v: unknown) => void;
    mocks.approve.mockReturnValue(new Promise((r) => (finish = r)));
    await render(ROW);
    await act(async () => button(/Approve/)!.closest("form")!.requestSubmit());
    expect(button(/Approving/)!.disabled).toBe(true);
    expect(button(/Decline/)!.disabled).toBe(true);
    await act(async () => finish({ code: "approved" }));
  });
});

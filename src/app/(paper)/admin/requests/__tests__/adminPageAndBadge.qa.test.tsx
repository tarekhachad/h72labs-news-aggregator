// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, isValidElement, type ReactElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

// /admin/requests as the server renders it, the reads behind it, and the
// (paper) layout's badge promise, with Supabase mocked.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  getUser: vi.fn(),
  createClient: vi.fn(),
  getUserTimeZone: vi.fn(),
}));

vi.mock("next/navigation", async (importActual) => ({
  ...(await importActual<typeof import("next/navigation")>()),
  notFound: vi.fn(() => {
    throw new Error("NOT_FOUND");
  }),
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/lib/profile", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/profile")>()),
  getUserTimeZone: mocks.getUserTimeZone,
}));
vi.mock("@/app/(paper)/admin/requests/actions", () => ({ approveRequest: vi.fn(), declineRequest: vi.fn() }));

const { default: AdminRequestsPage } = await import("@/app/(paper)/admin/requests/page");
const { loadInviteRequests, loadPendingRequestCount, inviteState } = await import("@/lib/adminRequests");
const adminActions = await import("@/app/(paper)/admin/requests/actions");

const row = (over: Record<string, unknown> = {}) => ({
  id: "7d3c9a0e-4b7f-4c8e-9a51-1f2e3d4c5b6a",
  created_at: "2026-10-12T23:30:00Z",
  name: "Ann",
  email: "ann@example.com",
  referral: "friend",
  interests: "tech",
  note: "hi",
  link: null,
  had_account: false,
  has_account: false,
  earlier_requests: 0,
  status: "pending",
  decided_at: null,
  invite_expires_at: null,
  invite_consumed_at: null,
  ...over,
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  mocks.rpc.mockReset();
  mocks.getUser.mockReset().mockResolvedValue({ data: { user: { id: "admin-1" } } });
  // Tokyo has had one fixed offset (UTC+9) for decades, so the expected date
  // does not depend on which tz database the machine running the test has.
  mocks.getUserTimeZone.mockReset().mockResolvedValue("Asia/Tokyo");
  mocks.createClient.mockReset().mockImplementation(async () => ({ rpc: mocks.rpc, auth: { getUser: mocks.getUser } }));
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
});

async function renderPage() {
  const tree = (await AdminRequestsPage()) as ReactElement;
  await act(async () => root.render(tree));
}

describe("/admin/requests", () => {
  it("sends a signed-out visitor to /login before asking the database anything", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null } });
    await expect(AdminRequestsPage()).rejects.toThrow("REDIRECT:/login");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("is a 404 for a reader who is not an admin", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "not_admin" } });
    await expect(AdminRequestsPage()).rejects.toThrow("NOT_FOUND");
  });

  it("says it couldn't load on any other error, and shows no rows", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "boom" } });
    await renderPage();
    expect(container.textContent).toContain("Couldn't load the requests");
    expect(container.querySelector("article")).toBeNull();
  });

  it("says it couldn't load when a row has the wrong shape", async () => {
    mocks.rpc.mockResolvedValue({ data: [row({ status: "weird" })], error: null });
    await renderPage();
    expect(container.textContent).toContain("Couldn't load the requests");
  });

  it("lists rows in the database's order, counts the pending ones, and shows times in the admin's zone", async () => {
    mocks.rpc.mockResolvedValue({
      data: [
        row({ id: "11111111-1111-4111-8111-111111111111", name: "Newest" }),
        row({ id: "22222222-2222-4222-8222-222222222222", name: "Older", status: "declined", decided_at: "2026-10-12T00:00:00Z" }),
      ],
      error: null,
    });
    await renderPage();
    expect(mocks.rpc).toHaveBeenCalledWith("list_invite_requests");
    expect([...container.querySelectorAll("article h2")].map((h) => h.textContent)).toEqual([
      expect.stringContaining("Newest"),
      expect.stringContaining("Older"),
    ]);
    expect(container.textContent).toContain("1 pending.");
    // 23:30 UTC on Oct 12 is 08:30 on Oct 13 in Tokyo (UTC+9).
    expect(container.textContent).toContain("Oct 13, 2026");
  });

  it("keeps an approved card's one-time link when the refresh moves it below a pending request", async () => {
    const link = "https://news.example.test/signup?invite=ONCE&email=ann%40example.com";
    vi.mocked(adminActions.approveRequest).mockResolvedValue({ code: "approved_unsent", link });
    const ann = row({ id: "11111111-1111-4111-8111-111111111111", name: "Ann", created_at: "2026-10-12T20:00:00Z" });
    const bea = row({ id: "22222222-2222-4222-8222-222222222222", name: "Bea", email: "bea@example.com", created_at: "2026-10-11T20:00:00Z" });
    mocks.rpc.mockResolvedValue({ data: [ann, bea], error: null });
    await renderPage();

    const card = (name: string) => [...container.querySelectorAll("article")].find((a) => a.querySelector("h2")!.textContent!.startsWith(name))!;
    await act(async () => card("Ann").querySelector("form")!.requestSubmit());
    await act(async () => new Promise((r) => setTimeout(r, 0)));
    expect((card("Ann").querySelector('input[aria-label="Invite link"]') as HTMLInputElement).value).toBe(link);

    // What list_invite_requests returns after the decision: pending first.
    mocks.rpc.mockResolvedValue({ data: [bea, { ...ann, status: "approved", decided_at: "2026-10-12T21:00:00Z" }], error: null });
    await renderPage();
    expect([...container.querySelectorAll("article h2")].map((h) => h.textContent!.split(" ")[0])).toEqual(["Bea", "Ann"]);
    expect((card("Ann").querySelector('input[aria-label="Invite link"]') as HTMLInputElement | null)?.value).toBe(link);
    expect(card("Bea").querySelector('input[aria-label="Invite link"]')).toBeNull();
    expect(card("Bea").querySelectorAll("button").length).toBe(2);
  });

  it("falls back to UTC for an invalid stored time zone", async () => {
    mocks.getUserTimeZone.mockResolvedValue("Not/AZone");
    mocks.rpc.mockResolvedValue({ data: [row()], error: null });
    await renderPage();
    expect(container.textContent).toContain("Oct 12, 2026");
  });

  it("says when there are none", async () => {
    mocks.rpc.mockResolvedValue({ data: [], error: null });
    await renderPage();
    expect(container.textContent).toContain("No requests yet.");
    expect(container.textContent).toContain("0 pending.");
  });
});

describe("inviteState", () => {
  const now = new Date("2026-10-13T00:00:00Z");
  it.each([
    [{ status: "pending" }, null],
    [{ status: "declined" }, null],
    [{ status: "approved", invite_consumed_at: "2026-10-12T00:00:00Z", invite_expires_at: "2026-10-01T00:00:00Z" }, "Signed up"],
    [{ status: "approved", invite_expires_at: null }, "Invite removed"],
    [{ status: "approved", invite_expires_at: "2026-10-13T00:00:00Z" }, "Invite expired unused"],
    [{ status: "approved", invite_expires_at: "2026-10-13T00:00:01Z" }, "Invite not used yet"],
  ])("%j → %s", (over, expected) => {
    expect(inviteState(row(over) as never, now)).toBe(expected);
  });
});

describe("loadPendingRequestCount", () => {
  const client = (rpc: unknown) => ({ rpc }) as never;
  it.each([
    [{ data: 4, error: null }, 4],
    [{ data: 0, error: null }, 0],
    [{ data: null, error: null }, null],
    [{ data: 3, error: { message: "x" } }, null],
    [{ data: -1, error: null }, null],
    [{ data: 1.5, error: null }, null],
    [{ data: "4", error: null }, null],
  ])("%j → %s", async (reply, expected) => {
    expect(await loadPendingRequestCount(client(vi.fn(async () => reply)))).toBe(expected);
  });

  it("never rejects, even when the client throws", async () => {
    await expect(loadPendingRequestCount(client(vi.fn(async () => Promise.reject(new Error("net")))))).resolves.toBeNull();
    await expect(
      loadPendingRequestCount(
        client(
          vi.fn(() => {
            throw new Error("sync");
          })
        )
      )
    ).resolves.toBeNull();
  });
});

describe("loadInviteRequests", () => {
  it("tells not_admin apart from a failure", async () => {
    const c = (reply: unknown) => ({ rpc: vi.fn(async () => reply) }) as never;
    expect(await loadInviteRequests(c({ data: null, error: { message: "not_admin" } }))).toEqual({ kind: "not_admin" });
    expect(await loadInviteRequests(c({ data: null, error: { message: "permission denied" } }))).toEqual({ kind: "failed" });
    expect(await loadInviteRequests(c({ data: null, error: null }))).toEqual({ kind: "failed" });
  });
});

describe("(paper) layout badge promise", () => {
  function findProp(node: ReactNode, prop: string): unknown {
    if (!isValidElement(node)) return undefined;
    const props = node.props as Record<string, unknown>;
    if (prop in props) return props[prop];
    for (const value of Object.values(props)) {
      const children = Array.isArray(value) ? value : [value];
      for (const child of children) {
        const found = findProp(child as ReactNode, prop);
        if (found !== undefined) return found;
      }
    }
    return undefined;
  }

  async function badgePromise() {
    const { default: PaperLayout } = await import("@/app/(paper)/layout");
    const tree = PaperLayout({ children: null });
    const p = findProp(tree, "pendingRequests");
    expect(p).toBeInstanceOf(Promise);
    return p as Promise<number | null>;
  }

  it("is not awaited by the layout: the layout returns synchronously", async () => {
    const { default: PaperLayout } = await import("@/app/(paper)/layout");
    mocks.createClient.mockImplementation(() => new Promise(() => {}));
    const tree = PaperLayout({ children: null });
    expect(tree).not.toBeInstanceOf(Promise);
  });

  it("resolves to the count for an admin", async () => {
    mocks.rpc.mockResolvedValue({ data: 2, error: null });
    await expect(badgePromise()).resolves.toBe(2);
    expect(mocks.rpc).toHaveBeenCalledWith("pending_invite_request_count");
  });

  it("resolves to null, never rejects, when the client cannot be created", async () => {
    mocks.createClient.mockImplementation(async () => {
      throw new Error("cookies() outside a request");
    });
    await expect(badgePromise()).resolves.toBeNull();
  });

  it("resolves to null when the RPC rejects", async () => {
    mocks.rpc.mockRejectedValue(new Error("network"));
    await expect(badgePromise()).resolves.toBeNull();
  });
});

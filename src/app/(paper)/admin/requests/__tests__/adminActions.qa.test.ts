import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Approve and decline as server actions, with the database and Resend
// mocked. The database is the gate; these pin what the action does with
// each answer, and that the raw token only ever leaves in the email (or,
// when the email fails, in the one result the admin sees).

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  revalidatePath: vi.fn(),
  log: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => ({ rpc: mocks.rpc })) }));
vi.mock("@/lib/bestEffortLog", () => ({ bestEffortLog: mocks.log }));

const { approveRequest, declineRequest } = await import("@/app/(paper)/admin/requests/actions");

const ID = "7d3c9a0e-4b7f-4c8e-9a51-1f2e3d4c5b6a";
const RESEND_URL = "https://api.resend.com/emails";
const NONE = { code: null };

let resendReply: () => Promise<Response>;
let fetchMock: ReturnType<typeof vi.fn>;

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

function fd(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

beforeEach(() => {
  mocks.rpc.mockReset();
  mocks.revalidatePath.mockReset();
  mocks.log.mockReset();
  resendReply = async () => new Response("{}", { status: 200 });
  fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    if (String(input) === RESEND_URL) return resendReply();
    throw new Error(`unexpected fetch ${String(input)}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubEnv("INVITE_BASE_URL", "https://news.example.test");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const sentEmails = () =>
  fetchMock.mock.calls.map(([, init]) => JSON.parse(String((init as RequestInit).body)) as { to: string[]; subject: string; text: string });

describe("approveRequest", () => {
  it.each([["missing", {}], ["not a uuid", { id: "1; drop table" }], ["empty", { id: "" }]])(
    "refuses a %s id without touching the database",
    async (_l, fields) => {
      expect(await approveRequest(NONE, fd(fields as Record<string, string>))).toEqual({ code: "failed" });
      expect(mocks.rpc).not.toHaveBeenCalled();
    }
  );

  it.each([
    ["not_admin", "failed"],
    ["not_pending", "not_pending"],
    ["has_account", "has_account"],
    ["bad_token_hash", "failed"],
    ["permission denied for function approve_invite_request", "failed"],
  ])("maps a database refusal %s to %s, with no refresh and no email", async (message, code) => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message } });
    expect(await approveRequest(NONE, fd({ id: ID }))).toEqual({ code });
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("passes only the token's hash to the database and emails the matching link", async () => {
    mocks.rpc.mockResolvedValue({ data: [{ email: "ann@example.com", name: "Ann", expires_at: "2026-10-20T00:00:00Z" }], error: null });
    const result = await approveRequest(NONE, fd({ id: ID }));
    expect(result).toEqual({ code: "approved" });

    const [fn, args] = mocks.rpc.mock.calls[0];
    expect(fn).toBe("approve_invite_request");
    expect(args.p_id).toBe(ID);
    expect(args.p_token_hash).toMatch(/^[0-9a-f]{64}$/);

    const [email] = sentEmails();
    expect(email.to).toEqual(["ann@example.com"]);
    const link = email.text.match(/https:\/\/news\.example\.test\/signup\?\S+/)![0];
    const url = new URL(link);
    const token = url.searchParams.get("invite")!;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get("email")).toBe("ann@example.com");
    expect(sha(token)).toBe(args.p_token_hash);
    // The raw token never reached the database call.
    expect(JSON.stringify(args)).not.toContain(token);
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/", "layout");
  });

  it("mints a fresh token on every approval", async () => {
    mocks.rpc.mockResolvedValue({ data: [{ email: "a@x.com", name: "A" }], error: null });
    await approveRequest(NONE, fd({ id: ID }));
    await approveRequest(NONE, fd({ id: ID }));
    const [h1, h2] = mocks.rpc.mock.calls.map(([, a]) => a.p_token_hash);
    expect(h1).not.toBe(h2);
  });

  it.each([
    ["rejected", async () => new Response("no", { status: 403 })],
    ["network", async () => Promise.reject(new TypeError("fetch failed"))],
  ])("shows the admin the link once when the email is %s", async (reason, reply) => {
    resendReply = reply as () => Promise<Response>;
    mocks.rpc.mockResolvedValue({ data: [{ email: "ann@example.com", name: "Ann" }], error: null });
    const result = await approveRequest(NONE, fd({ id: ID }));
    expect(result.code).toBe("approved_unsent");
    const token = new URL(result.link!).searchParams.get("invite")!;
    expect(sha(token)).toBe(mocks.rpc.mock.calls[0][1].p_token_hash);
    expect(mocks.log).toHaveBeenCalledWith("warn", "[admin-requests] invite email not sent", reason);
    expect(JSON.stringify(mocks.log.mock.calls)).not.toContain(token);
  });

  it("shows the link when Resend is not configured", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    mocks.rpc.mockResolvedValue({ data: [{ email: "ann@example.com", name: "Ann" }], error: null });
    const result = await approveRequest(NONE, fd({ id: ID }));
    expect(result.code).toBe("approved_unsent");
    expect(result.link).toContain("/signup?invite=");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([[[]], [null], [[{ email: "", name: "A" }]], [[{ email: "a@x.com", name: "A" }, { email: "b@x.com", name: "B" }]]])(
    "reports unknown (still refreshing) on an unexpected result %j, and sends nothing",
    async (data) => {
      mocks.rpc.mockResolvedValue({ data, error: null });
      expect(await approveRequest(NONE, fd({ id: ID }))).toEqual({ code: "unknown" });
      expect(mocks.revalidatePath).toHaveBeenCalledWith("/", "layout");
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );
});

describe("declineRequest", () => {
  it("refuses a bad id without touching the database", async () => {
    expect(await declineRequest(NONE, fd({ id: "nope" }))).toEqual({ code: "failed" });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it.each([
    ["not_admin", "failed"],
    ["not_pending", "not_pending"],
  ])("maps %s to %s", async (message, code) => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message } });
    expect(await declineRequest(NONE, fd({ id: ID, notify: "on" }))).toEqual({ code });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("declines silently unless the box is ticked", async () => {
    mocks.rpc.mockResolvedValue({ data: [{ email: "ann@example.com", name: "Ann" }], error: null });
    expect(await declineRequest(NONE, fd({ id: ID }))).toEqual({ code: "declined" });
    expect(mocks.rpc).toHaveBeenCalledWith("decline_invite_request", { p_id: ID });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/", "layout");
  });

  it("emails a polite decline carrying none of the requester's words", async () => {
    mocks.rpc.mockResolvedValue({ data: [{ email: "ann@example.com", name: "<b>Evil</b> Name" }], error: null });
    expect(await declineRequest(NONE, fd({ id: ID, notify: "on" }))).toEqual({ code: "declined_emailed" });
    const [email] = sentEmails();
    expect(email.to).toEqual(["ann@example.com"]);
    expect(email.text).not.toContain("Evil");
    expect(email.subject).not.toContain("Evil");
  });

  it("reports a failed decline email without undoing the decline", async () => {
    resendReply = async () => new Response("no", { status: 500 });
    mocks.rpc.mockResolvedValue({ data: [{ email: "ann@example.com", name: "Ann" }], error: null });
    expect(await declineRequest(NONE, fd({ id: ID, notify: "on" }))).toEqual({ code: "declined_unsent" });
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });

  it("treats any notify value other than 'on' as unticked", async () => {
    mocks.rpc.mockResolvedValue({ data: [{ email: "ann@example.com", name: "Ann" }], error: null });
    expect(await declineRequest(NONE, fd({ id: ID, notify: "true" }))).toEqual({ code: "declined" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

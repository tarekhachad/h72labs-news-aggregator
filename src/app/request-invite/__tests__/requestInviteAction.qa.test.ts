import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The /request-invite server action end to end, with the network and the
// database mocked: fields, then Turnstile (fail closed), then the RPC with
// the server key, and the admin notice only for a new request, after the
// response.

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  headers: new Headers(),
  afterCallbacks: [] as Array<() => unknown>,
  log: vi.fn(),
}));

vi.mock("next/headers", () => ({ headers: vi.fn(async () => mocks.headers) }));
vi.mock("next/server", () => ({
  after: vi.fn((cb: () => unknown) => {
    mocks.afterCallbacks.push(cb);
  }),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => ({ rpc: mocks.rpc })) }));
vi.mock("@/lib/bestEffortLog", () => ({ bestEffortLog: mocks.log }));

const { requestInvite } = await import("@/app/request-invite/actions");
const { REQUEST_ERROR_MESSAGES } = await import("@/lib/inviteRequest");

const SERVER_KEY = "k".repeat(40);
const TURNSTILE_SECRET = "turnstile-secret";
const TURNSTILE_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const RESEND_URL = "https://api.resend.com/emails";

type FetchCall = { url: string; init: RequestInit | undefined };
let fetchCalls: FetchCall[];
let turnstileReply: () => Promise<Response>;
let resendReply: () => Promise<Response>;

function form(overrides: Record<string, string | null> = {}): FormData {
  const fd = new FormData();
  const base: Record<string, string | null> = {
    name: "  Ann \n  Lee ",
    email: "  Ann@Example.COM ",
    referral: "A friend",
    interests: "Morocco, tech",
    note: "Curious",
    link: "",
    "cf-turnstile-response": "tok-123",
    ...overrides,
  };
  for (const [k, v] of Object.entries(base)) if (v !== null) fd.set(k, v);
  return fd;
}

const IDLE = { status: "idle" } as const;

beforeEach(() => {
  mocks.rpc.mockReset();
  mocks.rpc.mockResolvedValue({ data: "created", error: null });
  mocks.headers = new Headers({ "x-real-ip": "203.0.113.9", "x-forwarded-for": "198.51.100.1, 10.0.0.1" });
  mocks.afterCallbacks.length = 0;
  mocks.log.mockReset();
  fetchCalls = [];
  turnstileReply = async () => new Response(JSON.stringify({ success: true }), { status: 200 });
  resendReply = async () => new Response("{}", { status: 200 });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      fetchCalls.push({ url, init });
      if (url === TURNSTILE_URL) return turnstileReply();
      if (url === RESEND_URL) return resendReply();
      throw new Error(`unexpected fetch ${url}`);
    })
  );
  vi.stubEnv("INVITE_REQUEST_SECRET", SERVER_KEY);
  vi.stubEnv("TURNSTILE_SECRET_KEY", TURNSTILE_SECRET);
  vi.stubEnv("ADMIN_NOTIFY_EMAIL", "admin@h72labs.com");
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubEnv("INVITE_BASE_URL", "https://news.example.test");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const turnstileCalls = () => fetchCalls.filter((c) => c.url === TURNSTILE_URL);
const resendCalls = () => fetchCalls.filter((c) => c.url === RESEND_URL);

describe("requestInvite — refusals before the database", () => {
  it("refuses invalid fields without calling Turnstile or the database, and echoes what was typed", async () => {
    const fd = form({ email: "not-an-email", note: "   ", link: "javascript:alert(1)" });
    const state = await requestInvite(IDLE, fd);
    expect(state.status).toBe("error");
    if (state.status !== "error") return;
    expect(state.code).toBe("invalid");
    expect(Object.keys(state.fieldErrors).sort()).toEqual(["email", "link", "note"]);
    expect(state.values.email).toBe("not-an-email");
    expect(state.values.name).toBe("  Ann \n  Lee ");
    expect(fetchCalls).toHaveLength(0);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("turns a NUL character into a field error, not 'unavailable', without Turnstile or the database", async () => {
    const state = await requestInvite(IDLE, form({ note: "Curious\u0000", link: "https://ann.example/\u0000x" }));
    expect(state).toMatchObject({ status: "error", code: "invalid" });
    if (state.status !== "error") return;
    expect(Object.keys(state.fieldErrors).sort()).toEqual(["link", "note"]);
    expect(state.fieldErrors.note).toBe("Remove the unusual character from this field.");
    expect(fetchCalls).toHaveLength(0);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("reports only the first message per field", async () => {
    const state = await requestInvite(IDLE, form({ email: "" }));
    if (state.status !== "error") throw new Error("expected error");
    expect(typeof state.fieldErrors.email).toBe("string");
  });

  it("is unavailable when the server key is missing", async () => {
    vi.stubEnv("INVITE_REQUEST_SECRET", "");
    const state = await requestInvite(IDLE, form());
    expect(state).toMatchObject({ status: "error", code: "unavailable" });
    expect(fetchCalls).toHaveLength(0);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("is unavailable when the server key is shorter than 32 characters", async () => {
    vi.stubEnv("INVITE_REQUEST_SECRET", "k".repeat(31));
    const state = await requestInvite(IDLE, form());
    expect(state).toMatchObject({ status: "error", code: "unavailable" });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("is unavailable when the Turnstile secret is missing", async () => {
    vi.stubEnv("TURNSTILE_SECRET_KEY", "");
    const state = await requestInvite(IDLE, form());
    expect(state).toMatchObject({ status: "error", code: "unavailable" });
    expect(fetchCalls).toHaveLength(0);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("refuses a missing Turnstile token without a network call or the database", async () => {
    const state = await requestInvite(IDLE, form({ "cf-turnstile-response": null }));
    expect(state).toMatchObject({ status: "error", code: "bot_check" });
    expect(fetchCalls).toHaveLength(0);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it.each([
    ["success false", async () => new Response(JSON.stringify({ success: false }), { status: 200 })],
    ["success as the string 'true'", async () => new Response(JSON.stringify({ success: "true" }), { status: 200 })],
    ["HTTP 500", async () => new Response(JSON.stringify({ success: true }), { status: 500 })],
    ["non-JSON body", async () => new Response("<html>", { status: 200 })],
    ["network error", async () => Promise.reject(new TypeError("fetch failed"))],
  ])("fails closed on Turnstile %s", async (_label, reply) => {
    turnstileReply = reply as () => Promise<Response>;
    const state = await requestInvite(IDLE, form());
    expect(state).toMatchObject({ status: "error", code: "bot_check" });
    expect(mocks.rpc).not.toHaveBeenCalled();
    if (state.status === "error") expect(state.values.referral).toBe("A friend");
  });
});

describe("requestInvite — the database call", () => {
  it("sends Turnstile the secret, token and visitor IP, then calls the RPC with the server key and a keyed source hash", async () => {
    const state = await requestInvite(IDLE, form({ link: " https://linkedin.com/in/ann " }));
    expect(state).toEqual({ status: "sent" });

    const [verify] = turnstileCalls();
    const body = new URLSearchParams(String(verify.init?.body));
    expect(body.get("secret")).toBe(TURNSTILE_SECRET);
    expect(body.get("response")).toBe("tok-123");
    expect(body.get("remoteip")).toBe("203.0.113.9");

    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    const [fn, args] = mocks.rpc.mock.calls[0];
    expect(fn).toBe("submit_invite_request");
    const expectedSource = createHmac("sha256", SERVER_KEY).update("invite-request-source:203.0.113.9", "utf8").digest("hex");
    expect(args).toEqual({
      p_server_key: SERVER_KEY,
      p_source_hash: expectedSource,
      p_name: "Ann Lee",
      p_email: "ann@example.com",
      p_referral: "A friend",
      p_interests: "Morocco, tech",
      p_note: "Curious",
      p_link: "https://linkedin.com/in/ann",
    });
    // No raw IP reaches the database.
    expect(JSON.stringify(args)).not.toContain("203.0.113.9");
  });

  it("falls back to the first x-forwarded-for entry, and sends a null source without any IP", async () => {
    mocks.headers = new Headers({ "x-forwarded-for": " 198.51.100.1 , 10.0.0.1" });
    await requestInvite(IDLE, form());
    expect(mocks.rpc.mock.calls[0][1].p_source_hash).toBe(
      createHmac("sha256", SERVER_KEY).update("invite-request-source:198.51.100.1", "utf8").digest("hex")
    );

    mocks.rpc.mockClear();
    fetchCalls = [];
    mocks.headers = new Headers();
    await requestInvite(IDLE, form());
    expect(mocks.rpc.mock.calls[0][1].p_source_hash).toBeNull();
    expect(new URLSearchParams(String(turnstileCalls()[0].init?.body)).has("remoteip")).toBe(false);
  });

  it("answers a duplicate exactly like a new request", async () => {
    const created = await requestInvite(IDLE, form());
    mocks.rpc.mockResolvedValue({ data: "duplicate", error: null });
    const duplicate = await requestInvite(IDLE, form());
    expect(duplicate).toEqual(created);
    expect(duplicate).toEqual({ status: "sent" });
  });

  it.each(["closed", "rate_limited"])("reports %s as closed, keeping what was typed", async (outcome) => {
    mocks.rpc.mockResolvedValue({ data: outcome, error: null });
    const state = await requestInvite(IDLE, form());
    expect(state).toMatchObject({ status: "error", code: "closed", fieldErrors: {} });
    if (state.status === "error") expect(state.values.note).toBe("Curious");
    expect(REQUEST_ERROR_MESSAGES.closed).toMatch(/not taking more requests/);
    expect(mocks.afterCallbacks).toHaveLength(0);
  });

  it("is unavailable on an RPC error (e.g. the key is refused) and logs only the code", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "42501", message: "forbidden" } });
    const state = await requestInvite(IDLE, form());
    expect(state).toMatchObject({ status: "error", code: "unavailable" });
    expect(mocks.log).toHaveBeenCalledWith("error", "[invite-request] submit failed", "42501");
    // The key never lands in a log line.
    expect(JSON.stringify(mocks.log.mock.calls)).not.toContain(SERVER_KEY);
  });

  it.each([null, "CREATED", 1, { outcome: "created" }])("is unavailable on an unexpected RPC result %j", async (data) => {
    mocks.rpc.mockResolvedValue({ data, error: null });
    const state = await requestInvite(IDLE, form());
    expect(state).toMatchObject({ status: "error", code: "unavailable" });
    expect(mocks.afterCallbacks).toHaveLength(0);
  });
});

describe("requestInvite — the admin notice", () => {
  it("is scheduled after the response only for a new request, and sends a plain-text notice to the admin", async () => {
    const state = await requestInvite(IDLE, form({ link: "https://ann.example" }));
    expect(state).toEqual({ status: "sent" });
    // Nothing sent yet: the response does not wait on Resend.
    expect(resendCalls()).toHaveLength(0);
    expect(mocks.afterCallbacks).toHaveLength(1);

    await mocks.afterCallbacks[0]();
    const [send] = resendCalls();
    const payload = JSON.parse(String(send.init?.body));
    expect(payload.to).toEqual(["admin@h72labs.com"]);
    expect(payload.subject).toBe("Invite request from Ann Lee");
    expect(payload.text).toContain("ann@example.com");
    expect(payload.text).toContain("https://news.example.test/admin/requests");
    expect(payload.text).toContain("Link they gave (unchecked): https://ann.example");
    expect(payload.html).toBeUndefined();
  });

  it("is not scheduled for a duplicate", async () => {
    mocks.rpc.mockResolvedValue({ data: "duplicate", error: null });
    await requestInvite(IDLE, form());
    expect(mocks.afterCallbacks).toHaveLength(0);
    expect(resendCalls()).toHaveLength(0);
  });

  it("is not scheduled without ADMIN_NOTIFY_EMAIL", async () => {
    vi.stubEnv("ADMIN_NOTIFY_EMAIL", "");
    const state = await requestInvite(IDLE, form());
    expect(state).toEqual({ status: "sent" });
    expect(mocks.afterCallbacks).toHaveLength(0);
  });

  it("a failed send is logged, never thrown", async () => {
    resendReply = async () => new Response("no", { status: 422 });
    await requestInvite(IDLE, form());
    await expect(Promise.resolve(mocks.afterCallbacks[0]())).resolves.toBeUndefined();
    expect(mocks.log).toHaveBeenCalledWith("warn", "[invite-request] notice not sent", "rejected");
  });

  it("the response does not wait for a send that never finishes", async () => {
    resendReply = () => new Promise<Response>(() => {});
    const state = await requestInvite(IDLE, form());
    expect(state).toEqual({ status: "sent" });
  });
});

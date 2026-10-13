import { afterEach, describe, expect, it, vi } from "vitest";
import {
  InviteRequestFields,
  MIN_SERVER_KEY_LENGTH,
  adminErrorCode,
  clientIp,
  hashServerKey,
  inviteRequestEnv,
  outcomeToState,
  readRequestForm,
  sourceHash,
  verifyTurnstile,
} from "@/lib/inviteRequest";

const valid = {
  name: "  Ann   Lee ",
  email: " Ann@Example.COM ",
  referral: "Tarek",
  interests: "Morocco, energy",
  note: "I read the news every morning.",
  link: "",
};

describe("InviteRequestFields", () => {
  it("trims, lowercases the email and keeps the name on one line", () => {
    const parsed = InviteRequestFields.parse({ ...valid, name: "Ann\r\nSubject: hi" });
    expect(parsed.email).toBe("ann@example.com");
    expect(parsed.name).toBe("Ann Subject: hi");
    expect(InviteRequestFields.parse(valid).name).toBe("Ann Lee");
  });

  it.each(["name", "referral", "interests", "note"] as const)("requires %s", (field) => {
    expect(InviteRequestFields.safeParse({ ...valid, [field]: "   " }).success).toBe(false);
  });

  it("accepts only http(s) links, and none at all", () => {
    expect(InviteRequestFields.safeParse({ ...valid, link: "https://linkedin.com/in/ann" }).success).toBe(true);
    expect(InviteRequestFields.safeParse({ ...valid, link: "" }).success).toBe(true);
    for (const link of ["javascript:alert(1)", "linkedin.com/in/ann", "data:text/html,x", "ftp://x.com"]) {
      expect(InviteRequestFields.safeParse({ ...valid, link }).success, link).toBe(false);
    }
  });

  it("enforces the same lengths as the table", () => {
    expect(InviteRequestFields.safeParse({ ...valid, note: "x".repeat(1001) }).success).toBe(false);
    expect(InviteRequestFields.safeParse({ ...valid, note: "x".repeat(1000) }).success).toBe(true);
    expect(InviteRequestFields.safeParse({ ...valid, name: "x".repeat(101) }).success).toBe(false);
  });

  // Postgres text cannot store U+0000: without this the insert fails and the
  // visitor sees "requests aren't open" instead of a field error.
  it.each(["name", "referral", "interests", "note", "link", "email"] as const)("refuses a NUL character in %s as a field error", (field) => {
    const value = field === "link" ? "https://ann.example/\u0000" : field === "email" ? "ann\u0000@example.com" : "Ann\u0000Lee";
    const parsed = InviteRequestFields.safeParse({ ...valid, [field]: value });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues.map((i) => i.path[0])).toEqual([field]);
  });

  it("refuses a NUL even where trimming would otherwise remove it, and accepts a field without one", () => {
    // A bare NUL survives trim (it is not whitespace), so it must hit the refine, not min(1).
    const parsed = InviteRequestFields.safeParse({ ...valid, note: "\u0000" });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues[0].message).toBe("Remove the unusual character from this field.");
    expect(InviteRequestFields.safeParse({ ...valid, note: "tab\there, é, 中文, 🙂" }).success).toBe(true);
  });
});

describe("readRequestForm", () => {
  it("returns every field as a string, empty for missing or file values", () => {
    const form = new FormData();
    form.set("name", "Ann");
    form.set("note", new Blob(["x"]));
    expect(readRequestForm(form)).toEqual({ name: "Ann", email: "", referral: "", interests: "", note: "", link: "" });
  });
});

describe("outcomeToState", () => {
  const values = readRequestForm(new FormData());

  it("reports a duplicate exactly like a new request", () => {
    expect(outcomeToState("duplicate", values)).toEqual(outcomeToState("created", values));
  });

  it("reports both caps as closed", () => {
    expect(outcomeToState("closed", values)).toEqual(outcomeToState("rate_limited", values));
    expect(outcomeToState("closed", values)).toMatchObject({ status: "error", code: "closed" });
  });
});

describe("hashServerKey", () => {
  it("matches the database's encode(sha256(convert_to(key, 'UTF8')), 'hex')", () => {
    expect(hashServerKey("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("sourceHash", () => {
  it("is keyed, stable, and the table's shape", () => {
    const a = sourceHash("203.0.113.7", "k1");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(sourceHash("203.0.113.7", "k1")).toBe(a);
    expect(sourceHash("203.0.113.7", "k2")).not.toBe(a);
    expect(sourceHash("203.0.113.8", "k1")).not.toBe(a);
  });

  it("is null without an IP", () => {
    expect(sourceHash(null, "k1")).toBeNull();
  });
});

describe("clientIp", () => {
  it("prefers x-real-ip, then the first x-forwarded-for entry", () => {
    expect(clientIp(new Headers({ "x-real-ip": "1.1.1.1", "x-forwarded-for": "2.2.2.2" }))).toBe("1.1.1.1");
    expect(clientIp(new Headers({ "x-forwarded-for": " 2.2.2.2 , 3.3.3.3" }))).toBe("2.2.2.2");
    expect(clientIp(new Headers())).toBeNull();
  });
});

describe("inviteRequestEnv", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("needs a long server key and a Turnstile secret", () => {
    vi.stubEnv("TURNSTILE_SECRET_KEY", "t");
    vi.stubEnv("INVITE_REQUEST_SECRET", "x".repeat(MIN_SERVER_KEY_LENGTH - 1));
    expect(inviteRequestEnv()).toBeNull();
    vi.stubEnv("INVITE_REQUEST_SECRET", "x".repeat(MIN_SERVER_KEY_LENGTH));
    expect(inviteRequestEnv()).toEqual({ serverKey: "x".repeat(MIN_SERVER_KEY_LENGTH), turnstileSecret: "t" });
    vi.stubEnv("TURNSTILE_SECRET_KEY", "");
    expect(inviteRequestEnv()).toBeNull();
  });
});

describe("verifyTurnstile", () => {
  const reply = (body: unknown, ok = true) => vi.fn(async () => ({ ok, json: async () => body }) as Response);

  it("passes only on an explicit success, and sends the secret, token and IP", async () => {
    const fetchImpl = reply({ success: true });
    expect(await verifyTurnstile("tok", "sec", "1.2.3.4", fetchImpl)).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://challenges.cloudflare.com/turnstile/v0/siteverify");
    const body = init.body as URLSearchParams;
    expect(body.get("secret")).toBe("sec");
    expect(body.get("response")).toBe("tok");
    expect(body.get("remoteip")).toBe("1.2.3.4");
  });

  it("fails closed", async () => {
    expect(await verifyTurnstile("tok", "sec", null, reply({ success: false }))).toBe(false);
    expect(await verifyTurnstile("tok", "sec", null, reply({ success: "true" }))).toBe(false);
    expect(await verifyTurnstile("tok", "sec", null, reply({ success: true }, false))).toBe(false);
    expect(await verifyTurnstile("tok", "sec", null, reply(null))).toBe(false);
    const throws = vi.fn(async () => {
      throw new Error("network");
    });
    expect(await verifyTurnstile("tok", "sec", null, throws)).toBe(false);
  });

  it("refuses a missing, non-string or oversized token without a call", async () => {
    const fetchImpl = reply({ success: true });
    for (const token of [null, "", new Blob(["x"]), "x".repeat(2049)]) {
      expect(await verifyTurnstile(token, "sec", null, fetchImpl)).toBe(false);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("adminErrorCode", () => {
  it("passes through the two codes the functions raise for the admin, and hides the rest", () => {
    expect(adminErrorCode("not_pending")).toBe("not_pending");
    expect(adminErrorCode("has_account")).toBe("has_account");
    expect(adminErrorCode("not_admin")).toBe("failed");
    expect(adminErrorCode(undefined)).toBe("failed");
  });
});

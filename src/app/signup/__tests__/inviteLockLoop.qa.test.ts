// QA (wave 9, A1): the signup page and the signUp action driven against each
// other the way a browser would. Each step renders /signup from a URL, reads
// the form it produced, submits what a reader can submit, and follows the
// action's redirect back to /signup. Auth is a stub standing in for the hook's
// answer; what the hook actually enforces is pinned separately.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

class RedirectSignal extends Error {
  constructor(public url: string) {
    super(`NEXT_REDIRECT:${url}`);
  }
}
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new RedirectSignal(url);
  }),
}));

const signUpMock = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ auth: { signUp: signUpMock } })),
}));
vi.mock("next/headers", () => ({ cookies: vi.fn(async () => ({ get: () => undefined, delete: vi.fn() })) }));

const { default: SignupPage } = await import("@/app/signup/page");
const { signUp } = await import("@/app/auth/actions");

const TOKEN = "Ab_-".repeat(10) + "xyz";
const INVITE_FOR = "invitee+pna@example.com";

// Next hands a page one string per key, or an array when the key repeats.
function nextSearchParams(url: string): Record<string, string | string[]> {
  const sp = new URL(url, "https://news.h72labs.com").searchParams;
  const out: Record<string, string | string[]> = {};
  for (const key of new Set(sp.keys())) {
    const all = sp.getAll(key);
    out[key] = all.length === 1 ? all[0] : all;
  }
  return out;
}

async function renderAt(url: string): Promise<string> {
  const params = nextSearchParams(url) as { error?: string; invite?: string; email?: string };
  return renderToStaticMarkup(await SignupPage({ searchParams: Promise.resolve(params) }));
}

const decode = (s: string) =>
  s.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const attr = (tag: string, name: string) => {
  const m = tag.match(new RegExp(`\\s${name}="([^"]*)"`));
  return m ? decode(m[1]) : undefined;
};
const inputNamed = (html: string, name: string) => html.match(new RegExp(`<input[^>]*name="${name}"[^>]*>`))?.[0];

type Page = { html: string; locked: boolean; lockedTo?: string; hasForm: boolean };
function read(html: string): Page {
  const email = inputNamed(html, "email");
  const locked = !!email && /\sreadOnly=""/.test(email);
  return { html, locked, lockedTo: locked ? attr(email!, "value") : undefined, hasForm: html.includes("<form") };
}

// What a reader can submit from this page: the readOnly field's value when
// locked (typed text is ignored), else whatever they type.
function submission(html: string, typed: string, password: string): FormData {
  const fd = new FormData();
  for (const name of ["invite", "invitedEmail"]) {
    const tag = inputNamed(html, name);
    if (tag) fd.set(name, attr(tag, "value") ?? "");
  }
  const email = inputNamed(html, "email")!;
  fd.set("email", /\sreadOnly=""/.test(email) ? attr(email, "value")! : typed);
  fd.set("password", password);
  return fd;
}

async function submit(fd: FormData): Promise<string> {
  try {
    await signUp(fd);
  } catch (e) {
    if (e instanceof RedirectSignal) return e.url;
    throw e;
  }
  throw new Error("signUp did not redirect");
}

// The hook's rule, as a stub: right token + right address creates the user.
function hookAccepts(address: string) {
  signUpMock.mockImplementation(async ({ email }: { email: string }) =>
    email.toLowerCase() === address
      ? { data: { session: null }, error: null }
      : { data: null, error: { message: "invite_email_mismatch" } }
  );
}

beforeEach(() => {
  signUpMock.mockReset();
});

describe("the lock never traps a reader", () => {
  it("a link tampered to another address: locked, refused as a mismatch, unlocked, then the real address goes through", async () => {
    hookAccepts(INVITE_FOR);
    let page = read(await renderAt(`/signup?invite=${TOKEN}&email=${encodeURIComponent("attacker@evil.example")}`));
    expect(page.lockedTo).toBe("attacker@evil.example");

    let url = await submit(submission(page.html, "ignored@x.co", "secret1"));
    expect(signUpMock).toHaveBeenLastCalledWith(expect.objectContaining({ email: "attacker@evil.example" }));
    expect(url).toBe(`/signup?invite=${TOKEN}&error=invite_email_mismatch`);

    page = read(await renderAt(url));
    expect(page.locked).toBe(false);
    expect(page.html).not.toContain("attacker@evil.example");
    expect(page.html).not.toContain("invitedEmail");

    // A second wrong typed address stays editable too.
    url = await submit(submission(page.html, "still-wrong@x.co", "secret1"));
    expect(read(await renderAt(url)).locked).toBe(false);

    url = await submit(submission(page.html, INVITE_FOR, "secret1"));
    expect(url).toBe(`/signup/check-email?email=${encodeURIComponent(INVITE_FOR)}`);
  });

  it("a + address survives three weak-password round trips byte for byte", async () => {
    hookAccepts(INVITE_FOR);
    let url = `/signup?invite=${TOKEN}&email=${encodeURIComponent(INVITE_FOR)}`;
    for (let i = 0; i < 3; i++) {
      const page = read(await renderAt(url));
      expect(page.lockedTo).toBe(INVITE_FOR);
      url = await submit(submission(page.html, "", "12345"));
      expect(nextSearchParams(url)).toEqual({ invite: TOKEN, email: INVITE_FOR, error: "weak_password" });
    }
    expect(signUpMock).not.toHaveBeenCalled();
    const page = read(await renderAt(url));
    expect(await submit(submission(page.html, "", "secret1"))).toBe(
      `/signup/check-email?email=${encodeURIComponent(INVITE_FOR)}`
    );
  });

  it("an uppercase link locks to the lowercase address, which the hook matches", async () => {
    hookAccepts(INVITE_FOR);
    const page = read(await renderAt(`/signup?invite=${TOKEN}&email=${encodeURIComponent("Invitee+PNA@Example.COM")}`));
    expect(page.lockedTo).toBe(INVITE_FOR);
    expect(await submit(submission(page.html, "", "secret1"))).toMatch(/^\/signup\/check-email/);
  });

  it.each(["invite_invalid", "invite_required", "Database error saving new user"])(
    "a %s refusal keeps the lock and the token, and shows a message",
    async (message) => {
      signUpMock.mockResolvedValue({ data: null, error: { message } });
      const page = read(await renderAt(`/signup?invite=${TOKEN}&email=${encodeURIComponent(INVITE_FOR)}`));
      const back = read(await renderAt(await submit(submission(page.html, "", "secret1"))));
      expect(back.lockedTo).toBe(INVITE_FOR);
      expect(back.html).toMatch(/text-sm" style="color:var\(--color-destructive\)">[^<]+</);
    }
  );

  it("devtools-editing the hidden invitedEmail to garbage only drops the lock on the way back", async () => {
    signUpMock.mockResolvedValue({ data: null, error: { message: "invite_invalid" } });
    const page = read(await renderAt(`/signup?invite=${TOKEN}&email=${encodeURIComponent(INVITE_FOR)}`));
    const fd = submission(page.html, "", "secret1");
    fd.set("invitedEmail", '"><script>alert(1)</script>');
    const url = await submit(fd);
    expect(url).toBe(`/signup?invite=${TOKEN}&error=invite_invalid`);
  });
});

describe("odd links on /signup", () => {
  it.each([
    ["a raw + typed into a hand-made link decodes to a space, so the field stays editable", `email=a+b@example.com`, false],
    ["a repeated email key", `email=a@example.com&email=b@example.com`, false],
    ["an email key with no value", `email`, false],
    ["markup", `email=${encodeURIComponent('"><script>alert(1)</script>@x.co')}`, false],
    ["an IDN address", `email=${encodeURIComponent("reader@exämple.com")}`, false],
    ["a quoted local part", `email=${encodeURIComponent('"a b"@example.com')}`, false],
    ["percent-encoded uppercase", `email=READER%40EXAMPLE.COM`, true],
  ])("%s", async (_, query, locks) => {
    const page = read(await renderAt(`/signup?invite=${TOKEN}&${query}`));
    expect(page.hasForm).toBe(true);
    expect(page.locked).toBe(locks);
    expect(page.html).not.toContain("alert(1)");
    if (!locks) {
      expect(inputNamed(page.html, "email")).toContain('placeholder="Email"');
      expect(page.html).not.toContain("invitedEmail");
    } else {
      expect(page.lockedTo).toBe("reader@example.com");
    }
  });

  it("254 characters locks, 255 does not", async () => {
    const at254 = `${"a".repeat(64)}@${"b".repeat(60)}.${"c".repeat(60)}.${"d".repeat(60)}.${"e".repeat(2)}.com`;
    const at255 = `${"a".repeat(64)}@${"b".repeat(60)}.${"c".repeat(60)}.${"d".repeat(60)}.${"e".repeat(3)}.com`;
    expect([at254.length, at255.length]).toEqual([254, 255]);
    expect(read(await renderAt(`/signup?invite=${TOKEN}&email=${encodeURIComponent(at254)}`)).lockedTo).toBe(at254);
    expect(read(await renderAt(`/signup?invite=${TOKEN}&email=${encodeURIComponent(at255)}`)).locked).toBe(false);
  });

  it("a repeated invite key shows no form, and never the address", async () => {
    const page = read(await renderAt(`/signup?invite=${TOKEN}&invite=${TOKEN}&email=reader%40example.com`));
    expect(page.hasForm).toBe(false);
    expect(page.html).not.toContain("reader@example.com");
  });

  it("an old link without email keeps working with an editable field", async () => {
    hookAccepts(INVITE_FOR);
    const page = read(await renderAt(`/signup?invite=${TOKEN}`));
    expect(page.locked).toBe(false);
    const url = await submit(submission(page.html, "Invitee+PNA@example.com", "secret1"));
    expect(url).toMatch(/^\/signup\/check-email/);
  });
});

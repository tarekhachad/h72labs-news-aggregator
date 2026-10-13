// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";

// The /request-invite form with the real Turnstile wrapper and a stub of
// Cloudflare's widget API: what the visitor sees for each outcome, that a
// refusal keeps what was typed, and that every submission gets a fresh
// bot-check token.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({ requestInvite: vi.fn() }));
vi.mock("@/app/request-invite/actions", () => ({ requestInvite: mocks.requestInvite }));
vi.mock("next/script", () => ({
  default: function Script({ onReady }: { onReady?: () => void }) {
    useEffect(() => onReady?.(), [onReady]);
    return null;
  },
}));

const { RequestInviteForm } = await import("@/app/request-invite/RequestInviteForm");
const { REQUEST_ERROR_MESSAGES, REQUEST_LIMITS } = await import("@/lib/inviteRequest");

let container: HTMLDivElement;
let root: Root;
const turnstile = { render: vi.fn(), reset: vi.fn(), remove: vi.fn() };

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  mocks.requestInvite.mockReset();
  turnstile.render.mockReset().mockReturnValue("widget-1");
  turnstile.reset.mockReset();
  turnstile.remove.mockReset();
  window.turnstile = turnstile;
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
  delete window.turnstile;
});

async function render() {
  await act(async () => root.render(<RequestInviteForm siteKey="site-key-1" />));
}

const input = (name: string) => container.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[name="${name}"]`)!;
const form = () => container.querySelector("form")!;

function type(name: string, value: string) {
  const el = input(name);
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function fillAll() {
  type("name", "Ann");
  type("email", "ann@example.com");
  type("referral", "A friend");
  type("interests", "Morocco");
  type("note", "Curious");
}

async function submit() {
  await act(async () => form().requestSubmit());
  await act(async () => new Promise((r) => setTimeout(r, 0)));
}

const values = () => ({
  name: input("name").value,
  email: input("email").value,
  referral: input("referral").value,
  interests: input("interests").value,
  note: input("note").value,
  link: input("link").value,
});

describe("RequestInviteForm", () => {
  it("renders the six fields with the table's limits, only the link optional, and the bot check", async () => {
    await render();
    for (const name of ["name", "email", "referral", "interests", "note"] as const) {
      expect(input(name).required, name).toBe(true);
      expect(input(name).maxLength, name).toBe(REQUEST_LIMITS[name]);
    }
    expect(input("link").required).toBe(false);
    expect(input("link").maxLength).toBe(REQUEST_LIMITS.link);
    expect((input("email") as HTMLInputElement).type).toBe("email");
    expect(turnstile.render).toHaveBeenCalledTimes(1);
    expect(turnstile.render.mock.calls[0][1]).toMatchObject({ sitekey: "site-key-1" });
    // The widget sits inside the form, so its hidden token input is submitted with it.
    expect(form().contains(turnstile.render.mock.calls[0][0])).toBe(true);
  });

  it("sends every field to the action", async () => {
    mocks.requestInvite.mockResolvedValue({ status: "sent" });
    await render();
    fillAll();
    type("link", "https://ann.example");
    await submit();
    const fd: FormData = mocks.requestInvite.mock.calls[0][1];
    expect(Object.fromEntries([...fd.entries()].filter(([k]) => k !== "cf-turnstile-response"))).toEqual({
      name: "Ann",
      email: "ann@example.com",
      referral: "A friend",
      interests: "Morocco",
      note: "Curious",
      link: "https://ann.example",
    });
  });

  it("replaces the form with the thank-you on success", async () => {
    mocks.requestInvite.mockResolvedValue({ status: "sent" });
    await render();
    fillAll();
    await submit();
    expect(container.querySelector("form")).toBeNull();
    expect(container.querySelector('[role="status"]')!.textContent).toMatch(/Thanks, your request is in/);
    // The widget is torn down with the form.
    expect(turnstile.remove).toHaveBeenCalledWith("widget-1");
  });

  it("keeps what was typed, marks the bad fields, and resets the bot check after a refusal", async () => {
    await render();
    fillAll();
    const typed = values();
    mocks.requestInvite.mockResolvedValue({
      status: "error",
      code: "invalid",
      fieldErrors: { email: "Enter a valid email." },
      values: { ...typed, email: "SERVER-ECHO" },
    });
    await submit();
    expect(values()).toEqual(typed);
    expect(input("email").getAttribute("aria-invalid")).toBe("true");
    expect(input("email").getAttribute("aria-describedby")).toBe("email-error");
    expect(container.querySelector("#email-error")!.textContent).toBe("Enter a valid email.");
    expect(input("name").hasAttribute("aria-invalid")).toBe(false);
    expect(container.querySelector('[role="alert"]')!.textContent).toBe(REQUEST_ERROR_MESSAGES.invalid);
    expect(turnstile.reset).toHaveBeenCalledWith("widget-1");
  });

  it.each(["bot_check", "closed", "unavailable"] as const)("shows the fixed message for %s and gets a fresh token", async (code) => {
    await render();
    fillAll();
    mocks.requestInvite.mockResolvedValue({ status: "error", code, fieldErrors: {}, values: values() });
    await submit();
    expect(container.querySelector('[role="alert"]')!.textContent).toBe(REQUEST_ERROR_MESSAGES[code]);
    expect(turnstile.reset).toHaveBeenCalledTimes(1);
  });

  it("resets the bot check again on a second refusal with the same code", async () => {
    await render();
    fillAll();
    mocks.requestInvite.mockResolvedValue({ status: "error", code: "bot_check", fieldErrors: {}, values: values() });
    await submit();
    mocks.requestInvite.mockResolvedValue({ status: "error", code: "bot_check", fieldErrors: {}, values: values() });
    await submit();
    expect(turnstile.reset).toHaveBeenCalledTimes(2);
  });

  it("disables the button and hides the old error while sending", async () => {
    await render();
    fillAll();
    mocks.requestInvite.mockResolvedValueOnce({ status: "error", code: "closed", fieldErrors: {}, values: values() });
    await submit();
    let finish!: (v: unknown) => void;
    mocks.requestInvite.mockReturnValueOnce(new Promise((r) => (finish = r)));
    await act(async () => form().requestSubmit());
    const btn = container.querySelector("button")!;
    expect(btn.disabled).toBe(true);
    expect(btn.textContent).toBe("Sending…");
    expect(container.querySelector('[role="alert"]')).toBeNull();
    await act(async () => finish({ status: "sent" }));
  });
});

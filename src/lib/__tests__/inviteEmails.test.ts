import { describe, expect, it, vi } from "vitest";
import { EMAIL_FROM, sendEmail } from "@/lib/email";
import { approvalEmail, declineEmail, newRequestEmail } from "@/lib/inviteEmails";
import { INVITE_TTL_DAYS } from "@/lib/invite";
import { PRODUCT_NAME } from "@/config/brand";

const request = {
  name: "Mallory",
  email: "victim@example.com",
  referral: "REFERRAL-TEXT",
  interests: "INTERESTS-TEXT",
  note: "NOTE-TEXT visit evil.example",
  link: "https://evil.example",
};

describe("declineEmail", () => {
  it("carries none of the requester's words, so a request in a stranger's name cannot deliver them", () => {
    const email = declineEmail(request.email);
    expect(email.to).toBe(request.email);
    const all = `${email.subject}\n${email.text}`;
    for (const typed of [request.name, request.referral, request.interests, "NOTE-TEXT", "evil.example"]) {
      expect(all).not.toContain(typed);
    }
  });
});

describe("approvalEmail", () => {
  it("holds the link, the address it works for, and the real expiry", () => {
    const email = approvalEmail("ann@example.com", "Ann", "https://news.h72labs.com/signup?invite=T&email=ann%40example.com");
    expect(email.text).toContain("https://news.h72labs.com/signup?invite=T&email=ann%40example.com");
    expect(email.text).toContain("for ann@example.com");
    expect(email.text).toContain(`expires in ${INVITE_TTL_DAYS} days`);
    expect(email.text.startsWith("Hi Ann,")).toBe(true);
  });
});

describe("newRequestEmail", () => {
  it("goes to the admin and labels the requester's link as unchecked", () => {
    const email = newRequestEmail("admin@example.com", request, "https://news.h72labs.com/admin/requests");
    expect(email.to).toBe("admin@example.com");
    expect(email.subject).toBe("Invite request from Mallory");
    expect(email.text).toContain("Link they gave (unchecked): https://evil.example");
    expect(email.text).toContain("https://news.h72labs.com/admin/requests");
  });

  it("leaves the link line out when none was given", () => {
    expect(newRequestEmail("a@b.c", { ...request, link: "" }, "u").text).not.toContain("Link they gave");
  });
});

describe("sendEmail", () => {
  const email = { to: "ann@example.com", subject: "S", text: "T" };

  it("does nothing without a key", async () => {
    const fetchImpl = vi.fn();
    expect(await sendEmail(email, fetchImpl, undefined)).toEqual({ ok: false, reason: "not_configured" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("posts plain text from the fixed sender with the key as a bearer token", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true }) as Response);
    expect(await sendEmail(email, fetchImpl, "re_key")).toEqual({ ok: true });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer re_key");
    expect(JSON.parse(init.body as string)).toEqual({ from: EMAIL_FROM, to: ["ann@example.com"], subject: "S", text: "T" });
  });

  it("reports a refusal and a network failure instead of throwing", async () => {
    expect(await sendEmail(email, vi.fn(async () => ({ ok: false }) as Response), "k")).toEqual({ ok: false, reason: "rejected" });
    const throws = vi.fn(async () => {
      throw new Error("down");
    });
    expect(await sendEmail(email, throws, "k")).toEqual({ ok: false, reason: "network" });
  });
});

describe("the product's name in emails", () => {
  it("names the product in the sender and in both requester emails", () => {
    expect(EMAIL_FROM).toBe(`${PRODUCT_NAME} by H72 Labs <no-reply@h72labs.com>`);
    const approval = approvalEmail("ann@example.com", "Ann", "https://news.h72labs.com/signup?invite=x");
    const decline = declineEmail("ann@example.com");
    expect(approval.subject).toBe(`${PRODUCT_NAME}: your invite`);
    expect(decline.subject).toBe(`${PRODUCT_NAME}: your request`);
    expect(approval.text).toContain(`Thanks for asking to try ${PRODUCT_NAME}.`);
    expect(decline.text).toContain(`Thanks for asking to try ${PRODUCT_NAME}.`);
    expect(`${approval.subject}${approval.text}${decline.subject}${decline.text}`).not.toContain("H72 Labs News");
  });

  // A non-ASCII display name needs RFC 2047 encoding, which not every sender path applies.
  it("keeps the sender's display name plain ASCII", () => {
    expect(EMAIL_FROM).toMatch(/^[\x20-\x7e]+$/);
  });
});

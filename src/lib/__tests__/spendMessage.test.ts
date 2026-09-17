import { describe, it, expect } from "vitest";
import {
  describeAvailableAt,
  errorMessageFromResponse,
  expandErrorMessage,
  spendRefusalMessage,
} from "@/lib/spendMessage";

function localTime(d: Date): string {
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

describe("describeAvailableAt", () => {
  const now = new Date(2026, 8, 17, 13, 0);

  it("names only the time for later today", () => {
    const at = new Date(2026, 8, 17, 19, 42);
    expect(describeAvailableAt(at.toISOString(), now)).toBe(`Available again at ${localTime(at)}.`);
  });

  it("says tomorrow for the next local day", () => {
    const at = new Date(2026, 8, 18, 9, 5);
    expect(describeAvailableAt(at.toISOString(), now)).toBe(`Available again tomorrow at ${localTime(at)}.`);
  });

  it("returns null for an unparseable time", () => {
    expect(describeAvailableAt("not a date", now)).toBeNull();
  });
});

describe("errorMessageFromResponse", () => {
  it("uses a refusal's message and appends its time", async () => {
    const at = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const res = Response.json(
      { reason: "user_count", message: "You've reached your limit of digest runs for now.", availableAt: at },
      { status: 429 }
    );
    const text = await errorMessageFromResponse(res, "fallback");
    expect(text.startsWith("You've reached your limit of digest runs for now. Available again")).toBe(true);
  });

  it("uses the message alone when there is no time", async () => {
    const res = Response.json(
      { reason: "disabled", message: spendRefusalMessage("digest", "disabled"), availableAt: null },
      { status: 503 }
    );
    expect(await errorMessageFromResponse(res, "fallback")).toBe("Generating is paused right now. Try again later.");
  });

  it("still reads a plain-text body, as the 409 and 400 responses are", async () => {
    const res = new Response("A digest is already being generated for today — try again in a moment.", {
      status: 409,
    });
    expect(await errorMessageFromResponse(res, "fallback")).toBe(
      "A digest is already being generated for today — try again in a moment."
    );
  });

  it("falls back on an empty body, JSON without a message, or broken JSON", async () => {
    expect(await errorMessageFromResponse(new Response("", { status: 500 }), "fallback")).toBe("fallback");
    expect(await errorMessageFromResponse(Response.json({ nope: 1 }, { status: 500 }), "fallback")).toBe("fallback");
    const broken = new Response("{not json", { status: 500, headers: { "content-type": "application/json" } });
    expect(await errorMessageFromResponse(broken, "fallback")).toBe("fallback");
  });
});

describe("expandErrorMessage", () => {
  it("shows a refusal's message for 429 and 503", async () => {
    const res = Response.json(
      { reason: "user_count", message: spendRefusalMessage("expand", "user_count"), availableAt: null },
      { status: 429 }
    );
    expect(await expandErrorMessage(res)).toBe("You've reached your limit of full reports for now.");
  });

  it("keeps the generic retry prompt for any other failure, whatever the body says", async () => {
    const res = new Response("Couldn't generate the full report — try again.", { status: 502 });
    expect(await expandErrorMessage(res)).toBe("Couldn't load the full report — try again.");
  });
});

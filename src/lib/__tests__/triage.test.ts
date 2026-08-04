import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Cluster } from "@/types";

// Same fake-Anthropic-constructor pattern as dedup.test.ts's isSameStory
// tests — triageCluster is the only thing in triage.ts that talks to
// Anthropic, and its response is fully controlled via this shared mock.
const mockParse = vi.fn();
vi.mock("@anthropic-ai/sdk", () => {
  function FakeAnthropic() {
    return { messages: { parse: mockParse } };
  }
  return { default: FakeAnthropic };
});

function makeCluster(): Cluster {
  return {
    topic: "Tech/AI",
    articles: [
      {
        title: "A title",
        snippet: "A snippet",
        url: "https://example.com/a",
        source: "BBC",
        topic: "Tech/AI",
        publishedAt: "2026-07-31T12:00:00Z",
      },
    ],
  };
}

beforeEach(() => {
  mockParse.mockReset();
});

describe("triageCluster", () => {
  it("passes through notable + severity from a real Haiku response", async () => {
    mockParse.mockResolvedValue({
      parsed_output: { notable: true, severity: 4, reason: "significant development" },
    });
    const { triageCluster } = await import("@/lib/triage");

    await expect(triageCluster(makeCluster())).resolves.toEqual({
      notable: true,
      severity: 4,
    });
  });

  it("passes through a rejected (not notable) outcome unchanged", async () => {
    mockParse.mockResolvedValue({
      parsed_output: { notable: false, severity: 1, reason: "routine update" },
    });
    const { triageCluster } = await import("@/lib/triage");

    await expect(triageCluster(makeCluster())).resolves.toEqual({
      notable: false,
      severity: 1,
    });
  });

  it("falls back to not-notable/severity-1 when parsed_output is missing", async () => {
    mockParse.mockResolvedValue({ parsed_output: null });
    const { triageCluster } = await import("@/lib/triage");

    await expect(triageCluster(makeCluster())).resolves.toEqual({
      notable: false,
      severity: 1,
    });
  });

  it("does not catch a thrown Anthropic error itself — fail-closed handling is the caller's job", async () => {
    mockParse.mockRejectedValue(new Error("rate limited"));
    const { triageCluster } = await import("@/lib/triage");

    await expect(triageCluster(makeCluster())).rejects.toThrow("rate limited");
  });
});

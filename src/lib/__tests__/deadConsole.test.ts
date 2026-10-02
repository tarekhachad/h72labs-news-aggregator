import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";

// The cleanup path after a paid run (settle the spend, release the claim,
// close the stream) is documented as never throwing. A console that throws
// (a closed stdout, a patched console) must not make that false, or the claim
// and the worst-case reservation are stranded over a log line.

const mocks = vi.hoisted(() => ({ settleRpc: vi.fn(), createClient: vi.fn() }));
vi.mock("@supabase/supabase-js", () => ({ createClient: mocks.createClient }));

import { settleSpend, type Reservation } from "@/lib/spend";
import { releaseGenerationClaim } from "@/lib/generationClaim";
import { settleThenRelease } from "@/lib/runCleanup";
import { memoryMark } from "@/lib/runtimeMemory";
import { DIGEST_FAILED_MESSAGE, toNdjsonStream } from "@/lib/ndjsonStream";

const RESERVATION: Reservation = {
  id: "11111111-2222-4333-8444-555555555555",
  token: "a".repeat(64),
  reservedUsd: 0.7,
};
const CLAIM = { claimId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301" };

function killConsole() {
  for (const level of ["log", "warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation(() => {
      throw new Error("console is dead");
    });
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", "publishable");
  mocks.createClient.mockReturnValue({ rpc: mocks.settleRpc });
  mocks.settleRpc.mockResolvedValue({ data: true, error: null });
  killConsole();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("settleSpend with a dead console", () => {
  it("keeps the full reservation without throwing when there is no trustworthy total", async () => {
    await expect(settleSpend(RESERVATION, null)).resolves.toBe(false);
  });

  it("reports an RPC error as unsettled without throwing", async () => {
    mocks.settleRpc.mockResolvedValue({ data: null, error: { message: "boom" } });
    await expect(settleSpend(RESERVATION, 0.2)).resolves.toBe(false);
  });

  it("reports a thrown RPC as unsettled without throwing", async () => {
    mocks.settleRpc.mockRejectedValue(new Error("network"));
    await expect(settleSpend(RESERVATION, 0.2)).resolves.toBe(false);
  });

  it("reports missing settings as unsettled without throwing", async () => {
    vi.stubEnv("SUPABASE_URL", "");
    await expect(settleSpend(RESERVATION, 0.2)).resolves.toBe(false);
  });
});

describe("releaseGenerationClaim with a dead console", () => {
  it.each([
    ["an RPC error", async () => ({ data: null, error: { message: "boom" } })],
    ["an already-reclaimed claim", async () => ({ data: false, error: null })],
    ["a thrown RPC", async () => Promise.reject(new Error("network"))],
  ])("resolves on %s", async (_label, result) => {
    const client = { rpc: vi.fn(result) } as unknown as SupabaseClient;
    await expect(releaseGenerationClaim(client, CLAIM)).resolves.toBeUndefined();
  });
});

describe("settleThenRelease with a dead console", () => {
  it("still releases the claim when the settle has no total to record", async () => {
    const rpc = vi.fn(async () => ({ data: true, error: null }));
    await settleThenRelease({ rpc } as unknown as SupabaseClient, RESERVATION, CLAIM, null);
    expect(rpc).toHaveBeenCalledWith("release_generation", { p_claim_id: CLAIM.claimId });
  });
});

describe("memoryMark", () => {
  it("does not throw when the console is dead", () => {
    expect(() => memoryMark("after triage", { clusters: 3 })).not.toThrow();
  });

  it("does not throw when reading the process's memory fails", () => {
    vi.spyOn(process, "memoryUsage").mockImplementation(() => {
      throw new Error("EMFILE");
    });
    expect(() => memoryMark("after triage")).not.toThrow();
  });
});

describe("toNdjsonStream with a dead console", () => {
  it("still sends the client the fixed error event when the pipeline fails", async () => {
    const failing = (async function* () {
      yield { stage: "ingesting" };
      throw new Error("pipeline broke");
    })();
    const text = await new Response(toNdjsonStream(failing, async () => {})).text();
    expect(text).toBe(`{"stage":"ingesting"}\n{"stage":"error","message":"${DIGEST_FAILED_MESSAGE}"}\n`);
  });
});

// The guarantee above holds only while every log line in these files goes
// through bestEffortLog. A bare console call slipped back in would pass every
// other test here unless it happened to sit on a path one of them reaches.
// triage.ts logs after a paid call; embeddings.ts logs inside the model load,
// where a throw would fail clustering for the run.
describe("files whose logs must not throw", () => {
  const FILES = [
    "src/app/api/digest/route.ts",
    "src/app/api/cards/[id]/expand/route.ts",
    "src/lib/spend.ts",
    "src/lib/generationClaim.ts",
    "src/lib/ndjsonStream.ts",
    "src/lib/runtimeMemory.ts",
    "src/lib/triage.ts",
    "src/lib/embeddings.ts",
  ];

  it.each(FILES)("%s has no bare console call", (file) => {
    const code = readFileSync(resolve(process.cwd(), file), "utf8")
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line));
    // Optional chaining and bracket access count too: console?.error( and
    // console["error"]( throw just the same.
    const bare = code.filter((line) => /\bconsole\s*(\?\.|\.|\[)/.test(line));
    expect(bare).toEqual([]);
  });
});

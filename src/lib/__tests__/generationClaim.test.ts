import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  claimGenerationForUser,
  releaseGenerationClaim,
  STALE_CLAIM_MS,
} from "@/lib/generationClaim";

// The route's wiring tests all mock this module away, and the day-boundary
// test drives it through a fake that only ever answers with a valid token or
// null. Neither ever executes the error paths, which is where the two
// functions' contracts actually live: a claim distinguishes "someone else
// holds it" from "the database is broken", and a release never throws no
// matter what comes back.

const TOKEN = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

function clientReturning(result: unknown) {
  const rpc = vi.fn(async () => result);
  return { client: { rpc } as never, rpc };
}

let errors: unknown[][];

beforeEach(() => {
  errors = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("claimGenerationForUser", () => {
  it("returns the token when the claim is granted", async () => {
    const { client } = clientReturning({ data: TOKEN, error: null });

    expect(await claimGenerationForUser(client)).toEqual({ claimId: TOKEN });
  });

  it("returns null when a live claim is already held", async () => {
    const { client } = clientReturning({ data: null, error: null });

    expect(await claimGenerationForUser(client)).toBeNull();
  });

  it("asks for this app's staleness window by default", async () => {
    const { client, rpc } = clientReturning({ data: TOKEN, error: null });

    await claimGenerationForUser(client);

    expect(rpc).toHaveBeenCalledWith("claim_generation", { p_stale_ms: STALE_CLAIM_MS });
  });

  it("passes a caller's window through when one is given", async () => {
    const { client, rpc } = clientReturning({ data: TOKEN, error: null });

    await claimGenerationForUser(client, { staleMs: 240_000 });

    expect(rpc).toHaveBeenCalledWith("claim_generation", { p_stale_ms: 240_000 });
  });

  // The distinction this pair of tests protects: a refusal is a 409 telling
  // the user a digest is already generating, and a broken database must not
  // borrow that message. Reducing an error to null would tell a user whose
  // database is down that they are already generating a digest, and would
  // hide the outage from the logs.
  it("throws when the call itself fails, rather than reporting a refusal", async () => {
    const { client } = clientReturning({ data: null, error: { message: "connection reset" } });

    await expect(claimGenerationForUser(client)).rejects.toThrow("connection reset");
  });

  it("throws rather than trusting a response that is not a token", async () => {
    for (const data of ["not-a-uuid", 42, {}, [], true]) {
      const { client } = clientReturning({ data, error: null });

      await expect(claimGenerationForUser(client)).rejects.toThrow("unexpected shape");
    }
  });
});

describe("releaseGenerationClaim", () => {
  it("logs nothing when the claim was released", async () => {
    const { client, rpc } = clientReturning({ data: true, error: null });

    await releaseGenerationClaim(client, { claimId: TOKEN });

    expect(rpc).toHaveBeenCalledWith("release_generation", { p_claim_id: TOKEN });
    expect(errors).toEqual([]);
  });

  // A false means this run's claim had already been reclaimed as stale and
  // some later run owns it now. Not an error, but the one signal that a run
  // overran its window, so it must not pass silently.
  it("logs, and does not throw, when the token no longer holds the claim", async () => {
    const { client } = clientReturning({ data: false, error: null });

    await expect(releaseGenerationClaim(client, { claimId: TOKEN })).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(String(errors[0][0])).toContain("released nothing");
  });

  it("logs, and does not throw, when the call fails", async () => {
    const { client } = clientReturning({ data: null, error: { message: "connection reset" } });

    await expect(releaseGenerationClaim(client, { claimId: TOKEN })).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(String(errors[0][0])).toContain("connection reset");
  });

  it("swallows a thrown call", async () => {
    const client = {
      rpc: vi.fn(async () => {
        throw new Error("socket hang up");
      }),
    } as never;

    await expect(releaseGenerationClaim(client, { claimId: TOKEN })).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(String(errors[0][0])).toContain("socket hang up");
  });

  // This runs in the same finally block that closes the response stream, so a
  // call that never comes back must not hold the stream open forever.
  it("gives up rather than hanging the response stream forever", async () => {
    vi.useFakeTimers();
    const client = { rpc: vi.fn(() => new Promise(() => {})) } as never;

    const released = releaseGenerationClaim(client, { claimId: TOKEN });
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(released).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(String(errors[0][0])).toContain("timed out");
  });

  it("does not leave its timeout holding the event loop open after a fast call", async () => {
    vi.useFakeTimers();
    const { client } = clientReturning({ data: true, error: null });

    await releaseGenerationClaim(client, { claimId: TOKEN });

    // A cleared timeout is the difference between a function that finishes and
    // one that keeps a serverless invocation billable for five more seconds.
    expect(vi.getTimerCount()).toBe(0);
  });
});

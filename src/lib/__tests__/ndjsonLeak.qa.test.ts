import { describe, expect, it, vi } from "vitest";
import { DIGEST_FAILED_MESSAGE, toNdjsonStream } from "@/lib/ndjsonStream";

// Built in pieces so secret scanners over this file and its history stay quiet.
const FAKE_KEY = ["sk", "ant", "api03", "XYZ"].join("-");

async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text();
}

it("uses bait shaped like a real Anthropic key", () => {
  expect(FAKE_KEY).toMatch(/^sk-ant-api03-/);
});

describe("toNdjsonStream error leak", () => {
  it.each([
    ["Error with DB detail", new Error(`permission denied for table "usage_runs" ${FAKE_KEY}`)],
    ["Anthropic-like error object", Object.assign(new Error("401 invalid x-api-key"), { status: 401 })],
    ["thrown string", "raw string with secret"],
    ["thrown object", { message: "object with secret" }],
  ])("%s: client sees only the fixed message; the log keeps the detail", async (_l, thrown) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    async function* gen() {
      yield { stage: "ingesting" };
      throw thrown;
    }
    const text = await drain(toNdjsonStream(gen(), async () => {}));
    const lines = text.trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.at(-1)).toEqual({ stage: "error", message: DIGEST_FAILED_MESSAGE });
    expect(text).not.toMatch(/secret|sk-ant|usage_runs|api-key/);
    expect(log).toHaveBeenCalledWith(expect.any(String), thrown);
    log.mockRestore();
  });

  it("a throw before the first event still yields exactly one fixed error line", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    async function* gen(): AsyncGenerator<{ stage: string }> {
      throw new Error("boom internal");
    }
    expect(await drain(toNdjsonStream(gen(), async () => {}))).toBe(`{"stage":"error","message":"${DIGEST_FAILED_MESSAGE}"}\n`);
    log.mockRestore();
  });
});

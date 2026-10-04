import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The parser thread's life cycle, with node:worker_threads replaced by a fake
// whose every move the test scripts: start failures, crashes, the memory cap,
// forged replies, the time limit and the idle shutdown. Real-thread behaviour
// is in extract.worker.test.ts and extract.parse-bound.test.ts.

type Handler = (arg: unknown) => void;
type Script = {
  /** Thrown by the constructor. */
  throwOnCreate?: Error;
  /** Emitted instead of the ready message. */
  failBeforeReady?: { event: "error" | "exit"; arg: unknown };
  /** Never sends ready. */
  neverReady?: boolean;
  /** What a page posted to it gets back; "silent" never answers. */
  onPage?: (html: string) => { event: "message" | "error" | "exit" | "messageerror"; arg: unknown } | "silent";
  terminateRejects?: boolean;
};

const { workers, scripts, FakeWorker } = vi.hoisted(() => {
  const workers: FakeWorkerT[] = [];
  const scripts: Script[] = [];
  const later = (fn: () => void) => void Promise.resolve().then(fn);
  class FakeWorkerT {
    url: unknown;
    options: unknown;
    handlers = new Map<string, Handler[]>();
    posted: unknown[] = [];
    terminated = 0;
    unrefed = false;
    script: Script;
    constructor(url: unknown, options: unknown) {
      this.script = scripts.shift() ?? {};
      if (this.script.throwOnCreate) throw this.script.throwOnCreate;
      this.url = url;
      this.options = options;
      workers.push(this);
      const fail = this.script.failBeforeReady;
      if (fail) later(() => this.emit(fail.event, fail.arg));
      else if (!this.script.neverReady) later(() => this.emit("message", { ready: true }));
    }
    on(event: string, handler: Handler) {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
      return this;
    }
    emit(event: string, arg: unknown) {
      for (const h of this.handlers.get(event) ?? []) h(arg);
    }
    postMessage(message: { html: string }) {
      this.posted.push(message);
      const answer = this.script.onPage?.(message.html) ?? { event: "message", arg: { ok: true, text: "x".repeat(400) } };
      if (answer !== "silent") later(() => this.emit(answer.event, answer.arg));
    }
    terminate() {
      this.terminated++;
      return this.script.terminateRejects ? Promise.reject(new Error("terminate failed")) : Promise.resolve(1);
    }
    unref() {
      this.unrefed = true;
    }
  }
  return { workers, scripts, FakeWorker: FakeWorkerT };
});

vi.mock("node:worker_threads", () => ({ Worker: FakeWorker, default: { Worker: FakeWorker } }));
const { mockLookup } = vi.hoisted(() => ({ mockLookup: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: mockLookup, default: { lookup: mockLookup } }));

import { extractArticles, MAX_TEXT_CHARS, resetExtractStateForTests } from "@/lib/extract";

const PAGE = `<!doctype html><html><head><title>t</title></head><body><p>${"Words about the vote. ".repeat(30)}</p></body></html>`;
let fetchMock: ReturnType<typeof vi.fn>;
let logs: string[];

beforeEach(() => {
  resetExtractStateForTests();
  workers.length = 0;
  scripts.length = 0;
  mockLookup.mockReset();
  mockLookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  fetchMock = vi.fn(async (input: string | URL | Request) => {
    const u = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (u.endsWith("/robots.txt")) return new Response("", { status: 404 });
    return new Response(PAGE, { status: 200, headers: { "content-type": "text/html" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  logs = [];
  const keep = (...args: unknown[]) => void logs.push(args.map(String).join(" "));
  vi.spyOn(console, "log").mockImplementation(keep);
  vi.spyOn(console, "error").mockImplementation(keep);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const page = (n: number) => `https://site${n}.example/a`;
const reasons = (rs: { ok: boolean; reason?: string }[]) => rs.map((r) => (r.ok ? "ok" : r.reason));
const startFailures = () => logs.filter((l) => l.includes("parser thread failed to start"));

describe("a thread that can't start turns full text off, once", () => {
  it("a constructor that throws: every page is error, no page is fetched, one log line", async () => {
    scripts.push({ throwOnCreate: new Error("ERR_WORKER_INIT_FAILED") });
    const first = await extractArticles([page(1), page(2)], { deadline: Date.now() + 5_000 });
    expect(reasons(first)).toEqual(["error", "error"]);
    // The first pages were fetched before the thread was asked for; after
    // the failure, nothing more is.
    const fetchesSoFar = fetchMock.mock.calls.length;
    const second = await extractArticles([page(3), page(4)], { deadline: Date.now() + 5_000 });
    expect(reasons(second)).toEqual(["error", "error"]);
    expect(fetchMock.mock.calls.length).toBe(fetchesSoFar);
    expect(startFailures()).toHaveLength(1);
  });

  it("an error before the thread is ready counts as failing to start", async () => {
    scripts.push({ failBeforeReady: { event: "error", arg: Object.assign(new Error("Cannot find module"), { code: "ERR_MODULE_NOT_FOUND" }) } });
    const r = await extractArticles([page(1)], { deadline: Date.now() + 5_000 });
    expect(reasons(r)).toEqual(["error"]);
    expect(startFailures()).toHaveLength(1);
    expect(startFailures()[0]).toContain("ERR_MODULE_NOT_FOUND");
    expect(workers[0].terminated).toBe(1);
  });

  it("an exit before the thread is ready counts as failing to start", async () => {
    scripts.push({ failBeforeReady: { event: "exit", arg: 1 } });
    const r = await extractArticles([page(1)], { deadline: Date.now() + 5_000 });
    expect(reasons(r)).toEqual(["error"]);
    expect(startFailures()).toHaveLength(1);
  });

  it("a thread not ready within 5 s counts as failing to start", async () => {
    vi.useFakeTimers();
    scripts.push({ neverReady: true });
    const pending = extractArticles([page(1)], { deadline: Date.now() + 10_000 });
    await vi.advanceTimersByTimeAsync(5_001);
    expect(reasons(await pending)).toEqual(["error"]);
    expect(startFailures()).toHaveLength(1);
    expect(workers[0].terminated).toBe(1);
  });

  it("is tried again after two minutes", async () => {
    vi.useFakeTimers();
    scripts.push({ throwOnCreate: new Error("no threads") });
    expect(reasons(await extractArticles([page(1)], { deadline: Date.now() + 5_000 }))).toEqual(["error"]);
    vi.setSystemTime(Date.now() + 2 * 60 * 1000 + 1);
    const pending = extractArticles([page(2)], { deadline: Date.now() + 5_000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(reasons(await pending)).toEqual(["ok"]);
    expect(workers).toHaveLength(1);
  });
});

describe("a thread that ends mid-page costs only that page", () => {
  it("a crash makes the page error, is logged, and the next page gets a fresh thread", async () => {
    scripts.push({ onPage: () => ({ event: "error", arg: new Error("boom") }) });
    expect(reasons(await extractArticles([page(1)], { deadline: Date.now() + 5_000 }))).toEqual(["error"]);
    expect(logs.some((l) => l.includes("parser thread ended") && l.includes("boom"))).toBe(true);
    expect(reasons(await extractArticles([page(2)], { deadline: Date.now() + 5_000 }))).toEqual(["ok"]);
    expect(workers).toHaveLength(2);
    expect(workers[0].terminated).toBe(1);
  });

  it("reaching the memory cap makes the page too_large", async () => {
    scripts.push({ onPage: () => ({ event: "error", arg: Object.assign(new Error("heap"), { code: "ERR_WORKER_OUT_OF_MEMORY" }) }) });
    expect(reasons(await extractArticles([page(1)], { deadline: Date.now() + 5_000 }))).toEqual(["too_large"]);
    expect(logs.some((l) => l.includes("a page reached its memory cap"))).toBe(true);
    expect(reasons(await extractArticles([page(2)], { deadline: Date.now() + 5_000 }))).toEqual(["ok"]);
  });

  it("an exit or an unreadable message mid-page makes the page error", async () => {
    scripts.push({ onPage: () => ({ event: "exit", arg: 1 }) }, { onPage: () => ({ event: "messageerror", arg: new Error("clone") }) });
    expect(reasons(await extractArticles([page(1)], { deadline: Date.now() + 5_000 }))).toEqual(["error"]);
    expect(reasons(await extractArticles([page(2)], { deadline: Date.now() + 5_000 }))).toEqual(["error"]);
    expect(reasons(await extractArticles([page(3)], { deadline: Date.now() + 5_000 }))).toEqual(["ok"]);
    expect(workers).toHaveLength(3);
  });

  it("a terminate that rejects is swallowed", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      scripts.push({ onPage: () => ({ event: "error", arg: new Error("boom") }), terminateRejects: true });
      expect(reasons(await extractArticles([page(1)], { deadline: Date.now() + 5_000 }))).toEqual(["error"]);
      await new Promise((r) => setTimeout(r, 10));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});

describe("the time limit", () => {
  it("a page that doesn't answer in 1.5 s is timeout, the thread is ended, and nothing is left running", async () => {
    vi.useFakeTimers();
    scripts.push({ onPage: () => "silent" });
    const pending = extractArticles([page(1)], { deadline: Date.now() + 8_000 });
    await vi.advanceTimersByTimeAsync(1_499);
    expect(workers[0].terminated).toBe(0);
    await vi.advanceTimersByTimeAsync(2);
    expect(reasons(await pending)).toEqual(["timeout"]);
    expect(workers[0].terminated).toBe(1);
    // No wait, parse, start or idle timer outlives the page.
    expect(vi.getTimerCount()).toBe(0);
    // A late answer from the ended thread changes nothing.
    workers[0].emit("message", { ok: true, text: "late" });
    expect(reasons(await extractArticles([page(2)], { deadline: Date.now() + 8_000 }))).toEqual(["ok"]);
    expect(workers).toHaveLength(2);
  });

  it("never past the caller's deadline", async () => {
    vi.useFakeTimers();
    scripts.push({ onPage: () => "silent" });
    const started = Date.now();
    const pending = extractArticles([page(1)], { deadline: started + 400 });
    await vi.advanceTimersByTimeAsync(401);
    expect(reasons(await pending)).toEqual(["timeout"]);
    expect(Date.now() - started).toBeLessThanOrEqual(401);
    expect(workers[0].terminated).toBe(1);
  });

  it("pages queued behind a stuck one wait their turn, then parse on a fresh thread", async () => {
    vi.useFakeTimers();
    scripts.push({ onPage: () => "silent" });
    const pending = extractArticles([page(1), page(2), page(3)], { deadline: Date.now() + 8_000 });
    await vi.advanceTimersByTimeAsync(1_501);
    const r = await pending;
    expect(reasons(r)).toEqual(["timeout", "ok", "ok"]);
    expect(workers).toHaveLength(2);
    // One page at a time: the stuck thread saw one page, the fresh one two.
    expect(workers[0].posted).toHaveLength(1);
    expect(workers[1].posted).toHaveLength(2);
  });

  it("a page still waiting for the thread at the deadline is timeout, and leaves the queue", async () => {
    vi.useFakeTimers();
    scripts.push({ onPage: () => "silent" });
    const pending = extractArticles([page(1), page(2)], { deadline: Date.now() + 300 });
    await vi.advanceTimersByTimeAsync(301);
    expect(reasons(await pending)).toEqual(["timeout", "timeout"]);
    // The waiting page was never handed to any thread.
    expect(workers.flatMap((w) => w.posted)).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("replies", () => {
  it("only the HTML is posted, and the limits go in workerData", async () => {
    await extractArticles([page(1)], { deadline: Date.now() + 5_000 });
    expect(workers[0].posted).toEqual([{ html: PAGE }]);
    expect(workers[0].options).toMatchObject({
      workerData: { maxElements: 20_000, maxDepth: 64, maxChars: MAX_TEXT_CHARS + 1 },
      resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32 },
    });
    expect(workers[0].unrefed).toBe(true);
  });

  it("a reply longer than the cap is still cut to it", async () => {
    scripts.push({ onPage: () => ({ event: "message", arg: { ok: true, text: "word ".repeat(10_000) } }) });
    const [r] = await extractArticles([page(1)], { deadline: Date.now() + 5_000 });
    expect(r.ok && r.text.length).toBeLessThanOrEqual(MAX_TEXT_CHARS);
  });

  it.each([
    ["no ok field", { text: "x".repeat(400) }],
    ["ok that isn't true", { ok: "yes", text: "x".repeat(400) }],
    ["text that isn't a string", { ok: true, text: 42 }],
    ["a reason the thread can't give", { ok: false, reason: "robots" }],
    ["null", null],
  ])("a malformed reply (%s) is error", async (_label, reply) => {
    scripts.push({ onPage: () => ({ event: "message", arg: reply }) });
    expect(reasons(await extractArticles([page(1)], { deadline: Date.now() + 5_000 }))).toEqual(["error"]);
  });

  it("the thread's own refusals pass through", async () => {
    scripts.push({
      onPage: (html) => ({ event: "message", arg: { ok: false, reason: html === PAGE ? "no_content" : "too_large" } }),
    });
    expect(reasons(await extractArticles([page(1)], { deadline: Date.now() + 5_000 }))).toEqual(["no_content"]);
  });
});

describe("idle", () => {
  it("one thread serves a whole run, and is ended 10 s after its last page", async () => {
    vi.useFakeTimers();
    const pending = extractArticles([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(page), { deadline: Date.now() + 8_000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(reasons(await pending).every((r) => r === "ok")).toBe(true);
    expect(workers).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(workers[0].terminated).toBe(0);
    await vi.advanceTimersByTimeAsync(2);
    expect(workers[0].terminated).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(reasons(await extractArticles([page(11)], { deadline: Date.now() + 8_000 }))).toEqual(["ok"]);
    expect(workers).toHaveLength(2);
  });
});

describe("a host whose page stops the thread has its other pages skipped", () => {
  const fetched = (host: string) => fetchMock.mock.calls.filter((c) => String(c[0]).startsWith(`https://${host}/`) && !String(c[0]).endsWith("/robots.txt")).length;

  it("after the thread's own time limit: the host's next page is too_large, unrequested; other hosts carry on", async () => {
    vi.useFakeTimers();
    scripts.push({ onPage: () => "silent" });
    const first = extractArticles(["https://slow.example/1"], { deadline: Date.now() + 8_000 });
    await vi.advanceTimersByTimeAsync(1_501);
    expect(reasons(await first)).toEqual(["timeout"]);
    const next = extractArticles(["https://slow.example/2", "https://fine.example/1"], { deadline: Date.now() + 8_000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(reasons(await next)).toEqual(["too_large", "ok"]);
    expect(fetched("slow.example")).toBe(1);
  });

  it("after the memory cap, likewise", async () => {
    scripts.push({ onPage: () => ({ event: "error", arg: Object.assign(new Error("heap"), { code: "ERR_WORKER_OUT_OF_MEMORY" }) }) });
    expect(reasons(await extractArticles(["https://big.example/1"], { deadline: Date.now() + 5_000 }))).toEqual(["too_large"]);
    expect(reasons(await extractArticles(["https://big.example/2"], { deadline: Date.now() + 5_000 }))).toEqual(["too_large"]);
    expect(fetched("big.example")).toBe(1);
  });

  it("not after the caller's deadline, a crash, or a refusal the thread gave quickly", async () => {
    vi.useFakeTimers();
    scripts.push({ onPage: () => "silent" });
    const short = extractArticles(["https://a.example/1"], { deadline: Date.now() + 400 });
    await vi.advanceTimersByTimeAsync(401);
    expect(reasons(await short)).toEqual(["timeout"]);
    vi.useRealTimers();
    let quickRefusals = 0;
    scripts.push(
      { onPage: () => ({ event: "error", arg: new Error("boom") }) },
      { onPage: () => (quickRefusals++ === 0 ? { event: "message", arg: { ok: false, reason: "too_large" } } : { event: "message", arg: { ok: true, text: "x".repeat(400) } }) }
    );
    expect(reasons(await extractArticles(["https://b.example/1"], { deadline: Date.now() + 5_000 }))).toEqual(["error"]);
    expect(reasons(await extractArticles(["https://c.example/1"], { deadline: Date.now() + 5_000 }))).toEqual(["too_large"]);
    expect(reasons(await extractArticles(["https://a.example/2", "https://b.example/2", "https://c.example/2"], { deadline: Date.now() + 5_000 }))).toEqual(["ok", "ok", "ok"]);
  });

  it("for ten minutes", async () => {
    vi.useFakeTimers();
    scripts.push({ onPage: () => "silent" });
    const first = extractArticles(["https://slow.example/1"], { deadline: Date.now() + 8_000 });
    await vi.advanceTimersByTimeAsync(1_501);
    await first;
    vi.setSystemTime(Date.now() + 10 * 60 * 1000 + 1);
    const later = extractArticles(["https://slow.example/2"], { deadline: Date.now() + 8_000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(reasons(await later)).toEqual(["ok"]);
    expect(fetched("slow.example")).toBe(2);
  });
});

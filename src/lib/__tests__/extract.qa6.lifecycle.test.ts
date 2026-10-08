import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// QA round 6: parser-thread life-cycle edges with a scripted fake Worker.
// The fake answers on microtasks, never on the real clock, so fake timers
// are sound here.

type Handler = (arg: unknown) => void;
type Script = {
  throwOnCreate?: Error;
  failBeforeReady?: { event: "error" | "exit"; arg: unknown };
  neverReady?: boolean;
  onPage?: (html: string) => { event: string; arg: unknown } | "silent";
};

const { workers, scripts, FakeWorker } = vi.hoisted(() => {
  const workers: FakeWorkerT[] = [];
  const scripts: Script[] = [];
  const later = (fn: () => void) => void Promise.resolve().then(fn);
  class FakeWorkerT {
    handlers = new Map<string, Handler[]>();
    posted: string[] = [];
    terminated = 0;
    script: Script;
    constructor() {
      this.script = scripts.shift() ?? {};
      if (this.script.throwOnCreate) throw this.script.throwOnCreate;
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
      this.posted.push(message.html);
      const answer = this.script.onPage?.(message.html) ?? { event: "message", arg: { ok: true, text: message.html.slice(0, 400).padEnd(400, "x") } };
      if (answer !== "silent") later(() => this.emit(answer.event, answer.arg));
    }
    terminate() {
      this.terminated++;
      return Promise.resolve(1);
    }
    unref() {}
  }
  return { workers, scripts, FakeWorker: FakeWorkerT };
});

vi.mock("node:worker_threads", () => ({ Worker: FakeWorker, default: { Worker: FakeWorker } }));
const { mockLookup } = vi.hoisted(() => ({ mockLookup: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: mockLookup, default: { lookup: mockLookup } }));

import { extractArticles, extractForStory, PARSE_TIMEOUT_MS, resetExtractStateForTests } from "@/lib/extract";

const body = (n: number) => `<!doctype html><html><body><p>page-${n} ${"words ".repeat(80)}</p></body></html>`;
let fetchMock: ReturnType<typeof vi.fn>;
let fetchDelay: Record<string, number>;
let logs: string[];

beforeEach(() => {
  resetExtractStateForTests();
  workers.length = 0;
  scripts.length = 0;
  fetchDelay = {};
  mockLookup.mockReset();
  mockLookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  fetchMock = vi.fn(async (input: string | URL | Request) => {
    const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (u.pathname === "/robots.txt") return new Response("", { status: 404 });
    const n = Number(u.hostname.replace(/\D/g, ""));
    const wait = fetchDelay[u.hostname];
    if (wait) await new Promise((r) => setTimeout(r, wait));
    return new Response(body(n), { status: 200, headers: { "content-type": "text/html" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  logs = [];
  const keep = (...args: unknown[]) => void logs.push(args.map(String).join(" "));
  vi.spyOn(console, "log").mockImplementation(keep);
  vi.spyOn(console, "error").mockImplementation(keep);
});

afterEach(() => {
  resetExtractStateForTests();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const page = (n: number) => `https://site${n}.example/a`;
const reasons = (rs: ({ ok: boolean; reason?: string } | undefined)[]) => rs.map((r) => (r === undefined ? "untried" : r.ok ? "ok" : r.reason));
const pageFetches = () => fetchMock.mock.calls.filter((c) => !String(c[0]).endsWith("/robots.txt")).length;

describe("a stopped thread can never answer for a later page", () => {
  it("late message, error (even out-of-memory) and exit from the old thread while a new one is parsing change nothing", async () => {
    vi.useFakeTimers();
    scripts.push({ onPage: () => "silent" }, { onPage: () => "silent" });
    const first = extractArticles([page(1)], { deadline: Date.now() + 8_000 });
    await vi.advanceTimersByTimeAsync(PARSE_TIMEOUT_MS + 1);
    expect(reasons(await first)).toEqual(["timeout"]);

    const second = extractArticles([page(2)], { deadline: Date.now() + 8_000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(workers).toHaveLength(2);
    expect(workers[1].posted).toHaveLength(1);
    const old = workers[0];
    old.emit("message", { ok: true, text: "stale ".repeat(100) });
    old.emit("error", Object.assign(new Error("heap"), { code: "ERR_WORKER_OUT_OF_MEMORY" }));
    old.emit("messageerror", new Error("clone"));
    old.emit("exit", 1);
    expect(workers[1].terminated).toBe(0);
    workers[1].emit("message", { ok: true, text: "fresh ".repeat(100) });
    const [r] = await second;
    expect(r.ok && r.text.startsWith("fresh")).toBe(true);
    expect(logs.some((l) => l.includes("parser thread ended"))).toBe(false);
    expect(workers).toHaveLength(2);
  });
});

describe("queue order and deadlines", () => {
  it("pages are handed to the thread in the order they arrive, one at a time", async () => {
    // Fetches finish in reverse order of the URL list.
    fetchDelay = { "site1.example": 30, "site2.example": 20, "site3.example": 10 };
    vi.useFakeTimers();
    const pending = extractArticles([page(1), page(2), page(3)], { deadline: Date.now() + 8_000 });
    await vi.advanceTimersByTimeAsync(100);
    const r = await pending;
    expect(reasons(r)).toEqual(["ok", "ok", "ok"]);
    expect(workers).toHaveLength(1);
    expect(workers[0].posted.map((h) => /page-(\d)/.exec(h)![1])).toEqual(["3", "2", "1"]);
    // Each answer belongs to its own page.
    r.forEach((x, i) => expect(x.ok && x.text).toContain(`page-${i + 1}`));
  });

  it("a page waiting for a thread that is still starting times out at its deadline and is never posted", async () => {
    vi.useFakeTimers();
    scripts.push({ neverReady: true });
    const pending = extractArticles([page(1)], { deadline: Date.now() + 1_000 });
    await vi.advanceTimersByTimeAsync(1_001);
    expect(reasons(await pending)).toEqual(["timeout"]);
    // Ready arrives late: nothing is posted, the thread just goes idle.
    workers[0].emit("message", { ready: true });
    expect(workers[0].posted).toHaveLength(0);
    // Ready came in time, so this is not a start failure.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(logs.some((l) => l.includes("failed to start"))).toBe(false);
    await vi.advanceTimersByTimeAsync(5_100);
    expect(workers[0].terminated).toBe(1);
  });

  it("the start timer is cleared once ready: a long-lived thread is never reported as failing to start", async () => {
    vi.useFakeTimers();
    await extractArticles([page(1)], { deadline: Date.now() + 8_000 });
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(4_000);
      expect(reasons(await extractArticles([page(2 + i)], { deadline: Date.now() + 8_000 }))).toEqual(["ok"]);
    }
    expect(logs.some((l) => l.includes("failed to start"))).toBe(false);
    expect(workers).toHaveLength(1);
  });

  it("a page arriving just before the idle limit keeps the thread", async () => {
    vi.useFakeTimers();
    await extractArticles([page(1)], { deadline: Date.now() + 8_000 });
    await vi.advanceTimersByTimeAsync(9_900);
    scripts.push({});
    workers[0].script = { onPage: () => "silent" };
    const pending = extractArticles([page(2)], { deadline: Date.now() + 8_000 });
    await vi.advanceTimersByTimeAsync(200);
    // Busy past the old idle time, but not ended by the idle timer.
    expect(workers[0].terminated).toBe(0);
    workers[0].emit("message", { ok: true, text: "y".repeat(400) });
    expect(reasons(await pending)).toEqual(["ok"]);
    expect(workers).toHaveLength(1);
  });
});

describe("the 2-minute off window", () => {
  it("a page whose download finishes during the window is error, and no new thread is tried for it", async () => {
    vi.useFakeTimers();
    scripts.push({ failBeforeReady: { event: "error", arg: new Error("cannot load") } });
    fetchDelay = { "site2.example": 500 };
    const pending = extractArticles([page(1), page(2)], { deadline: Date.now() + 8_000 });
    await vi.advanceTimersByTimeAsync(600);
    expect(reasons(await pending)).toEqual(["error", "error"]);
    expect(workers).toHaveLength(1);
    expect(logs.filter((l) => l.includes("failed to start"))).toHaveLength(1);
  });

  it("extractForStory fetches nothing at all during the window, across all five pages", async () => {
    vi.useFakeTimers();
    scripts.push({ throwOnCreate: new Error("no threads") });
    await extractArticles([page(1)], { deadline: Date.now() + 5_000 });
    const before = pageFetches();
    await vi.advanceTimersByTimeAsync(60_000);
    const r = await extractForStory([1, 2, 3, 4, 5].map((n) => page(10 + n)), { deadline: Date.now() + 15_000 });
    expect(reasons(r)).toEqual(["error", "error", "error", "error", "error"]);
    expect(pageFetches()).toBe(before);
  });

  it("a second failure after the retry is logged again and opens a new window", async () => {
    vi.useFakeTimers();
    scripts.push({ throwOnCreate: new Error("first") }, { throwOnCreate: new Error("second") });
    await extractArticles([page(1)], { deadline: Date.now() + 5_000 });
    vi.setSystemTime(Date.now() + 2 * 60 * 1000 + 1);
    await extractArticles([page(2)], { deadline: Date.now() + 5_000 });
    const fails = logs.filter((l) => l.includes("failed to start"));
    expect(fails).toHaveLength(2);
    expect(fails[1]).toContain("second");
    const before = pageFetches();
    expect(reasons(await extractArticles([page(3)], { deadline: Date.now() + 5_000 }))).toEqual(["error"]);
    expect(pageFetches()).toBe(before);
  });
});

describe("resetExtractStateForTests", () => {
  it("with a page mid-parse: settles it, ends the thread, and leaves no thread or timer for the next test", async () => {
    vi.useFakeTimers();
    scripts.push({ onPage: () => "silent" });
    const pending = extractArticles([page(1)], { deadline: Date.now() + 8_000 });
    await vi.advanceTimersByTimeAsync(10);
    expect(workers[0].posted).toHaveLength(1);
    let settledAt: number | null = null;
    const t0 = Date.now();
    void pending.then(() => (settledAt = Date.now() - t0));
    resetExtractStateForTests();
    expect(workers[0].terminated).toBe(1);
    await vi.advanceTimersByTimeAsync(0);
    const settledImmediately = settledAt !== null;
    await vi.advanceTimersByTimeAsync(PARSE_TIMEOUT_MS + 100);
    process.stdout.write(`[qa6] reset with a page mid-parse: page settled ${settledImmediately ? "at once" : `after ${settledAt} ms (its own time limit)`}; timers left ${vi.getTimerCount()}; workers ${workers.length}\n`);
    expect(settledAt).not.toBeNull();
    expect(workers).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

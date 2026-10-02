import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { dateInTimeZone, MOROCCO_GMT_SINCE } from "@/lib/localDate";

const MOROCCO = ["Africa/Casablanca", "Africa/El_Aaiun"] as const;
const at = (iso: string) => new Date(iso);
const raw = (d: Date, z: string) => {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: z, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const g = (t: string) => p.find((x) => x.type === t)!.value;
  return `${g("year")}-${g("month")}-${g("day")}`;
};
const utc = (d: Date) => d.toISOString().slice(0, 10);
// Independent of the runtime: tz 2026a and 2026c agree before the move
// (verified by a separate offset-transition probe), and 2026c is UTC+0 after.
const expected2026c = (d: Date, z: string) => (d.getTime() >= Date.UTC(2026, 8, 20, 1) ? utc(d) : raw(d, z));
const runtimeStale = raw(new Date(Date.UTC(2026, 11, 31, 23, 30)), "Africa/Casablanca") === "2027-01-01";

describe("QA: Morocco sweep", () => {
  it("matches tz 2026c every hour (at :30) from 2025-12-01 to 2028-06-01, both zones", { timeout: 20000 }, () => {
    const bad: string[] = [];
    for (const z of MOROCCO) {
      for (let t = Date.UTC(2025, 11, 1, 0, 30); t < Date.UTC(2028, 5, 1); t += 3600 * 1000) {
        const d = new Date(t);
        const got = dateInTimeZone(d, z);
        const want = expected2026c(d, z);
        if (got !== want) bad.push(`${z} ${d.toISOString()} got=${got} want=${want}`);
      }
    }
    expect(bad.slice(0, 5)).toEqual([]);
  });

  it("has the boundary constant exactly at 2026-09-20T01:00:00Z", () => {
    expect(new Date(MOROCCO_GMT_SINCE).toISOString()).toBe("2026-09-20T01:00:00.000Z");
  });

  it("dates correctly around the boundary and local midnights", () => {
    for (const z of MOROCCO) {
      expect(dateInTimeZone(at("2026-09-19T22:59:59.999Z"), z)).toBe("2026-09-19"); // 23:59 UTC+1
      expect(dateInTimeZone(at("2026-09-19T23:00:00Z"), z)).toBe("2026-09-20"); // 00:00 UTC+1
      expect(dateInTimeZone(new Date(MOROCCO_GMT_SINCE - 1), z)).toBe("2026-09-20");
      expect(dateInTimeZone(new Date(MOROCCO_GMT_SINCE), z)).toBe("2026-09-20");
      expect(dateInTimeZone(at("2026-09-20T23:59:59.999Z"), z)).toBe("2026-09-20");
      expect(dateInTimeZone(at("2026-09-21T00:00:00Z"), z)).toBe("2026-09-21");
      expect(dateInTimeZone(at("2026-09-20T23:00:00Z"), z)).toBe("2026-09-20");
    }
  });

  it("keeps the Ramadan UTC+0 exception before the move", () => {
    for (const z of MOROCCO) {
      expect(dateInTimeZone(at("2026-02-14T23:30:00Z"), z)).toBe("2026-02-15"); // UTC+1
      expect(dateInTimeZone(at("2026-02-15T23:30:00Z"), z)).toBe("2026-02-15"); // Ramadan UTC+0
      expect(dateInTimeZone(at("2026-03-21T23:30:00Z"), z)).toBe("2026-03-21"); // Ramadan UTC+0
      expect(dateInTimeZone(at("2026-03-22T23:30:00Z"), z)).toBe("2026-03-23"); // UTC+1 again
    }
  });

  it("stays UTC+0 after the move through old-rules Ramadan and non-Ramadan, far future too", () => {
    for (const z of MOROCCO) {
      expect(dateInTimeZone(at("2027-02-10T23:30:00Z"), z)).toBe("2027-02-10");
      expect(dateInTimeZone(at("2027-04-01T23:30:00Z"), z)).toBe("2027-04-01");
      expect(dateInTimeZone(at("2035-07-01T23:30:00Z"), z)).toBe("2035-07-01");
      expect(dateInTimeZone(at("2099-12-31T23:59:59Z"), z)).toBe("2099-12-31");
    }
  });
});

describe("QA: other zones untouched", () => {
  const zones = ["UTC", "Etc/GMT-1", "Europe/Lisbon", "Europe/London", "Atlantic/Canary", "Africa/Ceuta",
    "Africa/Algiers", "Africa/Abidjan", "Europe/Paris", "America/New_York", "Asia/Tokyo", "Pacific/Kiritimati"];
  // 11:30 and 23:30 UTC every day: the 23:30 sample is where a zone one hour
  // either side of UTC changes date, which is the case a wrong offset breaks.
  it("equal the runtime's own Intl answer twice a day through 2026-06/2027", { timeout: 20000 }, () => {
    const bad: string[] = [];
    for (const z of zones) {
      for (let t = Date.UTC(2026, 0, 1, 11, 30); t < Date.UTC(2027, 6, 1); t += 12 * 3600 * 1000) {
        const d = new Date(t);
        if (dateInTimeZone(d, z) !== raw(d, z)) bad.push(`${z} ${d.toISOString()}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("an invalid name still falls back to UTC", () => {
    const d = at("2026-12-31T23:30:00Z");
    expect(dateInTimeZone(d, "Mars/Olympus")).toBe("2026-12-31");
    expect(dateInTimeZone(d, "")).toBe("2026-12-31");
    expect(dateInTimeZone(d, undefined as unknown as string)).toBe("2026-12-31");
    expect(dateInTimeZone(at("2026-09-23T00:30:00Z"), "Africa/Casablanka")).toBe("2026-09-23");
  });
});

describe("QA: probe memoization and log", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.resetModules(); });
  const tzLines = (spy: ReturnType<typeof vi.spyOn>) =>
    spy.mock.calls.filter((c: unknown[]) => String(c[0]).startsWith("[tz] runtime tz database")).map((c: unknown[]) => String(c[0]));

  it("logs on/off matching the runtime's actual staleness, once, for El_Aaiun first too", async () => {
    vi.resetModules();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const fresh = await import("@/lib/localDate");
    for (let i = 0; i < 5; i++) fresh.dateInTimeZone(at("2026-10-15T12:00:00Z"), "Europe/Paris");
    expect(tzLines(log)).toEqual([]);
    fresh.dateInTimeZone(at("2026-10-15T12:00:00Z"), "Africa/El_Aaiun");
    for (let i = 0; i < 5; i++) fresh.dateInTimeZone(at("2026-10-15T23:30:00Z"), "Africa/Casablanca");
    expect(tzLines(log)).toEqual([
      `[tz] runtime tz database ${process.versions.tz}; Morocco GMT correction ${runtimeStale ? "on" : "off"}`,
    ]);
  });

  it("a pre-move Moroccan call also triggers the probe/log exactly once and stays correct", async () => {
    vi.resetModules();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const fresh = await import("@/lib/localDate");
    expect(fresh.dateInTimeZone(at("2026-06-01T23:30:00Z"), "Africa/Casablanca")).toBe("2026-06-02");
    expect(fresh.dateInTimeZone(at("2026-12-31T23:30:00Z"), "Africa/Casablanca")).toBe("2026-12-31");
    expect(tzLines(log)).toHaveLength(1);
  });

  it("a module re-import re-probes and logs again (per module instance, not per process)", async () => {
    vi.resetModules();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const a = await import("@/lib/localDate");
    a.dateInTimeZone(at("2026-10-15T12:00:00Z"), "Africa/Casablanca");
    vi.resetModules();
    const b = await import("@/lib/localDate");
    b.dateInTimeZone(at("2026-10-15T12:00:00Z"), "Africa/Casablanca");
    expect(tzLines(log)).toHaveLength(2);
  });

  it("a throwing console.log does not break dating", async () => {
    vi.resetModules();
    vi.spyOn(console, "log").mockImplementation(() => { throw new Error("closed stdout"); });
    const fresh = await import("@/lib/localDate");
    expect(fresh.dateInTimeZone(at("2026-12-31T23:30:00Z"), "Africa/Casablanca")).toBe("2026-12-31");
  });
});

describe("QA: browser-like context (no process global)", () => {
  // Transpile the real source and run it in a fresh V8 context with no
  // `process`, the way a browser bundle would see it.
  const load = (globals: Record<string, unknown>) => {
    const src = (f: string) => ts.transpileModule(fs.readFileSync(path.resolve(__dirname, "..", f), "utf8"),
      { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const ctx = vm.createContext({ ...globals });
    const mk = (code: string, req: (s: string) => unknown) => {
      const cjs = { exports: {} as Record<string, unknown> };
      vm.runInContext(`(function(module, exports, require){${code}\n})`, ctx)(cjs, cjs.exports, req);
      return cjs.exports;
    };
    const bel = mk(src("bestEffortLog.ts"), () => { throw new Error("unexpected require"); });
    return mk(src("localDate.ts"), (s) => { if (s === "@/lib/bestEffortLog") return bel; throw new Error("unexpected require " + s); }) as {
      dateInTimeZone: (d: Date, z: string) => string;
    };
  };

  it("no process at all: no throw, no log, correct date", () => {
    const calls: unknown[][] = [];
    const fakeConsole = { log: (...a: unknown[]) => calls.push(a), warn: () => {}, error: () => {} };
    const m = load({ console: fakeConsole });
    expect(vm.runInContext("typeof process", vm.createContext({}))).toBe("undefined");
    // Date objects from this realm work fine with the context's Intl.
    expect(m.dateInTimeZone(at("2026-12-31T23:30:00Z"), "Africa/Casablanca")).toBe("2026-12-31");
    expect(m.dateInTimeZone(at("2026-06-01T23:30:00Z"), "Africa/Casablanca")).toBe("2026-06-02");
    expect(calls).toEqual([]);
  });

  it("Next-style process polyfill ({ env }) with no versions: no throw, no log", () => {
    const calls: unknown[][] = [];
    const m = load({ console: { log: (...a: unknown[]) => calls.push(a) }, process: { env: {} } });
    expect(m.dateInTimeZone(at("2026-12-31T23:30:00Z"), "Africa/El_Aaiun")).toBe("2026-12-31");
    expect(calls).toEqual([]);
  });
});

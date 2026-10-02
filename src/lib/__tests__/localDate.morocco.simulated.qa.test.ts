import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

// Runs the real localDate.ts in a fresh V8 context whose Intl is a thin wrapper
// over the host's, but with Morocco's rules replaced by a chosen tz release.
// That exercises the correction-ON path (tz 2026a) and the OFF path (2026c)
// on whatever Node the suite happens to run on, CI included.

const H = 3600 * 1000;
const SINCE = Date.UTC(2026, 8, 20, 1);
// Old-rules (tz 2026a) UTC+0 Ramadan windows, measured from node 24.18's Intl.
const RAMADAN_2026A: Array<[number, number]> = [
  [Date.UTC(2025, 1, 23, 2), Date.UTC(2025, 3, 6, 2)],
  [Date.UTC(2026, 1, 15, 2), Date.UTC(2026, 2, 22, 2)],
  [Date.UTC(2027, 1, 7, 2), Date.UTC(2027, 2, 14, 2)],
  [Date.UTC(2028, 0, 23, 2), Date.UTC(2028, 2, 5, 2)],
  [Date.UTC(2029, 0, 14, 2), Date.UTC(2029, 1, 18, 2)],
];
const MOROCCO = new Set(["Africa/Casablanca", "Africa/El_Aaiun"]);
const oldOffsetZone = (t: number) => (RAMADAN_2026A.some(([a, b]) => t >= a && t < b) ? "UTC" : "Etc/GMT-1");
const newOffsetZone = (t: number) => (t >= SINCE ? "UTC" : oldOffsetZone(t));

function fakeIntl(rules: "2026a" | "2026c") {
  const Real = Intl.DateTimeFormat;
  const pick = rules === "2026a" ? oldOffsetZone : newOffsetZone;
  class DTF {
    private opts: Intl.DateTimeFormatOptions;
    private locale?: string;
    constructor(locale?: string, opts: Intl.DateTimeFormatOptions = {}) {
      new Real(locale, opts); // same validation as the real thing
      this.locale = locale;
      this.opts = opts;
    }
    formatToParts(d: Date) {
      const z = this.opts.timeZone;
      const zone = z && MOROCCO.has(z) ? pick(d.getTime()) : z;
      return new Real(this.locale, { ...this.opts, timeZone: zone }).formatToParts(d);
    }
    resolvedOptions() {
      return new Real(this.locale, this.opts).resolvedOptions();
    }
  }
  return { ...Object.fromEntries(Object.getOwnPropertyNames(Intl).map((k) => [k, (Intl as never)[k]])), DateTimeFormat: DTF };
}

function load(rules: "2026a" | "2026c") {
  const src = (f: string) =>
    ts.transpileModule(fs.readFileSync(path.resolve(__dirname, "..", f), "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
  const logs: unknown[][] = [];
  const ctx = vm.createContext({ console: { log: (...a: unknown[]) => logs.push(a) }, Intl: fakeIntl(rules) });
  const mk = (code: string, req: (s: string) => unknown) => {
    const cjs = { exports: {} as Record<string, unknown> };
    vm.runInContext(`(function(module, exports, require){${code}\n})`, ctx)(cjs, cjs.exports, req);
    return cjs.exports;
  };
  const bel = mk(src("bestEffortLog.ts"), () => { throw new Error("unexpected require"); });
  const m = mk(src("localDate.ts"), (s) => {
    if (s === "@/lib/bestEffortLog") return bel;
    throw new Error("unexpected require " + s);
  }) as { dateInTimeZone: (d: Date, z: string) => string };
  return { m, logs };
}

// What tz 2026c says the date is, computed without Intl's Morocco data at all.
const want2026c = (t: number) => {
  const off = newOffsetZone(t) === "UTC" ? 0 : H;
  return new Date(t + off).toISOString().slice(0, 10);
};

describe("QA (simulated tz release): the correction on any host runtime", () => {
  it("the simulator itself reproduces each release (sanity)", () => {
    const old = fakeIntl("2026a").DateTimeFormat;
    const neu = fakeIntl("2026c").DateTimeFormat;
    const f = (C: typeof old, t: number) =>
      new C("en-CA", { timeZone: "Africa/Casablanca", year: "numeric", month: "2-digit", day: "2-digit" })
        .formatToParts(new Date(t)).map((p) => p.value).join("");
    expect(f(old, Date.UTC(2026, 8, 25, 23, 30))).toBe("2026-09-26");
    expect(f(neu, Date.UTC(2026, 8, 25, 23, 30))).toBe("2026-09-25");
  });

  for (const rules of ["2026a", "2026c"] as const) {
    it(`host with ${rules} rules: every day at 23:30 and 00:30 UTC, 2025-12..2029-06, both zones, match tz 2026c`, () => {
      const { m } = load(rules);
      const bad: string[] = [];
      for (const z of MOROCCO) {
        for (let t = Date.UTC(2025, 11, 1, 0, 30); t < Date.UTC(2029, 5, 1); t += 24 * H) {
          for (const tt of [t, t + 23 * H]) {
            const got = m.dateInTimeZone(new Date(tt), z);
            if (got !== want2026c(tt)) bad.push(`${z} ${new Date(tt).toISOString()} got=${got} want=${want2026c(tt)}`);
          }
        }
      }
      expect(bad.slice(0, 5)).toEqual([]);
    });

    it(`host with ${rules} rules: El_Aaiun first, then other zones, still right`, () => {
      const { m } = load(rules);
      expect(m.dateInTimeZone(new Date("2027-06-01T23:30:00Z"), "Africa/El_Aaiun")).toBe("2027-06-01");
      expect(m.dateInTimeZone(new Date("2027-06-01T23:30:00Z"), "Africa/Casablanca")).toBe("2027-06-01");
      expect(m.dateInTimeZone(new Date("2027-06-01T23:30:00Z"), "Europe/Paris")).toBe("2027-06-02");
      expect(m.dateInTimeZone(new Date("2027-06-01T23:30:00Z"), "Africa/Algiers")).toBe("2027-06-02");
    });
  }
});

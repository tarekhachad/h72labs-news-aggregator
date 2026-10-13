import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it, expect } from "vitest";

// No feed URL reaches the browser. The outlets picker groups outlets with
// helpers from src/lib/sourceCoverage.ts in the browser, so this walks every
// module a "use client" file pulls in (type-only imports aside, which leave
// no code behind) and checks that none of them loads either feed table: the
// topic feeds (src/config/feeds.ts) or the country feeds
// (src/config/countries.ts). The pickers' country names come from
// src/config/countryNames.ts, which holds no URLs.

const SRC = resolve(__dirname, "../..");
const FEEDS_FILE = join(SRC, "config/feeds.ts");
const COUNTRIES_FILE = join(SRC, "config/countries.ts");
const COUNTRY_NAMES_FILE = join(SRC, "config/countryNames.ts");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "__tests__" ? [] : sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

function resolveImport(from: string, specifier: string): string | null {
  const base = specifier.startsWith("@/")
    ? join(SRC, specifier.slice(2))
    : specifier.startsWith(".")
      ? resolve(dirname(from), specifier)
      : null;
  if (base === null) return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** Each runtime import of a file: where it points, and the names it takes ("*" for a whole-module import). */
function runtimeImports(file: string): { target: string; names: string[] }[] {
  const code = readFileSync(file, "utf8");
  const found: { target: string; names: string[] }[] = [];
  const add = (specifier: string, names: string[]) => {
    const target = resolveImport(file, specifier);
    if (target) found.push({ target, names });
  };
  for (const m of code.matchAll(/(?:^|\n)\s*import\s+(type\s+)?([^'";]*?)\s*from\s*["']([^"']+)["']/g)) {
    if (m[1]) continue;
    const clause = m[2];
    const braces = clause.match(/\{([\s\S]*)\}/);
    const named = braces
      ? braces[1]
          .split(",")
          .map((part) => part.trim())
          .filter((part) => part !== "" && !part.startsWith("type "))
          .map((part) => part.split(/\s+as\s+/)[0])
      : [];
    const whole = clause.replace(/\{[\s\S]*\}/, "").replace(/,/g, "").trim();
    if (named.length === 0 && whole === "") continue;
    add(m[3], whole !== "" ? ["*", ...named] : named);
  }
  for (const m of code.matchAll(/(?:^|\n)\s*import\s*["']([^"']+)["']/g)) add(m[1], ["*"]);
  for (const m of code.matchAll(/(?:^|\n)\s*export\s+(?!type\b)[^'";]*?\s*from\s*["']([^"']+)["']/g)) add(m[1], ["*"]);
  for (const m of code.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)) add(m[1], ["*"]);
  return found;
}

function clientGraph() {
  const entries = sourceFiles(SRC).filter((file) => /^\s*["']use client["']/.test(readFileSync(file, "utf8")));
  const reached = new Set<string>();
  const countriesImporters: string[] = [];
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (reached.has(file)) continue;
    reached.add(file);
    for (const { target } of runtimeImports(file)) {
      if (target === COUNTRIES_FILE) countriesImporters.push(relative(SRC, file));
      queue.push(target);
    }
  }
  return { entries, reached, countriesImporters };
}

describe("the browser's modules", () => {
  const { entries, reached, countriesImporters } = clientGraph();

  it("include the outlets picker and its coverage helpers", () => {
    expect(entries.length).toBeGreaterThan(10);
    expect(reached).toContain(join(SRC, "components/PreferencesForm.tsx"));
    expect(reached).toContain(join(SRC, "lib/sourceCoverage.ts"));
  });

  it("never load the topic feed table", () => {
    expect([...reached].map((file) => relative(SRC, file))).not.toContain("config/feeds.ts");
    expect(reached.has(FEEDS_FILE)).toBe(false);
  });

  it("take country names from the feed-free module", () => {
    expect(reached.has(COUNTRY_NAMES_FILE)).toBe(true);
  });

  it("never load the country feed table's module", () => {
    // Lists the browser modules that import it, so a failure names the culprit.
    expect(countriesImporters).toEqual([]);
    expect(reached.has(COUNTRIES_FILE)).toBe(false);
  });
});

// scripts/verify-feeds.mts imports src/config/countries.ts through Node's own
// type stripping, with no bundler to resolve the @/ alias, so the re-export of
// the names must stay a relative specifier. tsc and every other test resolve
// @/ fine; only a real Node load catches the break.
it("the country feed module loads under plain Node, as the feeds script loads it", () => {
  const script = `const m = await import(${JSON.stringify(pathToFileURL(COUNTRIES_FILE).href)});
    console.log(JSON.stringify([m.COUNTRIES_TOPIC, m.COUNTRIES.length, Object.keys(m.COUNTRY_FEEDS).length]));`;
  const run = spawnSync(
    process.execPath,
    ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--input-type=module", "-e", script],
    { encoding: "utf8" }
  );
  expect(run.stderr).toBe("");
  const [topic, names, feeds] = JSON.parse(run.stdout);
  expect(topic).toBe("Countries");
  expect(names).toBeGreaterThan(0);
  expect(feeds).toBe(names);
});

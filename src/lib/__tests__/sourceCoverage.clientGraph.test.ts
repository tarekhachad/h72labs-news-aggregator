import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, it, expect } from "vitest";

// No feed URL reaches the browser. The outlets picker groups outlets with
// helpers from src/lib/sourceCoverage.ts in the browser, so this walks every
// module a "use client" file pulls in (type-only imports aside, which leave
// no code behind) and checks that none of them loads the topic feed table,
// and that none imports the country feed table by name: src/config/countries.ts
// also holds COUNTRIES, which the pickers need, and a bundler leaves out an
// export nothing imports.

const SRC = resolve(__dirname, "../..");
const FEEDS_FILE = join(SRC, "config/feeds.ts");
const COUNTRIES_FILE = join(SRC, "config/countries.ts");

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
  const countriesImports: { from: string; names: string[] }[] = [];
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (reached.has(file)) continue;
    reached.add(file);
    for (const { target, names } of runtimeImports(file)) {
      if (target === COUNTRIES_FILE) countriesImports.push({ from: relative(SRC, file), names });
      queue.push(target);
    }
  }
  return { entries, reached, countriesImports };
}

describe("the browser's modules", () => {
  const { entries, reached, countriesImports } = clientGraph();

  it("include the outlets picker and its coverage helpers", () => {
    expect(entries.length).toBeGreaterThan(10);
    expect(reached).toContain(join(SRC, "components/PreferencesForm.tsx"));
    expect(reached).toContain(join(SRC, "lib/sourceCoverage.ts"));
  });

  it("never load the topic feed table", () => {
    expect([...reached].map((file) => relative(SRC, file))).not.toContain("config/feeds.ts");
    expect(reached.has(FEEDS_FILE)).toBe(false);
  });

  it("never import the country feed table, or the whole countries module", () => {
    expect(countriesImports.length).toBeGreaterThan(0);
    for (const { from, names } of countriesImports) {
      expect(names, from).not.toContain("COUNTRY_FEEDS");
      expect(names, from).not.toContain("*");
    }
  });
});
